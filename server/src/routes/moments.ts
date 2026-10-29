import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { requireAuth, userOf } from '../auth.js';
import { requireTournament } from '../authz.js';
import { HttpError } from '../errors.js';
import { MOMENT_AUDIENCES, MOMENT_CLOCKS, MOMENT_TYPES } from '../moments.js';

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
  const feedCache = new Map<string, { at: number; body: unknown }>();
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
    if (hit && Date.now() - hit.at < 2000) return hit.body;
    const t = await repo.tournamentById(id.data);
    if (!t || t.archived || !t.public_watch) throw new HttpError(404, 'not_found', 'Not found.');
    const slugs = new Map((await influencers.list(t.id, true)).map((i) => [i.id, i.slug]));
    const body = { ...(await moments.feed(t, slugs)), streamClockSec: viewership.streamClockSec(t) };
    feedCache.set(id.data, { at: Date.now(), body });
    if (feedCache.size > 2000) feedCache.delete(feedCache.keys().next().value!);
    return body;
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
    if (v.flagged) throw new HttpError(403, 'not_counted', 'Games are not available here.');
    return { result: await moments.play(v.viewerId, v.tournamentId, mid(req), b.runKey, b.answer ?? null) };
  });
}
