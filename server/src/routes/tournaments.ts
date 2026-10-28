import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';
import { GUEST_ROLES, requireAuth, userOf } from '../auth.js';
import { requireOrg, requireTournament, roleInTournament } from '../authz.js';
import type { TournamentRow } from '../repo.js';
import { mergeAudio } from '../hub.js';
import type { AudioState } from '../protocol.js';
import { normaliseJoinCode } from '../crypto.js';

const uuid = z.string().uuid();
const idParam = (req: { params: unknown }) => uuid.parse((req.params as { id: string }).id);

export function tournamentDto(t: TournamentRow) {
  return {
    id: t.id,
    orgId: t.org_id,
    name: t.name,
    venue: t.venue,
    startsOn: t.starts_on,
    mode: t.production_mode,
    autoFallback: t.auto_fallback,
    archived: t.archived,
    hasYoutubeBroadcast: Boolean(t.yt_broadcast_id),
    publicWatch: t.public_watch !== false,
    chatEnabled: t.chat_enabled !== false,
    chatSlowSec: t.chat_slow_sec ?? 3,
  };
}

export function registerTournamentRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, hub, youtube, cloud, outputs } = ctx;
  const any = requireAuth(config);
  const user = requireAuth(config, 'user');

  app.get('/api/tournaments', { preHandler: any }, async (req) => {
    const p = req.principal!;
    if (p.kind === 'user') {
      const orgs = await repo.memberships(p.id);
      const roleByOrg = new Map(orgs.map((o) => [o.org_id, o.role]));
      const list = await repo.tournamentsForOrgs(orgs.map((o) => o.org_id));
      return {
        tournaments: list.map((t) => ({ ...tournamentDto(t), orgName: orgs.find((o) => o.org_id === t.org_id)?.org_name, role: roleByOrg.get(t.org_id) })),
      };
    }
    const t = await repo.tournamentById(p.tournamentId);
    return { tournaments: t && !t.archived ? [{ ...tournamentDto(t), role: p.kind === 'guest' ? p.role : 'engine' }] : [] };
  });

  app.post('/api/orgs/:id/tournaments', { preHandler: user }, async (req, reply) => {
    const orgId = idParam(req);
    await requireOrg(repo, req.principal!, orgId, 'create');
    const body = z
      .object({
        name: z.string().trim().min(1).max(120),
        venue: z.string().trim().max(120).nullish(),
        startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        mode: z.enum(['laptop', 'cloud']).optional(),
      })
      .parse(req.body);
    if (body.mode === 'cloud' && !cloud.available) throw new HttpError(409, 'cloud_unavailable', 'Cloud production is not enabled on this server.');
    // Cloud is the default when this server can run cloud engines: no laptop needed (onboarding P1-4).
    const mode = body.mode ?? (cloud.available ? 'cloud' : 'laptop');
    const t = await repo.createTournament({ orgId, name: body.name, venue: body.venue, startsOn: body.startsOn, mode });
    reply.status(201);
    return { tournament: tournamentDto(t) };
  });

  app.patch('/api/tournaments/:id', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'manage');
    const body = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        venue: z.string().trim().max(120).nullable().optional(),
        autoFallback: z.boolean().optional(),
        archived: z.boolean().optional(),
        mode: z.enum(['laptop', 'cloud']).optional(),
        publicWatch: z.boolean().optional(),
        chatEnabled: z.boolean().optional(),
        chatSlowSec: z.number().int().min(0).max(300).optional(),
      })
      .parse(req.body);
    if (body.mode && body.mode !== t.production_mode) {
      const cs = cloud.state(t).cloud.status;
      if (cs === 'running' || cs === 'starting') throw new HttpError(409, 'engine_running', 'Stop the cloud engine before changing production mode.');
      if (hub.engineState(t.id).streaming.active) throw new HttpError(409, 'stream_live', 'End the YouTube stream before changing production mode.');
      if (body.mode === 'cloud' && !cloud.available) throw new HttpError(409, 'cloud_unavailable', 'Cloud production is not enabled on this server.');
    }
    const updated = (await repo.updateTournament(t.id, body))!;
    if (body.chatEnabled !== undefined || body.chatSlowSec !== undefined) ctx.chat.settingsChanged(updated);
    await hub.camerasChanged(t.id);
    if (body.mode) await hub.outputsUpdated(t.id);
    if (body.mode) hub.productionChanged(t.id, cloud.state(updated));
    return { tournament: tournamentDto(updated) };
  });

  app.get('/api/tournaments/:id/state', { preHandler: any }, async (req) => {
    const { t, role } = await requireTournament(repo, req.principal!, idParam(req), 'view');
    return hub.snapshot(t, role);
  });

  app.get('/api/tournaments/:id/switch-log', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'direct');
    return { entries: await repo.recentSwitches(t.id) };
  });

  // ---------------------------------------------------------------- join codes (QR posters)
  const joinUrl = (code: string) => `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/join/${code}`;
  const codeDto = (c: { code: string; role: string; label: string | null; uses: number; expires_at: Date | null; created_at: Date }, tid: string) => ({
    code: c.code,
    role: c.role,
    label: c.label,
    uses: c.uses,
    expiresAt: c.expires_at,
    createdAt: c.created_at,
    joinUrl: joinUrl(c.code),
    qrUrl: `/api/tournaments/${tid}/join-codes/${c.code}/qr.png`,
  });

  app.get('/api/tournaments/:id/join-codes', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'manage');
    return { codes: (await repo.joinCodes(t.id)).map((c) => codeDto(c, t.id)) };
  });

  app.post('/api/tournaments/:id/join-codes', { preHandler: user }, async (req, reply) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'manage');
    const body = z
      .object({
        role: z.enum(GUEST_ROLES),
        label: z.string().trim().max(60).nullish(),
        expiresInHours: z.number().int().min(1).max(24 * 30).optional(),
      })
      .parse(req.body);
    const expires = body.expiresInHours ? new Date(Date.now() + body.expiresInHours * 3600_000) : null;
    const c = await repo.createJoinCode(t.id, body.role, body.label ?? null, userOf(req).id, expires);
    reply.status(201);
    return { code: codeDto(c, t.id) };
  });

  app.delete('/api/tournaments/:id/join-codes/:code', { preHandler: user }, async (req, reply) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'manage');
    const ok = await repo.revokeJoinCode(t.id, normaliseJoinCode((req.params as { code: string }).code));
    if (!ok) throw new HttpError(404, 'not_found', 'Code not found.');
    reply.status(204);
    return null;
  });

  app.get('/api/tournaments/:id/join-codes/:code/qr.png', { preHandler: user }, async (req, reply) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'manage');
    const code = normaliseJoinCode((req.params as { code: string }).code);
    const jc = await repo.joinCode(code);
    if (!jc || jc.tournament_id !== t.id || jc.revoked) throw new HttpError(404, 'not_found', 'Code not found.');
    const png = await QRCode.toBuffer(joinUrl(code), { type: 'png', width: 720, margin: 2, errorCorrectionLevel: 'M' });
    reply.type('image/png');
    reply.header('Cache-Control', 'private, max-age=300');
    return reply.send(png);
  });

  // ---------------------------------------------------------------- engine setup (laptop mode)
  app.get('/api/tournaments/:id/engine-setup', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'manage');
    const server = config.PUBLIC_BASE_URL.replace(/\/$/, '');
    return {
      tournamentId: t.id,
      engineKey: t.engine_key,
      serverUrl: server,
      envFile: `SERVER_URL=${server}\nTOURNAMENT_ID=${t.id}\nENGINE_KEY=${t.engine_key}\nOBS_URL=ws://127.0.0.1:4455\nOBS_PASSWORD=\n`,
    };
  });

  app.post('/api/tournaments/:id/engine-key/rotate', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'manage');
    return { engineKey: await repo.rotateEngineKey(t.id) };
  });

  // ---------------------------------------------------------------- YouTube broadcast
  app.post('/api/tournaments/:id/youtube/broadcast', { preHandler: user }, async (req, reply) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'direct');
    const body = z
      .object({
        title: z.string().trim().min(1).max(100).optional(),
        privacy: z.enum(['public', 'unlisted', 'private']).default('unlisted'),
        description: z.string().max(5000).optional(),
      })
      .parse(req.body ?? {});
    if (hub.engineState(t.id).streaming.active) throw new HttpError(409, 'stream_live', 'End the current stream before creating a new broadcast.');
    const r = await youtube.createBroadcast(t, {
      title: body.title ?? `${t.name}${t.venue ? ` · ${t.venue}` : ''}`,
      privacy: body.privacy,
      description: body.description ?? `Live from ${t.venue ?? t.name}. Produced with ${config.BRAND_NAME}.`,
    });
    await hub.engineConfigChanged(t.id);
    const fresh = (await repo.tournamentById(t.id))!;
    reply.status(201);
    return { broadcast: r, youtube: await hub.youtubeState(fresh) };
  });

  app.delete('/api/tournaments/:id/youtube/broadcast', { preHandler: user }, async (req, reply) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'direct');
    if (hub.engineState(t.id).streaming.active) throw new HttpError(409, 'stream_live', 'End the stream first.');
    await youtube.forgetBroadcast(t);
    await hub.engineConfigChanged(t.id);
    reply.status(204);
    return null;
  });

  // ---------------------------------------------------------------- multistream (YouTube, Facebook, Instagram)
  app.get('/api/tournaments/:id/outputs', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'direct');
    return { outputs: await outputs.state(t) };
  });

  /**
   * Choose platforms and paste the Instagram key. Instagram: on instagram.com > Create > Live >
   * streaming software, copy "Stream URL" and "Stream key" (the key changes every time).
   */
  app.patch('/api/tournaments/:id/outputs', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'direct');
    const flag = z.object({ enabled: z.boolean().optional() });
    const body = z
      .object({
        youtube: flag.optional(),
        facebook: flag.optional(),
        instagram: z
          .object({
            enabled: z.boolean().optional(),
            streamUrl: z.string().trim().max(500).optional(),
            streamKey: z.string().trim().max(500).optional(),
            clear: z.boolean().optional(),
          })
          .optional(),
      })
      .parse(req.body);
    const updated = await outputs.update(t, body);
    await hub.outputsUpdated(t.id);
    return { outputs: await outputs.state(updated) };
  });

  // ---------------------------------------------------------------- cloud production
  app.post('/api/tournaments/:id/cloud-engine/start', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'direct');
    const allowed = await ctx.billing.checkGoLive(t);
    if (!allowed.ok) throw new HttpError(402, 'billing_blocked', allowed.error);
    return { production: await cloud.startEngine(t) };
  });

  app.post('/api/tournaments/:id/cloud-engine/stop', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'direct');
    if (hub.engineState(t.id).streaming.active) {
      const force = (req.query as { force?: string }).force === 'true';
      if (!force) throw new HttpError(409, 'stream_live', 'The YouTube stream is still live. End it first, or stop with force.');
    }
    return { production: await cloud.stopEngine(t) };
  });

  // ---------------------------------------------------------------- audio
  app.get('/api/tournaments/:id/audio', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'direct');
    return { audio: mergeAudio(t.audio) };
  });

  app.patch('/api/tournaments/:id/audio', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'direct');
    const db = z.number().min(-60).max(6);
    const body = z
      .object({
        courseDb: db.optional(),
        courseMuted: z.boolean().optional(),
        commentaryDb: db.optional(),
        commentaryMuted: z.boolean().optional(),
        ducking: z.boolean().optional(),
        commentaryDelayMs: z.number().int().min(0).max(2000).optional(),
        cameras: z.record(z.string().uuid(), z.object({ db: db.optional(), muted: z.boolean().optional() })).optional(),
      })
      .parse(req.body);
    const cur = mergeAudio(t.audio);
    const next: AudioState = {
      ...cur,
      ...Object.fromEntries(Object.entries(body).filter(([k, v]) => k !== 'cameras' && v !== undefined)),
      cameras: { ...cur.cameras },
    };
    for (const [id, v] of Object.entries(body.cameras ?? {})) {
      const prev = cur.cameras[id] ?? { db: 0, muted: false };
      next.cameras[id] = { db: v.db ?? prev.db, muted: v.muted ?? prev.muted };
    }
    await repo.setTournamentJson(t.id, 'audio', next);
    hub.audioChanged(t.id, next);
    return { audio: next };
  });

  // Who am I in this tournament (apps use it to choose screens).
  app.get('/api/tournaments/:id/role', { preHandler: any }, async (req) => {
    const t = await repo.tournamentById(idParam(req));
    if (!t) throw new HttpError(404, 'tournament_not_found', 'Tournament not found.');
    const role = await roleInTournament(repo, req.principal!, t);
    if (!role) throw new HttpError(404, 'tournament_not_found', 'Tournament not found.');
    return { role };
  });
}
