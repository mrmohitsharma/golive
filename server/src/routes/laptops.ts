import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { requireAuth, signPrincipal } from '../auth.js';
import { requireTournament } from '../authz.js';
import { HttpError } from '../errors.js';
import { constantTimeEqual } from '../crypto.js';
import type { TournamentRow } from '../repo.js';

/** Download names of the agent apps (GitHub release assets, see .github/workflows/agent-apps.yml). */
export const AGENT_FILES = {
  windows: 'GoLiveAgent-Windows.exe',
  'mac-arm': 'GoLiveAgent-Mac-AppleSilicon.zip',
  'mac-intel': 'GoLiveAgent-Mac-Intel.zip',
} as const;

const PAIR_MINUTES = 10;
/** The agent checks in every 10 s; a laptop not heard from for 30 s is offline. */
const ONLINE_MS = 30_000;

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const sixDigits = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const normCode = (s: string) => s.replace(/\D/g, '');

interface LaptopRow {
  id: string;
  org_id: string;
  name: string;
  os: string | null;
  version: string | null;
  token_hash: string;
  tournament_id: string | null;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

/** Small in-memory throttle (per key, per window). */
function throttle(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) throw new HttpError(429, 'too_many_tries', 'Too many tries. Wait a few minutes and try again.');
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  };
}

/**
 * Laptop OBS without a .env: the Go Live agent app shows a 6-digit code, the organiser types it
 * on the event page, and the laptop is paired with the club. From then on the laptop runs
 * whichever event the club picks for it on the event page (one laptop per event).
 */
