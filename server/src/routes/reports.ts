import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { requireAuth } from '../auth.js';
import { requireTournament } from '../authz.js';

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};
const csv = (head: string[], rows: unknown[][]) => [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');

/** Viewership reports as CSV (Studio > Reports): per minute, per influencer, per game. */
export function registerReportRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, viewership, influencers, moments } = ctx;
  const user = requireAuth(config, 'user');

  app.get('/api/tournaments/:id/report.csv', { preHandler: user }, async (req, reply) => {
    const { t } = await requireTournament(repo, req.principal!, z.string().uuid().parse((req.params as { id: string }).id), 'direct');
    const kind = z.enum(['minutes', 'influencers', 'games']).parse((req.query as { kind?: string }).kind);
    let body: string;
    if (kind === 'minutes') {
      const s = await viewership.summary(t);
      body = csv(['Minute (UTC)', 'Watching on the page', 'Unmuted', 'Watching on YouTube'], s.series.map((p) => [p.at, p.watching, p.unmuted, p.youtube]));
    } else if (kind === 'influencers') {
      await viewership.flush().catch(() => {});
      const list = await influencers.stats(t);
      body = csv(
        ['Influencer', 'Handle', 'Link', 'Link taps', 'Viewers', 'Viewers 30 s+', 'Left under 30 s', 'Minutes watched', 'Avg watch (s)', 'Unmuted %', 'Returning', 'Reminder sign-ups', 'Arrived before live', 'Arrived first 10 min', 'Arrived later'],
        list.map((i) => [i.name, i.handle, i.link, i.clicks, i.viewers, i.qualifiedViewers, i.bouncedViewers, i.watchMinutes, i.avgWatchSec, i.unmutedRate, i.returningViewers, i.reminders, i.arrivedBeforeLive, i.arrivedFirst10Min, i.arrivedLater]),
      );
    } else {
      const list = await moments.report(t);
      body = csv(
        ['Game', 'Type', 'Clock', 'Runs', 'Shown', 'Played', 'Play %', 'Closed', 'Right %', 'Watch after (players, s)', 'Watch after (skipped, s)', 'Extra watch (s)', 'Answers'],
        list.map((m) => [
          m.title, m.type, m.clock, m.runs, m.shown, m.played, m.playRate, m.dismissed, m.correctRate, m.watchAfterSec.played, m.watchAfterSec.skipped, m.extraWatchSec,
          (m.answers ?? []).map((a) => `${a.text}: ${a.count}`).join('; '),
        ]),
      );
    }
    reply.type('text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${kind}-${t.id.slice(0, 8)}.csv"`);
    return body;
  });
}
