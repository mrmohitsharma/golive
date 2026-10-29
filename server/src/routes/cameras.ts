import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';
import { principalKey, requireAuth } from '../auth.js';
import { can, requireTournament, roleInTournament } from '../authz.js';
import { publishUrl, whipUrl, whepUrl } from '../media.js';
import { CameraLimitError, type CameraRow } from '../repo.js';

const uuid = z.string().uuid();
const holeSchema = z.number().int().min(1).max(36).nullable();

export function registerCameraRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, hub, thumbs } = ctx;
  const any = requireAuth(config);

  /**
   * Upload test for camera setup (P1-10): the phone posts a few hundred KB to a few MB and times
   * it, then picks the quality preset. Only signed-in callers; the body is read and dropped.
   */
  app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    scope.post('/api/speedtest/upload', { preHandler: any, bodyLimit: 8 * 1024 * 1024 }, async (req) => {
      const bytes = Buffer.isBuffer(req.body) ? req.body.length : 0;
      return { bytes };
    });
  });

  app.post('/api/tournaments/:id/cameras/register', { preHandler: any }, async (req, reply) => {
    const { t } = await requireTournament(repo, req.principal!, uuid.parse((req.params as { id: string }).id), 'camera');
    if (t.archived) throw new HttpError(404, 'tournament_not_found', 'Tournament not found or archived.');
    const body = z
      .object({
        // Optional: without a name the server names it "Cam 1", "Cam 2"… (one-tap setup).
        name: z.string().trim().max(40).optional().transform((v) => v || null),
        hole: holeSchema.optional().default(null),
        position: z.string().trim().max(60).nullish(),
        deviceId: z.string().min(8).max(128),
        platform: z.enum(['android', 'ios', 'other']),
        deviceModel: z.string().max(80).nullish(),
      })
      .parse(req.body);
    const limit = await ctx.billing.cameraLimit(t);
    const { camera, created } = await repo
      .registerCamera({
        tournamentId: t.id,
        owner: principalKey(req.principal!),
        name: body.name ?? null,
        hole: body.hole ?? null,
        position: body.position ?? null,
        deviceId: body.deviceId,
        platform: body.platform,
        deviceModel: body.deviceModel ?? null,
        limit,
      })
      .catch((err) => {
        if (err instanceof CameraLimitError) {
          throw new HttpError(
            402,
            'camera_limit',
            `This tournament has ${err.limit} camera slot${err.limit === 1 ? '' : 's'} and all are in use. Ask the organiser to buy an extra camera, or remove a camera that is not needed.`,
          );
        }
        throw err;
      });
    await hub.camerasChanged(t.id);
    if (created) await repo.markOnboarding(t.id, 'camera');
    reply.status(created ? 201 : 200);
    return {
      camera: hub.cameraDto(camera),
      publish: { srtUrl: publishUrl(config, camera.stream_path, camera.publish_key), latencyMs: config.SRT_LATENCY_MS },
    };
  });

  /** Loads a camera and the caller's rights on it: the phone that registered it, or a manager. */
  const access = async (req: FastifyRequest): Promise<{ cam: CameraRow; owns: boolean; manage: boolean; watch: boolean }> => {
    const cam = await repo.cameraById(uuid.parse((req.params as { id: string }).id));
    if (!cam) throw new HttpError(404, 'camera_not_found', 'Camera not found.');
    const t = (await repo.tournamentById(cam.tournament_id))!;
    const role = await roleInTournament(repo, req.principal!, t);
    const owns = cam.owner === principalKey(req.principal!);
    if (!role && !owns) throw new HttpError(404, 'camera_not_found', 'Camera not found.');
    return { cam, owns, manage: can(role, 'manage'), watch: can(role, 'watch') };
  };

  app.get('/api/cameras/:id', { preHandler: any }, async (req) => {
    const a = await access(req);
    if (!a.owns && !a.watch) throw new HttpError(403, 'forbidden', 'Not your camera.');
    return { camera: hub.cameraDto(a.cam) };
  });

  app.get('/api/cameras/:id/publish', { preHandler: any }, async (req) => {
    const a = await access(req);
    // Only the phone that owns the camera gets its publish key (not even directors).
    if (!a.owns) throw new HttpError(403, 'forbidden', 'Not your camera.');
    return { srtUrl: publishUrl(config, a.cam.stream_path, a.cam.publish_key), latencyMs: config.SRT_LATENCY_MS };
  });

  app.patch('/api/cameras/:id', { preHandler: any }, async (req) => {
    const a = await access(req);
    if (!a.owns && !a.manage) throw new HttpError(403, 'forbidden', 'Not your camera.');
    const body = z
      .object({
        name: z.string().trim().min(1).max(40).optional(),
        hole: holeSchema.optional(),
        position: z.string().trim().max(60).nullable().optional(),
        sortOrder: z.number().int().min(0).max(10000).optional(),
      })
      .parse(req.body);
    const updated = await repo.updateCamera(a.cam.id, body);
    await hub.camerasChanged(a.cam.tournament_id);
    return { camera: hub.cameraDto(updated!) };
  });

  app.post('/api/cameras/:id/rotate-key', { preHandler: any }, async (req) => {
    const a = await access(req);
    if (!a.manage) throw new HttpError(403, 'forbidden', 'Only directors can rotate camera keys.');
    return { camera: hub.cameraDto((await repo.rotatePublishKey(a.cam.id))!) };
  });

  app.delete('/api/cameras/:id', { preHandler: any }, async (req, reply) => {
    const a = await access(req);
    if (!a.manage) throw new HttpError(403, 'forbidden', 'Only directors can remove cameras.');
    await repo.deleteCamera(a.cam.id);
    await hub.camerasChanged(a.cam.tournament_id);
    reply.status(204);
    return null;
  });

  app.get('/api/cameras/:id/thumbnail.jpg', { preHandler: any }, async (req, reply) => {
    const a = await access(req);
    if (!a.watch) throw new HttpError(403, 'forbidden', 'Your role cannot watch previews.');
    const file = thumbs.fileFor(a.cam.stream_path);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new HttpError(404, 'no_thumbnail', 'No picture from this camera yet.');
    }
    const etag = `"${stat.mtimeMs.toFixed(0)}-${stat.size}"`;
    reply.header('Cache-Control', 'no-store');
    reply.header('ETag', etag);
    reply.header('X-Thumbnail-Age-Ms', String(Math.max(0, Date.now() - stat.mtimeMs)));
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    reply.type('image/jpeg');
    return reply.send(fs.readFileSync(file));
  });

  // ---------------------------------------------------------------- commentators
  /**
   * A commentator's phone/tablet registers and gets a WHIP (WebRTC) URL to send its
   * microphone, plus WHEP previews of the programme camera to talk over.
   */
  app.post('/api/tournaments/:id/commentators/register', { preHandler: any }, async (req, reply) => {
    const { t } = await requireTournament(repo, req.principal!, uuid.parse((req.params as { id: string }).id), 'commentate');
    const body = z.object({ name: z.string().trim().min(1).max(40), deviceId: z.string().min(8).max(128) }).parse(req.body);
    const m = await repo.registerCommentator({ tournamentId: t.id, owner: principalKey(req.principal!), name: body.name, deviceId: body.deviceId });
    await hub.camerasChanged(t.id);
    reply.status(201);
    return {
      commentator: hub.commentatorDto(m),
      publish: {
        whipUrl: whipUrl(config, m.stream_path),
        // WHIP: "Authorization: Bearer <user>:<pass>" → MediaMTX passes user/pass to the auth hook.
        bearer: `com:${m.publish_key}`,
      },
      previewBase: whepUrl(config, '').replace(/\/whep$/, ''),
    };
  });

  app.delete('/api/commentators/:id', { preHandler: any }, async (req, reply) => {
    const m = await repo.commentatorById(uuid.parse((req.params as { id: string }).id));
    if (!m) throw new HttpError(404, 'not_found', 'Commentator not found.');
    const t = (await repo.tournamentById(m.tournament_id))!;
    const role = await roleInTournament(repo, req.principal!, t);
    if (m.owner !== principalKey(req.principal!) && !can(role, 'manage')) throw new HttpError(403, 'forbidden', 'Not allowed.');
    await repo.deleteCommentator(m.id);
    await hub.camerasChanged(t.id);
    reply.status(204);
    return null;
  });
}
