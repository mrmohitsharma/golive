import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { requireAuth, userOf } from '../auth.js';
import { requireTournament } from '../authz.js';
import { HttpError } from '../errors.js';
import { MOMENT_AUDIENCES, MOMENT_CLOCKS, MOMENT_TYPES } from '../moments.js';
import { describeAgent } from '../viewership.js';

/** Watch-page reactions (👏 🔥 ⛳): running totals per event, in memory; every page shows the new ones floating up. */
export const REACTIONS = ['clap', 'fire', 'golf'] as const;
export class Reactions {
  private totals = new Map<string, { clap: number; fire: number; golf: number; at: number }>();
  private hits = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}
  /** false when this connection sends too many (more than 20 in 10 s). */
  add(tid: string, kind: (typeof REACTIONS)[number], who: string): boolean {
    const t = this.now();
    const h = (this.hits.get(who) ?? []).filter((x) => t - x < 10_000);
    if (h.length >= 20) return false;
    h.push(t);
    this.hits.set(who, h);
    if (this.hits.size > 20_000) this.hits.delete(this.hits.keys().next().value!);
    const c = this.totals.get(tid) ?? { clap: 0, fire: 0, golf: 0, at: t };
    c[kind]++;
    c.at = t;
    this.totals.set(tid, c);
    if (this.totals.size > 5000) this.totals.delete(this.totals.keys().next().value!);
    return true;
  }
  of(tid: string) {
    const c = this.totals.get(tid);
    return c ? { clap: c.clap, fire: c.fire, golf: c.golf } : { clap: 0, fire: 0, golf: 0 };
  }
}

const uuid = z.string().uuid();

const option = z.object({
  id: z.string().trim().min(1).max(20).regex(/^[\w-]+$/),
  text: z.string().trim().min(1).max(80),
  weight: z.number().min(0).max(1000).optional(),
  win: z.boolean().optional(),
});
const momentBody = z.object({
  type: z.enum(MOMENT_TYPES),
  title: z.string().trim().min(1).max(80),
  question: z.string().trim().max(200).nullish(),
  options: z.array(option).max(12).optional(),
  correctOption: z.string().max(20).nullish(),
  clock: z.enum(MOMENT_CLOCKS),
  atSec: z.number().int().min(0).max(24 * 3600).nullish(),
  repeatEverySec: z.number().int().min(30).max(24 * 3600).nullish(),
  repeatMax: z.number().int().min(1).max(100).optional(),
  openSec: z.number().int().min(10).max(3600).optional(),
  audience: z.enum(MOMENT_AUDIENCES).optional(),
  audienceRef: z.string().uuid().nullish(),
  lateJoin: z.boolean().optional(),
  enabled: z.boolean().optional(),
  sort: z.number().int().min(0).max(10_000).optional(),
  pick: z.enum(['draw', 'first_correct', 'spin']).nullish(),
  prize: z.string().trim().max(120).nullish(),
  sponsor: z.string().trim().max(80).nullish(),
  prizeStock: z.number().int().min(1).max(100_000).nullish(),
  winnersPerRun: z.number().int().min(1).max(10_000).nullish(),
  reserves: z.number().int().min(0).max(20).optional(),
  claimHours: z.number().int().min(1).max(24 * 14).optional(),
  minWatchSec: z.number().int().min(0).max(24 * 3600).optional(),
  needUnmuted: z.boolean().optional(),
  pacePerHour: z.number().int().min(1).max(100_000).nullish(),
  drawAtSec: z.number().int().min(0).max(24 * 3600).nullish(),
});

/**
 * Games on the watch page (viewership step 3): organisers set them up in the Studio, the director
 * fires director moments from the control room, and the watch page shows and plays them.
 */
