import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';
import { bearerFrom, principalKey, requireAuth, verifyPrincipal } from '../auth.js';
import { can, requireTournament, roleInTournament } from '../authz.js';
import { clipDto } from '../replay.js';

const uuid = z.string().uuid();

export function registerMediaRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, hub, media } = ctx;
  const any = requireAuth(config);

  /** One-tap highlight: the last N seconds of a camera, rendered as 16:9 and 9:16 MP4. */
  app.post('/api/tournaments/:id/clips', { preHandler: any }, async (req, reply) => {
    const { t } = await requireTournament(repo, req.principal!, uuid.parse((req.params as { id: string }).id), 'direct');
    const body = z
      .object({
        cameraId: uuid,
        secondsBack: z.number().int().min(5).max(300).default(30),
        durationSec: z.number().int().min(3).max(120).default(30),
        title: z.string().trim().max(60).nullish(),
      })
      .parse(req.body);
    const cam = await repo.cameraById(body.cameraId);
    if (!cam || cam.tournament_id !== t.id) throw new HttpError(404, 'camera_not_found', 'Camera not found in this tournament.');
    const clip = await media.createClip({
      tournamentId: t.id,
      cameraId: cam.id,
      cameraName: cam.name,
      hole: cam.hole,
      streamPath: cam.stream_path,
      secondsBack: body.secondsBack,
      durationSec: body.durationSec,
      title: body.title ?? null,
      createdBy: principalKey(req.principal!),
      subtitle: [t.name, cam.hole ? `Hole ${cam.hole}` : null].filter(Boolean).join(' · '),
    });
    hub.clipChanged(clip);
    reply.status(202);
    return { clip: clipDto(clip) };
  });

  app.get('/api/tournaments/:id/clips', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, uuid.parse((req.params as { id: string }).id), 'direct');
    return { clips: (await media.listClips(t.id)).map(clipDto) };
  });

  const loadClip = async (id: string) => {
    const clip = await media.clip(uuid.parse(id));
    if (!clip) throw new HttpError(404, 'clip_not_found', 'Clip not found.');
    return clip;
  };

  app.get('/api/clips/:id', { preHandler: any }, async (req) => {
    const clip = await loadClip((req.params as { id: string }).id);
    await requireTournament(repo, req.principal!, clip.tournament_id, 'direct');
    return { clip: clipDto(clip) };
  });

  app.post('/api/clips/:id/share', { preHandler: any }, async (req) => {
    const clip = await loadClip((req.params as { id: string }).id);
    await requireTournament(repo, req.principal!, clip.tournament_id, 'direct');
    if (clip.status !== 'ready') throw new HttpError(409, 'clip_not_ready', 'The clip is still being made.');
    return media.shareLinks(clip.id);
  });

  /** Hide a clip from (or show it on) the public watch page. */
  app.patch('/api/clips/:id', { preHandler: any }, async (req) => {
    const clip = await loadClip((req.params as { id: string }).id);
    await requireTournament(repo, req.principal!, clip.tournament_id, 'direct');
    const body = z.object({ public: z.boolean() }).parse(req.body);
    const updated = (await media.setClipPublic(clip.id, body.public))!;
    hub.clipChanged(updated);
    return { clip: clipDto(updated) };
  });

  app.delete('/api/clips/:id', { preHandler: any }, async (req, reply) => {
    const clip = await loadClip((req.params as { id: string }).id);
    await requireTournament(repo, req.principal!, clip.tournament_id, 'direct');
    await media.deleteClip(clip.id);
    reply.status(204);
    return null;
  });

  /** Clip files: for directors (token) or anyone with a signed share link. Supports Range for video players. */
  app.get('/api/clips/:id/:file', async (req, reply) => {
    const { id, file } = req.params as { id: string; file: string };
    const clip = await loadClip(id);
    const sig = (req.query as { sig?: string }).sig;
    if (!media.verifyShare(clip.id, file, sig)) {
      const token = bearerFrom(req);
      const p = token ? verifyPrincipal(config, token) : null;
      const t = p ? await repo.tournamentById(clip.tournament_id) : null;
      if (!p || !t || !can(await roleInTournament(repo, p, t), 'direct')) {
        throw new HttpError(401, 'unauthorized', 'Sign in or use a share link to download this clip.');
      }
    }
    return sendFile(req.headers.range, reply, media.clipFile(clip.id, file), file.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4', file);
  });

  /** Replay files OBS plays (signed, short-lived). */
  app.get('/media/replays/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const f = media.replayFile(name, (req.query as { sig?: string }).sig);
    return sendFile(req.headers.range, reply, f, 'video/mp4', name);
  });
}

function sendFile(range: string | undefined, reply: import('fastify').FastifyReply, file: string, type: string, name: string) {
  const size = fs.statSync(file).size;
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Disposition', `inline; filename="${name}"`);
  reply.type(type);
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) {
      reply.status(416).header('Content-Range', `bytes */${size}`);
      return reply.send();
    }
    reply.status(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1);
    return reply.send(fs.createReadStream(file, { start, end }));
  }
  reply.header('Content-Length', size);
  return reply.send(fs.createReadStream(file));
}
