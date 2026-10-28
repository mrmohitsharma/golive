import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { YOUTUBE_RTMPS_INGEST, youtubeVideoId } from '../youtube.js';
import { EVENT_TYPE_IDS, EVENT_TYPES, eventProfile, initialGraphics } from '../event-types.js';
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
    eventType: t.event_type ?? 'golf',
    profile: eventProfile(t.event_type),
    publicWatch: t.public_watch !== false,
    chatEnabled: t.chat_enabled !== false,
    chatSlowSec: t.chat_slow_sec ?? 3,
  };
}

export function registerTournamentRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, hub, youtube, cloud, outputs, sealer } = ctx;
  const any = requireAuth(config);
  const user = requireAuth(config, 'user');

  /** The kinds of event and what each changes (labels, default graphics). */
  app.get('/api/event-types', async () => ({ eventTypes: EVENT_TYPE_IDS.map((id) => EVENT_TYPES[id]) }));

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
        eventType: z.enum(EVENT_TYPE_IDS).optional(),
      })
      .parse(req.body);
    if (body.mode === 'cloud' && !cloud.available) throw new HttpError(409, 'cloud_unavailable', 'Cloud production is not enabled on this server.');
    // Cloud is the default when this server can run cloud engines: no laptop needed (onboarding P1-4).
    const mode = body.mode ?? (cloud.available ? 'cloud' : 'laptop');
    const eventType = body.eventType ?? 'golf';
    let t = await repo.createTournament({ orgId, name: body.name, venue: body.venue, startsOn: body.startsOn, mode, eventType, graphics: initialGraphics(eventType) });
    // No YouTube of their own yet: start on the Go Live channel so the first show needs no setup (P1-6).
    if (youtube.enabled && !(await repo.orgYoutube(orgId)) && (await youtube.goliveAvailable())) {
      await repo.db.query("UPDATE tournaments SET yt_source = 'golive' WHERE id = $1", [t.id]);
      t = (await repo.tournamentById(t.id))!;
    }
    // One camera, scorer and commentator code per event, made now, so nobody has to tap "New code" (P1-8).
    await ensureInviteCodes(t.id, userOf(req).id);
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
        eventType: z.enum(EVENT_TYPE_IDS).optional(),
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

  /** The event's standing invite codes (valid until revoked), one per role; made if missing. */
  const INVITE_LABELS: Record<(typeof GUEST_ROLES)[number], string> = { camera: 'Cameras', scorer: 'Scorers', commentator: 'Commentators' };
  const ensureInviteCodes = async (tid: string, by: string | null) => {
    const live = (await repo.joinCodes(tid)).filter((c) => !c.revoked && !c.expires_at);
    const out: Partial<Record<(typeof GUEST_ROLES)[number], Awaited<ReturnType<typeof repo.joinCodes>>[number]>> = {};
    for (const role of GUEST_ROLES) {
      out[role] = live.find((c) => c.role === role && c.label === INVITE_LABELS[role]) ?? (await repo.createJoinCode(tid, role, INVITE_LABELS[role], by, null));
    }
    return out as Required<typeof out>;
  };

  /**
   * What the event screen shows at the top: the camera QR and share links for each role.
   * `whatsapp` opens WhatsApp with the invite text and the /join link.
   */
  app.get('/api/tournaments/:id/invites', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'direct');
    const codes = await ensureInviteCodes(t.id, req.principal!.kind === 'user' ? req.principal!.id : null);
    const what = { camera: 'be a camera', scorer: 'keep score', commentator: 'commentate' } as const;
    const invites = GUEST_ROLES.map((role) => {
      const dto = codeDto(codes[role], t.id);
      const text = `Join ${t.name} on ${config.BRAND_NAME} to ${what[role]}: ${dto.joinUrl}`;
      return { ...dto, shareText: text, whatsapp: `https://wa.me/?text=${encodeURIComponent(text)}` };
    });
    return { invites };
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
    if (t.yt_source === 'key') throw new HttpError(409, 'youtube_key_mode', 'This event uses a pasted stream key: YouTube Studio makes the broadcast.');
    // On the Go Live channel the title names the organiser, and broadcasts are unlisted unless asked otherwise.
    const org = t.yt_source === 'golive' ? await repo.orgById(t.org_id) : null;
    const r = await youtube.createBroadcast(t, {
      title: body.title ?? (org ? `${t.name} by ${org.name}` : `${t.name}${t.venue ? ` · ${t.venue}` : ''}`),
      privacy: body.privacy,
      description: body.description ?? `Live from ${t.venue ?? t.name}${org ? `, by ${org.name}` : ''}. Produced with ${config.BRAND_NAME}.`,
    });
    await hub.engineConfigChanged(t.id);
    const fresh = (await repo.tournamentById(t.id))!;
    reply.status(201);
    return { broadcast: r, youtube: await hub.youtubeState(fresh) };
  });

  /**
   * Where the main YouTube stream goes: "org" (the organisation's channel) or "golive" (the
   * platform's Go Live channel, nothing to connect). Changing it drops the current broadcast,
   * which belongs to the other channel. A pasted key is set with PUT /youtube/key.
   */
  app.put('/api/tournaments/:id/youtube/source', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'direct');
    const body = z.object({ source: z.enum(['org', 'golive']) }).parse(req.body);
    if (body.source === t.yt_source) return { youtube: await hub.youtubeState(t) };
    if (hub.engineState(t.id).streaming.active) throw new HttpError(409, 'stream_live', 'End the stream before changing where it goes.');
    if (body.source === 'golive' && !(await youtube.goliveAvailable())) {
      throw new HttpError(409, 'golive_channel_off', 'The Go Live channel is not available right now. Connect your own YouTube channel or paste a stream key.');
    }
    await youtube.forgetBroadcast(t);
    await repo.db.query('UPDATE tournaments SET yt_source = $2 WHERE id = $1', [t.id, body.source]);
    await hub.engineConfigChanged(t.id);
    await hub.outputsUpdated(t.id);
    return { youtube: await hub.youtubeState((await repo.tournamentById(t.id))!) };
  });

  /**
   * Stream to YouTube with a key pasted from YouTube Studio (Go live > Stream > Stream key),
   * no Google sign-in (P1-7). The video link is optional: with it, the watch page plays the video.
   */
  app.put('/api/tournaments/:id/youtube/key', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'direct');
    const body = z
      .object({
        streamKey: z.string().trim().min(8).max(200).optional(),
        streamUrl: z.string().trim().max(300).optional(),
        videoUrl: z.string().trim().max(500).nullable().optional(),
      })
      .parse(req.body);
    if (!body.streamKey && t.yt_source !== 'key') throw new HttpError(400, 'stream_key_required', 'Paste the stream key from YouTube Studio.');
    if (body.streamKey && hub.engineState(t.id).streaming.active) throw new HttpError(409, 'stream_live', 'End the stream before changing the stream key.');
    if (body.streamKey && /\s/.test(body.streamKey)) throw new HttpError(400, 'bad_stream_key', 'The stream key has spaces in it. Copy it again from YouTube Studio.');
    const server = body.streamUrl?.trim() || (t.yt_source === 'key' && t.yt_ingest_url) || YOUTUBE_RTMPS_INGEST;
    if (!/^rtmps?:\/\/[^\s/]+/i.test(server)) throw new HttpError(400, 'bad_stream_url', 'The stream URL must start with rtmp:// or rtmps://.');
    let videoId = t.yt_source === 'key' ? t.yt_broadcast_id : null;
    if (body.videoUrl !== undefined) {
      videoId = body.videoUrl ? youtubeVideoId(body.videoUrl) : null;
      if (body.videoUrl && !videoId) throw new HttpError(400, 'bad_video_url', 'That is not a YouTube video link. Copy the link from YouTube Studio (Share).');
    }
    if (body.streamKey && t.yt_source !== 'key') await youtube.forgetBroadcast(t);
    await repo.setYoutubeBroadcast(t.id, {
      broadcastId: videoId,
      streamId: null,
      streamKeyEnc: body.streamKey ? sealer.seal(body.streamKey) : t.yt_stream_key_enc,
      ingestUrl: server.replace(/\/+$/, ''),
      privacy: null,
    });
    await repo.db.query("UPDATE tournaments SET yt_source = 'key' WHERE id = $1", [t.id]);
    await hub.engineConfigChanged(t.id);
    await hub.outputsUpdated(t.id);
    return { youtube: await hub.youtubeState((await repo.tournamentById(t.id))!) };
  });

  /** Stops using the pasted key: back to the organisation's channel (or the Go Live channel). */
  app.delete('/api/tournaments/:id/youtube/key', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'direct');
    if (hub.engineState(t.id).streaming.active) throw new HttpError(409, 'stream_live', 'End the stream first.');
    if (t.yt_source === 'key') {
      await youtube.forgetBroadcast(t);
      const next = !(await repo.orgYoutube(t.org_id)) && (await youtube.goliveAvailable()) ? 'golive' : 'org';
      await repo.db.query('UPDATE tournaments SET yt_source = $2 WHERE id = $1', [t.id, next]);
      await hub.engineConfigChanged(t.id);
      await hub.outputsUpdated(t.id);
    }
    return { youtube: await hub.youtubeState((await repo.tournamentById(t.id))!) };
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