export function registerMomentRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, moments, viewership, influencers } = ctx;
  const user = requireAuth(config, 'user');
  const tid = (req: { params: unknown }) => uuid.parse((req.params as { id: string }).id);
  const mid = (req: { params: unknown }) => uuid.parse((req.params as { mid: string }).mid);

  // The watch page's feed is cached for 2 s per event; any change shows at once.
  const feedCache = new Map<string, { at: number; body: Record<string, unknown> }>();
  const reactions = new Reactions();
  const fansCache = new Map<string, { at: number; body: Awaited<ReturnType<typeof moments.fans>> }>();
  const changed = (id: string) => feedCache.delete(id);

  // ---------------------------------------------------------------- organiser side
  app.get('/api/tournaments/:id/moments', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'direct');
    return {
      gapSec: t.moment_gap_sec,
      streamClockSec: viewership.streamClockSec(t),
      moments: (await moments.list(t.id)).map((m) => moments.dto(m)),
      runs: (await moments.runs(t.id)).map((r) => ({
        id: r.id,
        momentId: r.moment_id,
        runNo: r.run_no,
        startedAt: new Date(r.started_at).toISOString(),
        closesAt: new Date(r.closes_at).toISOString(),
        firedBy: r.fired_by,
        correctOption: r.correct_option,
      })),
    };
  });

  app.post('/api/tournaments/:id/moments', { preHandler: user }, async (req, reply) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    ctx.billing.requireViewership(t);
    if ((await moments.list(t.id)).length >= 100) throw new HttpError(409, 'too_many_moments', 'An event can have at most 100 games.');
    const m = await moments.create(t, momentBody.parse(req.body));
    changed(t.id);
    reply.status(201);
    return { moment: moments.dto(m) };
  });

  app.patch('/api/tournaments/:id/moments/:mid', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    const m = await moments.update(t, mid(req), momentBody.partial().parse(req.body));
    changed(t.id);
    return { moment: moments.dto(m) };
  });

  app.delete('/api/tournaments/:id/moments/:mid', { preHandler: user }, async (req, reply) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    await moments.remove(t, mid(req));
    changed(t.id);
    reply.status(204);
    return null;
  });

  /** "Fire moment" in the control room: opens it now for everyone watching. */
  app.post('/api/tournaments/:id/moments/:mid/fire', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'direct');
    ctx.billing.requireViewership(t);
    const run = await moments.fire(t, mid(req), userOf(req).email);
    changed(t.id);
    return { run: { id: run.id, runNo: run.run_no, closesAt: new Date(run.closes_at).toISOString() } };
  });

  /** Settles a prediction: the right answer, after the match moment happened. */
  app.post('/api/tournaments/:id/moments/:mid/resolve', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'direct');
    const b = z.object({ correctOption: z.string().min(1).max(20), runId: z.string().uuid().nullish() }).parse(req.body);
    const run = await moments.resolve(t, mid(req), b.correctOption, b.runId);
    changed(t.id);
    return { run: { id: run.id, correctOption: run.correct_option } };
  });

  app.get('/api/tournaments/:id/moments/report', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'direct');
    return { moments: await moments.report(t) };
  });

  // ---------------------------------------------------------------- watch page
  app.get('/api/public/tournaments/:id/moments', async (req, reply) => {
    const id = z.string().uuid().safeParse((req.params as { id: string }).id);
    if (!id.success) throw new HttpError(404, 'not_found', 'Not found.');
    reply.header('Cache-Control', 'no-store');
    const hit = feedCache.get(id.data);
    if (hit && Date.now() - hit.at < 2000) return { ...hit.body, reactions: reactions.of(id.data) };
    const t = await repo.tournamentById(id.data);
    if (!t || t.archived || !t.public_watch) throw new HttpError(404, 'not_found', 'Not found.');
    const slugs = new Map((await influencers.list(t.id, true)).map((i) => [i.id, i.slug]));
    const feed = ctx.billing.viewershipOn(t) ? await moments.feed(t, slugs) : { gapSec: 60, moments: [], runs: [], serverTime: new Date().toISOString() };
    const body = { ...feed, streamClockSec: viewership.streamClockSec(t) };
    feedCache.set(id.data, { at: Date.now(), body });
    if (feedCache.size > 2000) feedCache.delete(feedCache.keys().next().value!);
    return { ...body, reactions: reactions.of(id.data) };
  });

  app.post('/api/public/tournaments/:id/react', async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const b = z.object({ kind: z.enum(REACTIONS) }).parse(req.body);
    const t = await repo.tournamentById(id);
    if (!t || t.archived || !t.public_watch) throw new HttpError(404, 'not_found', 'Not found.');
    if (!reactions.add(id, b.kind, req.ip)) throw new HttpError(429, 'too_fast', 'Slow down a little.');
    reply.status(202);
    return { reactions: reactions.of(id) };
  });

  /** Top players (games points) and this viewer's place. */
  app.get('/api/public/tournaments/:id/fans', async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const q = z.object({ token: z.string().max(200).optional() }).parse(req.query);
    reply.header('Cache-Control', 'no-store');
    let me: string | null = null;
    if (q.token) {
      try {
        const v = viewership.verify(q.token);
        if (v.tournamentId === id) me = v.viewerId;
      } catch {}
    }
    if (!me) {
      const hit = fansCache.get(id);
      if (hit && Date.now() - hit.at < 5000) return hit.body;
    }
    const t = await repo.tournamentById(id);
    if (!t || t.archived || !t.public_watch) throw new HttpError(404, 'not_found', 'Not found.');
    const body = await moments.fans(id, me);
    if (!me) {
      fansCache.set(id, { at: Date.now(), body });
      if (fansCache.size > 2000) fansCache.delete(fansCache.keys().next().value!);
    }
    return body;
  });

  /** The name a viewer shows on Top players (optional; cleaned like chat names). */
  app.post('/api/public/view/nickname', async (req) => {
    const b = z.object({ token: z.string().max(200), name: z.string().max(60) }).parse(req.body);
    const v = viewership.verify(b.token);
    const clean = ctx.chat.clean(b.name)?.slice(0, 24) ?? null;
    if (!clean || clean.length < 2) throw new HttpError(400, 'bad_name', 'Enter a name of at least 2 letters.');
    if (/\*/.test(clean)) throw new HttpError(400, 'bad_name', 'Please choose another name.');
    await moments.setNickname(v.viewerId, clean);
    fansCache.delete(v.tournamentId);
    return { name: clean };
  });

  app.post('/api/public/moments/:mid/seen', async (req) => {
    const b = z.object({ token: z.string().max(200), runKey: z.string().max(40), kind: z.enum(['shown', 'dismissed']) }).parse(req.body);
    const v = viewership.verify(b.token);
    await moments.seen(v.viewerId, v.tournamentId, mid(req), b.runKey, b.kind);
    return { ok: true };
  });

  app.post('/api/public/moments/:mid/play', async (req) => {
    const b = z.object({ token: z.string().max(200), runKey: z.string().max(40), answer: z.string().max(20).nullish() }).parse(req.body);
    const v = viewership.verify(b.token);
    // Viewers over the per-network cap (a busy venue Wi-Fi, a mobile carrier) still play and
    // earn points; they just can't win prizes (prizes.ts checks). Only obvious bots are refused.
    if (v.flagged && describeAgent(String(req.headers['user-agent'] ?? '')).bot) throw new HttpError(403, 'not_counted', 'Games are not available here.');
    const result = await moments.play(v.viewerId, v.tournamentId, mid(req), b.runKey, b.answer ?? null);
    fansCache.delete(v.tournamentId);
    return { result };
  });
}
