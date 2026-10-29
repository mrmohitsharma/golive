import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';
import { originList } from '../config.js';
import type { TournamentRow } from '../repo.js';
import type { ClipRow } from '../replay.js';
import { watchUrl } from '../youtube.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = [path.resolve(here, '../../public'), path.resolve(here, '../../../public')].find((p) => fs.existsSync(p));
const CACHE_MS = 5000;

/**
 * Read-only, no-login API and the /watch page, for the CoGolfers website and fans.
 * Video is never served from here: the page embeds YouTube's player (YouTube carries the
 * viewers), and this server only sends small JSON (tournament, leaderboard, clips).
 * Responses are cached for 5 s so thousands of viewers cost a handful of DB queries.
 */
export function registerPublicRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, hub, scoring, media, viewership } = ctx;
  const corsOrigins = originList(config.PUBLIC_CORS_ORIGINS);
  const embedOrigins = originList(config.WATCH_EMBED_ORIGINS);
  const cache = new Map<string, { at: number; body: unknown }>();

  const cached = async <T>(key: string, make: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.body as T;
    const body = await make();
    cache.set(key, { at: Date.now(), body });
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    return body;
  };

  const cors = (req: FastifyRequest, reply: FastifyReply) => {
    const origin = req.headers.origin;
    if (!origin) return;
    if (corsOrigins.includes('*')) reply.header('Access-Control-Allow-Origin', '*');
    else if (corsOrigins.includes(origin.replace(/\/$/, ''))) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
    }
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'content-type, authorization');
    reply.header('Access-Control-Max-Age', '600');
  };

  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/public/')) cors(req, reply);
  });
  app.options('/api/public/*', async (_req, reply) => reply.status(204).send());

  const isLive = (t: TournamentRow) => hub.engineState(t.id).streaming.active;
  const youtubeFor = (t: TournamentRow) =>
    t.yt_broadcast_id && t.yt_privacy !== 'private'
      ? {
          videoId: t.yt_broadcast_id,
          watchUrl: watchUrl(t.yt_broadcast_id),
          embedUrl: `https://www.youtube.com/embed/${t.yt_broadcast_id}?autoplay=1&mute=1&playsinline=1`,
        }
      : null;
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, '');
  const summary = (t: TournamentRow & { org_name?: string }) => ({
    id: t.id,
    name: t.name,
    venue: t.venue,
    orgName: t.org_name ?? null,
    startsOn: t.starts_on,
    eventType: t.event_type ?? 'golf',
    live: isLive(t),
    watchPage: `${base}/watch/${t.id}`,
    youtube: youtubeFor(t),
    facebookUrl: t.fb_permalink,
  });

  const clipPublic = (c: ClipRow) => {
    const links = media.shareLinks(c.id);
    return {
      id: c.id,
      title: c.title || [c.camera_name, c.hole ? `Hole ${c.hole}` : null].filter(Boolean).join(' · '),
      hole: c.hole,
      durationSec: Number(c.duration_sec),
      createdAt: c.created_at,
      thumbUrl: links.thumbUrl,
      landscapeUrl: links.landscapeUrl,
      verticalUrl: links.verticalUrl,
    };
  };

  /** Tournaments to list on a website: live ones first. */
  app.get('/api/public/live', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=5');
    return cached('live', async () => {
      const list = (await repo.publicTournaments()).map(summary);
      list.sort((a, b) => Number(b.live) - Number(a.live));
      return { tournaments: list, serverTime: new Date().toISOString() };
    });
  });

  /** One tournament: player link, live status, leaderboard and shareable highlight clips. */
  app.get('/api/public/tournaments/:id', async (req, reply) => {
    const id = z.string().uuid().safeParse((req.params as { id: string }).id);
    if (!id.success) throw new HttpError(404, 'not_found', 'Tournament not found.');
    reply.header('Cache-Control', 'public, max-age=5');
    return cached(`t:${id.data}`, async () => {
      const t = await repo.tournamentById(id.data);
      if (!t || t.archived || !t.public_watch) throw new HttpError(404, 'not_found', 'Tournament not found.');
      const org = await repo.orgById(t.org_id);
      const { rows, holes } = await scoring.leaderboard(t.id);
      const e = hub.engineState(t.id);
      const onAir = e.programmeCameraId ? await repo.cameraById(e.programmeCameraId) : null;
      return {
        tournament: summary({ ...t, org_name: org?.name }),
        onAir: e.streaming.active && onAir && !e.fallbackActive ? { hole: onAir.hole, replay: e.replayActive } : null,
        holes: holes.length,
        leaderboard: rows
          .filter((r) => r.holesPlayed > 0)
          .slice(0, 50)
          .map((r) => ({ position: r.position, name: r.name, club: r.club, category: r.category, toPar: r.toParText, thru: r.thru })),
        clips: (await media.publicClips(t.id)).map(clipPublic),
        serverTime: new Date().toISOString(),
      };
    });
  });

  // ---------------------------------------------------------------- viewership (step 1)
  const publicEvent = async (tid: string) => {
    const t = await cached(`row:${tid}`, () => repo.tournamentById(tid));
    if (!t || t.archived || !t.public_watch) throw new HttpError(404, 'not_found', 'Tournament not found.');
    return t;
  };
  const clocks = (t: TournamentRow) => ({ streamClockSec: viewership.streamClockSec(t), live: isLive(t), beatSec: 30 });

  /** The watch page starts a view: an anonymous viewer id (kept in the browser) and its clock so far. */
  app.post('/api/public/tournaments/:id/view', async (req) => {
    const id = z.string().uuid().safeParse((req.params as { id: string }).id);
    if (!id.success) throw new HttpError(404, 'not_found', 'Tournament not found.');
    const body = z.object({ viewerKey: z.string().max(64).nullish(), ref: z.string().max(40).nullish() }).parse(req.body ?? {});
    const t = await publicEvent(id.data);
    const refId = await ctx.influencers.refIdFor(t.id, body.ref);
    const v = await viewership.start(t, { viewerKey: body.viewerKey, ip: req.ip, userAgent: req.headers['user-agent'], refId });
    return { token: v.token, viewerKey: v.viewerKey, watchedSec: v.watchedSec, ...clocks(t) };
  });

  /**
   * Every 30 s (and when the page is hidden or closed, via sendBeacon): seconds watched with the
   * video playing and the tab visible, and seconds unmuted. Accepts JSON sent as text/plain too.
   */
  app.register(async (scope) => {
    scope.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: 4096 }, (_req, body, done) => {
      try {
        done(null, JSON.parse(String(body)));
      } catch {
        done(new HttpError(400, 'bad_body', 'Expected JSON.'), undefined);
      }
    });
    scope.post('/api/public/view/beat', async (req) => {
      const body = z.object({ token: z.string().max(200), playingSec: z.number().min(0).max(3600), unmutedSec: z.number().min(0).max(3600) }).parse(req.body);
      const b = viewership.beat(body.token, body.playingSec, body.unmutedSec);
      const t = await publicEvent(b.tournamentId);
      return { addedSec: b.addedSec, ...clocks(t) };
    });
  });

  /**
   * Watch page: YouTube player + live leaderboard + clips. /watch lists live tournaments.
   * Embeddable in the CoGolfers website: <iframe src="https://live.…/watch/<id>"> (WATCH_EMBED_ORIGINS).
   */
  const sendWatch = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!publicDir) throw new HttpError(500, 'missing_assets', 'Watch page assets are missing.');
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=60');
    reply.header('Content-Security-Policy', `frame-ancestors 'self'${embedOrigins.map((o) => ` ${o}`).join('')}`);
    return reply.send(fs.readFileSync(path.join(publicDir, 'watch.html')));
  };
  app.get('/watch', sendWatch);
  app.get('/watch/:id', sendWatch);
}