export function registerLaptopRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, hub } = ctx;
  const db = repo.db;
  const any = requireAuth(config);
  const tid = (req: FastifyRequest) => z.string().uuid().parse((req.params as { id: string }).id);
  const startLimit = throttle(20, 10 * 60_000);
  const guessLimit = throttle(10, 10 * 60_000);
  const server = () => config.PUBLIC_BASE_URL.replace(/\/$/, '');
  const downloads = () => {
    const base = config.AGENT_DOWNLOAD_BASE.replace(/\/$/, '');
    return {
      windows: `${server()}/download/agent/windows`,
      macArm: `${server()}/download/agent/mac-arm`,
      macIntel: `${server()}/download/agent/mac-intel`,
      direct: Object.fromEntries(Object.entries(AGENT_FILES).map(([k, f]) => [k, `${base}/${f}`])),
    };
  };

  const online = (l: LaptopRow) => Boolean(l.last_seen_at && Date.now() - new Date(l.last_seen_at).getTime() < ONLINE_MS);

  /** Everything the event page wizard shows: the club's laptops and how far the setup got. */
  const status = async (t: TournamentRow) => {
    const rows = (
      await db.query<LaptopRow & { event_name: string | null }>(
        `SELECT l.*, t.name AS event_name FROM agent_laptops l LEFT JOIN tournaments t ON t.id = l.tournament_id
          WHERE l.org_id = $1 AND l.revoked_at IS NULL ORDER BY l.created_at`,
        [t.org_id],
      )
    ).rows;
    const engine = hub.engineState(t.id);
    const cams = await repo.camerasForTournament(t.id);
    const live = cams.filter((c) => hub.healthFor(c.stream_path).online).length;
    const mine = rows.find((l) => l.tournament_id === t.id) ?? null;
    return {
      mode: t.production_mode,
      laptops: rows.map((l) => ({
        id: l.id,
        name: l.name,
        os: l.os,
        version: l.version,
        online: online(l),
        lastSeenAt: l.last_seen_at ? new Date(l.last_seen_at).toISOString() : null,
        event: l.tournament_id ? { id: l.tournament_id, name: l.event_name, thisEvent: l.tournament_id === t.id } : null,
      })),
      laptopId: mine?.id ?? null,
      engine: {
        connected: engine.connected,
        obsConnected: engine.obsConnected,
        obsVersion: engine.obsVersion ?? null,
        warnings: engine.warnings,
        lastError: engine.lastError ?? null,
        streaming: engine.streaming.active,
      },
      cameras: { total: cams.length, sending: live },
      downloads: downloads(),
    };
  };

  /** Puts a laptop on this event: frees the event's previous laptop and the laptop's previous event. */
  const assign = async (t: TournamentRow, l: LaptopRow) => {
    if (l.tournament_id && l.tournament_id !== t.id && hub.engineState(l.tournament_id).streaming.active) {
      throw new HttpError(409, 'laptop_busy', `"${l.name}" is live on another event right now. End that show first.`);
    }
    const old = l.tournament_id;
    await db.query(`UPDATE agent_laptops SET tournament_id = NULL WHERE tournament_id = $1 AND id <> $2`, [t.id, l.id]);
    await db.query(`UPDATE agent_laptops SET tournament_id = $2 WHERE id = $1`, [l.id, t.id]);
    if (old && old !== t.id) hub.dropEngine(old, `This laptop now runs another event.`);
    hub.dropEngine(t.id, `Another laptop now runs this event.`);
  };

  const laptopOf = async (t: TournamentRow, req: FastifyRequest) => {
    const lid = z.string().uuid().parse((req.params as { lid: string }).lid);
    const l = (await db.query<LaptopRow>(`SELECT * FROM agent_laptops WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL`, [lid, t.org_id])).rows[0];
    if (!l) throw new HttpError(404, 'laptop_not_found', 'That laptop is not paired with your club.');
    return l;
  };

  // ---------------------------------------------------------------- event page (signed in)
  app.get('/api/tournaments/:id/laptops', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'direct');
    return status(t);
  });

  /** Pairs a new laptop with the code its agent shows, and puts it on this event. */
  app.post('/api/tournaments/:id/laptops/pair', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'direct');
    guessLimit(`${req.principal!.id}`);
    const code = normCode(z.object({ code: z.string().max(20) }).parse(req.body).code);
    if (code.length !== 6) throw new HttpError(400, 'bad_code', 'Type the 6 digits shown in the Go Live agent on your laptop.');
    const p = (
      await db.query<{ id: string; name: string | null; os: string | null; version: string | null }>(
        `SELECT id, name, os, version FROM agent_pairings WHERE code = $1 AND laptop_id IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
        [code],
      )
    ).rows[0];
    if (!p) throw new HttpError(404, 'code_not_found', 'That code is wrong or has expired. Check the agent window on your laptop: it shows a new code every 10 minutes.');
    const token = crypto.randomBytes(32).toString('hex');
    const by = req.principal!.kind === 'user' ? req.principal!.email : req.principal!.name;
    const l = (
      await db.query<LaptopRow>(
        `INSERT INTO agent_laptops (org_id, name, os, version, token_hash, paired_by, last_seen_at) VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING *`,
        [t.org_id, (p.name || 'Laptop').slice(0, 60), p.os, p.version, sha(token), by],
      )
    ).rows[0];
    await db.query(`UPDATE agent_pairings SET laptop_id = $2, laptop_token = $3 WHERE id = $1`, [p.id, l.id, token]);
    await assign(t, l);
    return status((await repo.tournamentById(t.id))!);
  });

  app.post('/api/tournaments/:id/laptops/:lid/use', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'direct');
    await assign(t, await laptopOf(t, req));
    return status(t);
  });

  app.post('/api/tournaments/:id/laptops/:lid/release', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'direct');
    const l = await laptopOf(t, req);
    if (l.tournament_id === t.id) {
      if (hub.engineState(t.id).streaming.active) throw new HttpError(409, 'stream_live', 'End the show before taking the laptop off this event.');
      await db.query(`UPDATE agent_laptops SET tournament_id = NULL WHERE id = $1`, [l.id]);
      hub.dropEngine(t.id, 'The laptop was taken off this event.');
    }
    return status(t);
  });

  /** Forgets a laptop (lost, sold, or paired by mistake): its agent has to be paired again. */
  app.delete('/api/tournaments/:id/laptops/:lid', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    const l = await laptopOf(t, req);
    if (l.tournament_id && hub.engineState(l.tournament_id).streaming.active) throw new HttpError(409, 'stream_live', 'That laptop is live. End the show first.');
    await db.query(`UPDATE agent_laptops SET revoked_at = now(), tournament_id = NULL WHERE id = $1`, [l.id]);
    if (l.tournament_id) hub.dropEngine(l.tournament_id, 'This laptop was removed from the club.');
    return status(t);
  });

  // ---------------------------------------------------------------- the agent app (no sign-in)
  /** A laptop that is not paired yet asks for a code to show. */
  app.post('/api/agent/pair', async (req) => {
    startLimit(req.ip);
    const b = z
      .object({ name: z.string().max(80).optional(), os: z.string().max(40).optional(), version: z.string().max(20).optional() })
      .parse(req.body ?? {});
    await db.query(`DELETE FROM agent_pairings WHERE expires_at < now() - interval '1 hour'`);
    let code = sixDigits();
    for (let i = 0; i < 10; i++) {
      const clash = (await db.query(`SELECT 1 FROM agent_pairings WHERE code = $1 AND expires_at > now() AND laptop_id IS NULL`, [code])).rowCount;
      if (!clash) break;
      code = sixDigits();
    }
    const secret = crypto.randomBytes(24).toString('hex');
    const r = (
      await db.query<{ id: string; expires_at: Date }>(
        `INSERT INTO agent_pairings (code, secret_hash, name, os, version, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '${PAIR_MINUTES} minutes') RETURNING id, expires_at`,
        [code, sha(secret), b.name?.trim() || null, b.os ?? null, b.version ?? null],
      )
    ).rows[0];
    return { pairId: r.id, code, secret, expiresAt: new Date(r.expires_at).toISOString(), pairUrl: `${server()}/web/pair?code=${code}` };
  });

  /** The agent waits here until the organiser types the code; then gets its laptop key once. */
  app.get('/api/agent/pair/:pid', async (req) => {
    const pid = z.string().uuid().parse((req.params as { pid: string }).pid);
    const secret = String(req.headers['x-pair-secret'] ?? '');
    const p = (await db.query<{ secret_hash: string; laptop_id: string | null; laptop_token: string | null; expires_at: Date }>(`SELECT * FROM agent_pairings WHERE id = $1`, [pid])).rows[0];
    if (!p || !constantTimeEqual(sha(secret), p.secret_hash)) throw new HttpError(404, 'pairing_not_found', 'Pairing not found.');
    if (p.laptop_id && p.laptop_token) {
      await db.query(`UPDATE agent_pairings SET laptop_token = NULL WHERE id = $1`, [pid]);
      return { status: 'paired', laptopId: p.laptop_id, laptopToken: p.laptop_token };
    }
    if (new Date(p.expires_at).getTime() < Date.now()) return { status: 'expired' };
    return { status: 'waiting' };
  });

  /** A paired laptop checks in (every 10 s): which event it runs now, and a token for it. */
  app.post('/api/agent/session', async (req) => {
    const b = z.object({ laptopId: z.string().uuid(), laptopToken: z.string().min(32).max(128), version: z.string().max(20).optional(), os: z.string().max(40).optional() }).parse(req.body);
    const l = (await db.query<LaptopRow>(`SELECT * FROM agent_laptops WHERE id = $1`, [b.laptopId])).rows[0];
    if (!l || !constantTimeEqual(sha(b.laptopToken), l.token_hash)) throw new HttpError(401, 'laptop_unknown', 'This laptop is not paired. Pair it again.');
    if (l.revoked_at) throw new HttpError(401, 'laptop_removed', 'This laptop was removed from your club. Pair it again.');
    await db.query(`UPDATE agent_laptops SET last_seen_at = now(), version = COALESCE($2, version), os = COALESCE($3, os) WHERE id = $1`, [l.id, b.version ?? null, b.os ?? null]);
    const org = (await db.query<{ name: string }>(`SELECT name FROM orgs WHERE id = $1`, [l.org_id])).rows[0];
    const t = l.tournament_id ? await repo.tournamentById(l.tournament_id) : null;
    const usable = t && !t.archived ? t : null;
    return {
      laptop: { id: l.id, name: l.name },
      club: org?.name ?? null,
      event: usable ? { id: usable.id, name: usable.name, mode: usable.production_mode } : null,
      engineToken: usable ? signPrincipal(config, { kind: 'engine', id: `laptop-${l.id.slice(0, 8)}`, name: l.name, tournamentId: usable.id }) : null,
      eventsUrl: `${server()}/web`,
    };
  });

  // ---------------------------------------------------------------- downloads
  app.get('/download/agent/:os', async (req, reply) => {
    const os = (req.params as { os: string }).os as keyof typeof AGENT_FILES;
    const file = AGENT_FILES[os];
    if (!file) throw new HttpError(404, 'not_found', 'Pick windows, mac-arm or mac-intel.');
    reply.header('Cache-Control', 'no-store');
    return reply.redirect(`${config.AGENT_DOWNLOAD_BASE.replace(/\/$/, '')}/${file}`);
  });
}
