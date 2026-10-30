import fs from 'node:fs';
import os from 'node:os';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';
import { userOf } from '../auth.js';
import { fromCc } from '../billing.js';
import { Messenger, maskPhone, normalisePhone, type Msg91Settings } from '../messaging.js';
import { maskSecret } from '../secrets.js';
import { EVENT_TYPE_IDS, EVENT_TYPES } from '../event-types.js';
import { adminGuard } from './web.js';

const uuid = z.string().uuid();
const startedAt = Date.now();
const cell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};
const csv = (reply: FastifyReply, name: string, head: string[], rows: unknown[][]) => {
  reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}.csv"`);
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
};
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * V7 super admin: SMS, platform-wide viewership and prizes, content and safety (chat, data
 * requests), platform settings, system health with cost against revenue, and reports.
 */
export function registerAdminOpsRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, messenger, secrets, platform, hub, poller, cloud } = ctx;
  const admin = adminGuard(ctx);
  const q = repo.db;

  // ---------------------------------------------------------------- SMS (MSG91)
  const smsDto = () => {
    const s = messenger.settings;
    return {
      source: messenger.source,
      live: messenger.live,
      authKey: maskSecret(s?.authKey),
      templates: s?.templates ?? { otp: null, reminder: null, winner: null, draw_entry: null },
      texts: {
        otp: Messenger.text('otp', ['{#var#}']),
        reminder: Messenger.text('reminder', ['{#var#}', '{#var#}']),
        winner: Messenger.text('winner', ['{#var#}', '{#var#}', '{#var#}']),
        draw_entry: Messenger.text('draw_entry', ['{#var#}']),
      },
    };
  };
  app.get('/api/admin/sms', { preHandler: admin }, async () => smsDto());
  app.put('/api/admin/sms', { preHandler: admin }, async (req) => {
    const t = z.string().trim().max(60).nullish().transform((v) => v || null);
    const b = z.object({ authKey: z.string().trim().max(200).optional(), templates: z.object({ otp: t, reminder: t, winner: t, draw_entry: t }) }).parse(req.body);
    const authKey = b.authKey || messenger.saved?.authKey || '';
    if (!authKey) throw new HttpError(400, 'key_required', 'Enter the MSG91 auth key.');
    const v: Msg91Settings = { authKey, templates: b.templates };
    await secrets.set('msg91', v, userOf(req).id);
    messenger.saved = v;
    return smsDto();
  });
  app.delete('/api/admin/sms', { preHandler: admin }, async () => {
    await secrets.remove('msg91');
    messenger.saved = null;
    return smsDto();
  });
  /** Sends a sample claim code to a phone, to check the key and the OTP template. */
  app.post('/api/admin/sms/test', { preHandler: admin }, async (req) => {
    const b = z.object({ phone: z.string().max(20) }).parse(req.body);
    const phone = normalisePhone(b.phone);
    const n = await messenger.send([{ kind: 'otp', phone, vars: ['123456'], tournamentId: null }]);
    const last = (await q.query('SELECT status, error, provider FROM messages ORDER BY id DESC LIMIT 1')).rows[0];
    return { ok: n === 1, provider: last?.provider, error: last?.error ?? null, to: maskPhone(phone) };
  });
  app.get('/api/admin/messages', { preHandler: admin }, async (req) => {
    const f = z.object({ status: z.enum(['sent', 'failed']).optional(), kind: z.enum(['reminder', 'otp', 'winner', 'draw_entry']).optional(), event: uuid.optional() }).parse(req.query);
    const w: string[] = [];
    const v: unknown[] = [];
    if (f.status) (v.push(f.status), w.push(`m.status = $${v.length}`));
    if (f.kind) (v.push(f.kind), w.push(`m.kind = $${v.length}`));
    if (f.event) (v.push(f.event), w.push(`m.tournament_id = $${v.length}`));
    const rows = (
      await q.query(
        `SELECT m.*, t.name AS event, o.name AS club FROM messages m LEFT JOIN tournaments t ON t.id = m.tournament_id LEFT JOIN orgs o ON o.id = t.org_id
         ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY m.id DESC LIMIT 300`,
        v,
      )
    ).rows;
    const stats = (
      await q.query<Record<string, string>>(
        `SELECT
          count(*) FILTER (WHERE status = 'sent' AND created_at >= now() - interval '24 hours')::text AS sent_day,
          count(*) FILTER (WHERE status = 'failed' AND created_at >= now() - interval '24 hours')::text AS failed_day,
          count(*) FILTER (WHERE status = 'sent' AND created_at >= date_trunc('month', now()))::text AS sent_month,
          count(*) FILTER (WHERE status = 'failed' AND created_at >= date_trunc('month', now()))::text AS failed_month,
          count(*) FILTER (WHERE error = 'no_credits' AND created_at >= date_trunc('month', now()))::text AS no_credits_month,
          count(*) FILTER (WHERE status = 'sent' AND provider = 'msg91' AND created_at >= date_trunc('month', now()))::text AS paid_month,
          (SELECT COALESCE(-sum(amount_cc), 0) FROM wallet_tx WHERE kind = 'messages' AND updated_at >= date_trunc('month', now()))::text AS charged_cc
         FROM messages`,
      )
    ).rows[0];
    const sentMonth = Number(stats.sent_month);
    return {
      stats: {
        sent24h: Number(stats.sent_day),
        failed24h: Number(stats.failed_day),
        sentMonth,
        failedMonth: Number(stats.failed_month),
        notSentNoCreditsMonth: Number(stats.no_credits_month),
        costMonthInr: r2(Number(stats.paid_month) * platform.values.costs.smsInr),
        chargedMonthCredits: fromCc(stats.charged_cc),
      },
      messages: rows.map((m) => ({ id: Number(m.id), at: new Date(m.created_at).toISOString(), kind: m.kind, to: m.to_masked, provider: m.provider, status: m.status, error: m.error, event: m.event, club: m.club, eventId: m.tournament_id })),
    };
  });

  // ---------------------------------------------------------------- viewership, games and prizes (all events)
  app.get('/api/admin/viewership', { preHandler: admin }, async (req) => {
    const days = z.object({ days: z.coerce.number().int().min(1).max(3650).default(30) }).parse(req.query).days;
    const since = `now() - interval '${days} days'`;
    const tot = (
      await q.query<Record<string, string>>(
        `SELECT
          (SELECT count(*) FROM viewers WHERE NOT flagged AND first_seen_at >= ${since})::text AS viewers,
          (SELECT count(*) FROM viewers WHERE flagged AND first_seen_at >= ${since})::text AS flagged,
          (SELECT COALESCE(sum(watched_sec), 0) FROM viewers WHERE NOT flagged AND first_seen_at >= ${since})::text AS watch_sec,
          (SELECT count(*) FROM viewers WHERE NOT flagged AND ref_id IS NOT NULL AND first_seen_at >= ${since})::text AS via_influencers,
          (SELECT count(*) FROM influencers WHERE created_at >= ${since})::text AS influencers,
          (SELECT count(*) FROM moment_plays WHERE played_at >= ${since})::text AS plays,
          (SELECT count(*) FROM moment_plays WHERE shown_at >= ${since})::text AS shown,
          (SELECT count(*) FROM wins WHERE status IN ('won', 'claimed', 'sent', 'expired') AND created_at >= ${since})::text AS wins,
          (SELECT count(*) FROM wins WHERE status IN ('claimed', 'sent') AND created_at >= ${since})::text AS claimed,
          (SELECT count(*) FROM wins WHERE status = 'won' AND created_at >= ${since})::text AS unclaimed,
          (SELECT count(*) FROM tournaments WHERE viewership_on_at >= ${since})::text AS addons`,
      )
    ).rows[0];
    const top = (
      await q.query(
        `SELECT t.id, t.name, o.name AS club, count(v.id)::int AS viewers, COALESCE(sum(v.watched_sec), 0)::bigint AS watch_sec,
                count(v.id) FILTER (WHERE v.ref_id IS NOT NULL)::int AS via_influencers
           FROM viewers v JOIN tournaments t ON t.id = v.tournament_id JOIN orgs o ON o.id = t.org_id
          WHERE NOT v.flagged AND v.first_seen_at >= ${since} GROUP BY t.id, o.name ORDER BY watch_sec DESC LIMIT 20`,
      )
    ).rows;
    const topInf = (
      await q.query(
        `SELECT i.id, i.name, i.handle, i.platform, t.name AS event, o.name AS club, count(v.id)::int AS viewers, COALESCE(sum(v.watched_sec), 0)::bigint AS watch_sec
           FROM influencers i JOIN viewers v ON v.ref_id = i.id AND NOT v.flagged JOIN tournaments t ON t.id = i.tournament_id JOIN orgs o ON o.id = t.org_id
          WHERE v.first_seen_at >= ${since} GROUP BY i.id, t.name, o.name ORDER BY viewers DESC LIMIT 20`,
      )
    ).rows;
    const shown = Number(tot.shown);
    return {
      days,
      totals: {
        viewers: Number(tot.viewers),
        notCounted: Number(tot.flagged),
        watchMinutes: Math.round(Number(tot.watch_sec) / 60),
        viaInfluencers: Number(tot.via_influencers),
        influencers: Number(tot.influencers),
        gamesShown: shown,
        gamesPlayed: Number(tot.plays),
        playRate: shown ? Math.round((Number(tot.plays) / shown) * 100) : 0,
        prizesWon: Number(tot.wins),
        prizesClaimed: Number(tot.claimed),
        prizesUnclaimed: Number(tot.unclaimed),
        addonsBought: Number(tot.addons),
      },
      topEvents: top.map((t) => ({ id: t.id, name: t.name, club: t.club, viewers: t.viewers, watchMinutes: Math.round(Number(t.watch_sec) / 60), viaInfluencers: t.via_influencers })),
      topInfluencers: topInf.map((i) => ({ id: i.id, name: i.name, handle: i.handle, platform: i.platform, event: i.event, club: i.club, viewers: i.viewers, watchMinutes: Math.round(Number(i.watch_sec) / 60) })),
    };
  });

  /** Every prize won on the platform, for audits and support (contacts masked). */
  app.get('/api/admin/wins', { preHandler: admin }, async (req) => {
    const f = z.object({ status: z.enum(['won', 'reserve', 'claimed', 'sent', 'expired']).optional() }).parse(req.query);
    const rows = (
      await q.query(
        `SELECT w.id, w.prize, w.sponsor, w.status, w.phone, w.email, w.created_at, w.claimed_at, w.sent_at, w.claim_expires_at, w.tournament_id,
                m.title AS game, t.name AS event, o.name AS club
           FROM wins w JOIN moments m ON m.id = w.moment_id JOIN tournaments t ON t.id = w.tournament_id JOIN orgs o ON o.id = t.org_id
          ${f.status ? 'WHERE w.status = $1' : ''} ORDER BY w.created_at DESC LIMIT 500`,
        f.status ? [f.status] : [],
      )
    ).rows;
    return {
      wins: rows.map((w) => ({
        id: w.id, prize: w.prize, sponsor: w.sponsor, status: w.status, game: w.game, event: w.event, eventId: w.tournament_id, club: w.club,
        phone: w.phone ? maskPhone(w.phone) : null, email: w.email ? w.email.replace(/^(.).*(@.*)$/, '$1***$2') : null,
        at: new Date(w.created_at).toISOString(), claimedAt: w.claimed_at ? new Date(w.claimed_at).toISOString() : null, sentAt: w.sent_at ? new Date(w.sent_at).toISOString() : null,
        claimBy: w.claim_expires_at ? new Date(w.claim_expires_at).toISOString() : null,
      })),
    };
  });

  // ---------------------------------------------------------------- content and safety
  app.get('/api/admin/chat', { preHandler: admin }, async (req) => {
    const f = z.object({ q: z.string().trim().max(100).optional(), hidden: z.enum(['yes']).optional() }).parse(req.query);
    const w: string[] = [];
    const v: unknown[] = [];
    if (f.q) (v.push(`%${f.q}%`), w.push(`(c.text ILIKE $${v.length} OR c.author ILIKE $${v.length})`));
    if (f.hidden) w.push('c.hidden');
    const rows = (
      await q.query(
        `SELECT c.id, c.tournament_id, c.source, c.author, c.author_key, c.text, c.hidden, c.created_at, t.name AS event, o.name AS club,
                EXISTS (SELECT 1 FROM chat_bans b WHERE b.tournament_id = c.tournament_id AND b.source = c.source AND b.author_key = c.author_key) AS banned
           FROM chat_messages c JOIN tournaments t ON t.id = c.tournament_id JOIN orgs o ON o.id = t.org_id
          ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY c.id DESC LIMIT 300`,
        v,
      )
    ).rows;
    return {
      messages: rows.map((c) => ({ id: Number(c.id), eventId: c.tournament_id, event: c.event, club: c.club, source: c.source, author: c.author, text: c.text, hidden: c.hidden, banned: c.banned, at: new Date(c.created_at).toISOString() })),
    };
  });
  app.get('/api/admin/chat-bans', { preHandler: admin }, async () => ({
    bans: (
      await q.query(
        `SELECT b.*, t.name AS event, o.name AS club FROM chat_bans b JOIN tournaments t ON t.id = b.tournament_id JOIN orgs o ON o.id = t.org_id ORDER BY b.created_at DESC LIMIT 500`,
      )
    ).rows.map((b) => ({ eventId: b.tournament_id, event: b.event, club: b.club, source: b.source, authorKey: b.author_key, author: b.author, by: b.banned_by, at: new Date(b.created_at).toISOString() })),
  }));
  app.post('/api/admin/chat-bans/remove', { preHandler: admin }, async (req) => {
    const b = z.object({ eventId: uuid, source: z.string().max(20), authorKey: z.string().max(200) }).parse(req.body);
    await ctx.chat.unban(b.eventId, b.source, b.authorKey);
    return { ok: true };
  });

  // Data protection requests: the public form on /delete-account files them; admins work them.
  app.post('/api/public/data-requests', async (req, reply) => {
    const b = z
      .object({ email: z.string().trim().toLowerCase().email(), kind: z.enum(['delete_account', 'delete_club', 'export', 'correct']), details: z.string().trim().max(2000).nullish() })
      .parse(req.body);
    const recent = Number((await q.query<{ n: string }>("SELECT count(*)::text AS n FROM data_requests WHERE email = $1 AND created_at >= now() - interval '1 day'", [b.email])).rows[0].n);
    if (recent >= 3) throw new HttpError(429, 'too_many', 'We already have your request. We will reply by email.');
    await q.query('INSERT INTO data_requests (email, kind, details) VALUES ($1, $2, $3)', [b.email, b.kind, b.details ?? null]);
    reply.status(201);
    return { ok: true, message: 'Request received. We will confirm by email and complete it within 30 days.' };
  });
  app.get('/api/admin/data-requests', { preHandler: admin }, async (req) => {
    const f = z.object({ status: z.enum(['open', 'done', 'rejected']).optional() }).parse(req.query);
    const rows = (
      await q.query(
        `SELECT d.*, u.id AS user_id FROM data_requests d LEFT JOIN users u ON lower(u.email) = d.email ${f.status ? 'WHERE d.status = $1' : ''} ORDER BY d.created_at DESC LIMIT 500`,
        f.status ? [f.status] : [],
      )
    ).rows;
    return {
      requests: rows.map((d) => ({ id: d.id, email: d.email, userId: d.user_id, kind: d.kind, details: d.details, status: d.status, note: d.note, at: new Date(d.created_at).toISOString(), doneAt: d.done_at ? new Date(d.done_at).toISOString() : null, doneBy: d.done_by, dueBy: new Date(new Date(d.created_at).getTime() + 30 * 86400_000).toISOString() })),
    };
  });
  app.patch('/api/admin/data-requests/:id', { preHandler: admin }, async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const b = z.object({ status: z.enum(['open', 'done', 'rejected']), note: z.string().trim().max(1000).nullish() }).parse(req.body);
    const r = await q.query(
      `UPDATE data_requests SET status = $2, note = COALESCE($3, note), done_at = CASE WHEN $2 = 'open' THEN NULL ELSE now() END, done_by = CASE WHEN $2 = 'open' THEN NULL ELSE $4 END WHERE id = $1 RETURNING id`,
      [id, b.status, b.note ?? null, userOf(req).email],
    );
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'Request not found.');
    return { ok: true };
  });

  // ---------------------------------------------------------------- platform settings
  const costsSchema = z.object({
    fixedMonthlyInr: z.number().min(0).max(100_000_000),
    cloudEngineInrPerHour: z.number().min(0).max(1_000_000),
    cameraInrPerHour: z.number().min(0).max(1_000_000),
    smsInr: z.number().min(0).max(100),
    usdInr: z.number().min(1).max(1000),
  });
  const platformDto = () => ({
    ...platform.values,
    signupFromConfig: config.SIGNUP_ENABLED,
    brand: config.BRAND_NAME,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    supportEmail: config.SUPPORT_EMAIL ?? null,
    legalEntity: config.LEGAL_ENTITY ?? null,
    eventTypes: EVENT_TYPE_IDS.map((id) => ({ id, name: EVENT_TYPES[id].label })),
    youtube: ctx.youtube.enabled,
    cloudAvailable: cloud.available,
    billingEnabled: ctx.billing.enabled,
  });
  app.get('/api/admin/platform', { preHandler: admin }, async () => platformDto());
  app.put('/api/admin/platform', { preHandler: admin }, async (req) => {
    const b = z.object({ signupEnabled: z.boolean().optional(), costs: costsSchema.partial().optional() }).parse(req.body);
    await platform.save(b);
    return platformDto();
  });

  // ---------------------------------------------------------------- system health, cost against revenue
  const margin = async (months: number) => {
    const c = platform.values.costs;
    const rows = (
      await q.query<Record<string, string>>(
        `SELECT to_char(m, 'YYYY-MM') AS month,
          (SELECT COALESCE(sum(amount_inr), 0) FROM payments WHERE status = 'paid' AND date_trunc('month', paid_at AT TIME ZONE 'Asia/Kolkata') = m)::text AS paid,
          (SELECT COALESCE(sum(amount_inr), 0) FROM refunds WHERE status = 'success' AND date_trunc('month', processed_at AT TIME ZONE 'Asia/Kolkata') = m)::text AS refunded,
          (SELECT COALESCE(sum(live_seconds), 0) FROM usage_daily WHERE mode = 'cloud' AND date_trunc('month', day) = m)::text AS cloud_sec,
          (SELECT COALESCE(sum(camera_seconds), 0) FROM usage_daily WHERE date_trunc('month', day) = m)::text AS cam_sec,
          (SELECT COALESCE(sum(live_seconds), 0) FROM usage_daily WHERE date_trunc('month', day) = m)::text AS live_sec,
          (SELECT count(*) FROM messages WHERE status = 'sent' AND provider = 'msg91' AND date_trunc('month', created_at AT TIME ZONE 'Asia/Kolkata') = m)::text AS sms
         FROM generate_series(date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') - ($1::int - 1) * interval '1 month', date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata'), interval '1 month') AS m
         ORDER BY m`,
        [months],
      )
    ).rows;
    return rows.map((r) => {
      const revenue = r2(Number(r.paid) - Number(r.refunded));
      const cloudHours = r2(Number(r.cloud_sec) / 3600);
      const cameraHours = r2(Number(r.cam_sec) / 3600);
      const costs = {
        fixed: c.fixedMonthlyInr,
        cloud: r2(cloudHours * c.cloudEngineInrPerHour),
        bandwidth: r2(cameraHours * c.cameraInrPerHour),
        sms: r2(Number(r.sms) * c.smsInr),
      };
      const total = r2(costs.fixed + costs.cloud + costs.bandwidth + costs.sms);
      return { month: r.month, revenueInr: revenue, refundsInr: Number(r.refunded), liveHours: r2(Number(r.live_sec) / 3600), cloudHours, cameraHours, sms: Number(r.sms), costs, costInr: total, marginInr: r2(revenue - total) };
    });
  };

  app.get('/api/admin/system', { preHandler: admin }, async () => {
    const db = (await q.query<{ size: string; conns: string }>("SELECT pg_database_size(current_database())::text AS size, (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::text AS conns")).rows[0];
    const counts = (
      await q.query<Record<string, string>>(
        `SELECT (SELECT count(*) FROM users)::text AS users, (SELECT count(*) FROM orgs)::text AS clubs, (SELECT count(*) FROM tournaments)::text AS events,
                (SELECT count(*) FROM viewers)::text AS viewers, (SELECT count(*) FROM chat_messages)::text AS chat, (SELECT count(*) FROM messages)::text AS sms,
                (SELECT count(*) FROM audit_log)::text AS audit`,
      )
    ).rows[0];
    const disk = (dir: string | undefined) => {
      if (!dir) return null;
      try {
        const s = fs.statfsSync(dir);
        return { path: dir, freeGb: r2((s.bavail * s.bsize) / 1e9), totalGb: r2((s.blocks * s.bsize) / 1e9) };
      } catch {
        return null;
      }
    };
    const live = hub.streamingTournaments();
    let cloudRunning = 0;
    for (const tid of live) {
      const t = await repo.tournamentById(tid);
      if (t?.production_mode === 'cloud') cloudRunning++;
    }
    const engines = live.map((tid) => hub.engineState(tid)).filter((e) => !e.obsConnected).length;
    return {
      server: {
        version: process.env.GIT_SHA ?? process.env.npm_package_version ?? 'dev',
        node: process.version,
        uptimeMin: Math.round((Date.now() - startedAt) / 60000),
        hostUptimeH: Math.round(os.uptime() / 3600),
        load: os.loadavg().map((x) => r2(x)),
        cpus: os.cpus().length,
        memoryUsedPct: Math.round((1 - os.freemem() / os.totalmem()) * 100),
        processMb: Math.round(process.memoryUsage().rss / 1e6),
      },
      database: { sizeMb: Math.round(Number(db.size) / 1e6), connections: Number(db.conns), rows: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])) },
      media: { reachable: poller.last.reachable, error: poller.last.error ?? null, streams: [...poller.last.paths.values()].filter((p) => p.online).length },
      live: { events: live.length, cloudEngines: cloudRunning, enginesDisconnected: engines },
      disks: [disk(config.MEDIA_DIR), disk(config.THUMBNAIL_DIR)].filter(Boolean),
      integrations: {
        payments: ctx.payments.enabled ? `Cashfree ${ctx.payments.mode}` : 'Off',
        sms: messenger.live ? `MSG91 (${messenger.source})` : 'Test sender (no MSG91 key)',
        youtube: ctx.youtube.enabled ? 'Configured' : 'Not configured',
        cloud: cloud.available ? `Driver ${config.CLOUD_ENGINE_DRIVER}` : 'Off',
        invoices: (await ctx.invoices.settings()).enabled ? 'On' : 'Off',
      },
      margin: await margin(6),
      costs: platform.values.costs,
    };
  });

  // ---------------------------------------------------------------- reports
  const REPORTS = ['revenue', 'usage', 'growth', 'viewership', 'sms', 'margin'] as const;
  type Report = (typeof REPORTS)[number];
  const report = async (kind: Report, months: number): Promise<{ head: string[]; rows: unknown[][] }> => {
    const range = `date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') - (${months} - 1) * interval '1 month'`;
    switch (kind) {
      case 'revenue': {
        const rows = (
          await q.query(
            `WITH p AS (SELECT p.*, date_trunc('month', p.paid_at AT TIME ZONE 'Asia/Kolkata') AS m FROM payments p WHERE p.status = 'paid' AND p.paid_at AT TIME ZONE 'Asia/Kolkata' >= ${range}),
                  r AS (SELECT org_id, date_trunc('month', processed_at AT TIME ZONE 'Asia/Kolkata') AS m, sum(amount_inr) AS refunded FROM refunds WHERE status = 'success' GROUP BY 1, 2)
             SELECT to_char(p.m, 'YYYY-MM') AS month, o.name AS club, count(*)::int AS payments, sum(p.amount_inr)::numeric AS paid, sum(p.discount_inr)::numeric AS discount,
                    sum(p.credits_cc + p.bonus_cc)::bigint AS cc, COALESCE(max(r.refunded), 0)::numeric AS refunded
               FROM p JOIN orgs o ON o.id = p.org_id LEFT JOIN r ON r.org_id = p.org_id AND r.m = p.m
              GROUP BY p.m, o.id ORDER BY p.m DESC, paid DESC`,
          )
        ).rows;
        return { head: ['Month', 'Club', 'Payments', 'Paid (INR)', 'Coupon discounts (INR)', 'Refunded (INR)', 'Net (INR)', 'Credits given'], rows: rows.map((r) => [r.month, r.club, r.payments, Number(r.paid), Number(r.discount), Number(r.refunded), r2(Number(r.paid) - Number(r.refunded)), fromCc(r.cc)]) };
      }
      case 'usage': {
        const rows = (
          await q.query(
            `WITH u AS (SELECT date_trunc('month', day) AS m, org_id, count(DISTINCT tournament_id) AS events, sum(live_seconds) AS live, sum(camera_seconds) AS cam,
                               sum(live_seconds) FILTER (WHERE mode = 'cloud') AS cloud
                          FROM usage_daily WHERE day >= ${range} GROUP BY 1, 2),
                  w AS (SELECT date_trunc('month', updated_at) AS m, org_id, -sum(amount_cc) AS spent FROM wallet_tx
                         WHERE kind IN ('cameras', 'minutes', 'destinations', 'viewership', 'messages') GROUP BY 1, 2)
             SELECT to_char(u.m, 'YYYY-MM') AS month, o.name AS club, u.events::int AS events, u.live::bigint AS live, u.cam::bigint AS cam, u.cloud::bigint AS cloud, COALESCE(w.spent, 0)::bigint AS spent
               FROM u JOIN orgs o ON o.id = u.org_id LEFT JOIN w ON w.org_id = u.org_id AND w.m = u.m ORDER BY u.m DESC, u.live DESC`,
          )
        ).rows;
        return { head: ['Month', 'Club', 'Events live', 'Live hours', 'Camera hours', 'Cloud engine hours', 'Credits used'], rows: rows.map((r) => [r.month, r.club, r.events, r2(Number(r.live) / 3600), r2(Number(r.cam) / 3600), r2(Number(r.cloud ?? 0) / 3600), fromCc(r.spent)]) };
      }
      case 'growth': {
        const rows = (
          await q.query(
            `SELECT to_char(w, 'YYYY-MM-DD') AS week,
                (SELECT count(*) FROM orgs WHERE date_trunc('week', created_at) = w)::int AS signups,
                (SELECT count(*) FROM orgs WHERE date_trunc('week', created_at) = w AND first_event_at IS NOT NULL)::int AS made_event,
                (SELECT count(*) FROM orgs WHERE date_trunc('week', created_at) = w AND first_live_at IS NOT NULL)::int AS went_live,
                (SELECT count(*) FROM orgs o WHERE date_trunc('week', o.created_at) = w AND EXISTS (SELECT 1 FROM payments p WHERE p.org_id = o.id AND p.status = 'paid'))::int AS paid
             FROM generate_series(date_trunc('week', now()) - ($1::int * 4 - 1) * interval '1 week', date_trunc('week', now()), interval '1 week') AS w ORDER BY w DESC`,
            [months],
          )
        ).rows;
        const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
        return { head: ['Week starting', 'Sign-ups', 'Created an event', 'Went live', 'Paid', 'Live %', 'Paid %'], rows: rows.map((r) => [r.week, r.signups, r.made_event, r.went_live, r.paid, pct(r.went_live, r.signups), pct(r.paid, r.signups)]) };
      }
      case 'viewership': {
        const rows = (
          await q.query(
            `SELECT t.name AS event, o.name AS club, to_char(t.created_at, 'YYYY-MM-DD') AS created, count(v.id) FILTER (WHERE NOT v.flagged)::int AS viewers,
                    COALESCE(sum(v.watched_sec) FILTER (WHERE NOT v.flagged), 0)::bigint AS watch, count(v.id) FILTER (WHERE v.ref_id IS NOT NULL AND NOT v.flagged)::int AS via_inf,
                    (SELECT count(*) FROM moment_plays mp WHERE mp.tournament_id = t.id AND mp.played_at IS NOT NULL)::int AS plays,
                    (SELECT count(*) FROM wins w WHERE w.tournament_id = t.id AND w.status IN ('won', 'claimed', 'sent', 'expired'))::int AS wins,
                    t.viewership_on_at IS NOT NULL AS addon
               FROM tournaments t JOIN orgs o ON o.id = t.org_id LEFT JOIN viewers v ON v.tournament_id = t.id
              WHERE t.created_at >= ${range} GROUP BY t.id, o.name ORDER BY watch DESC`,
          )
        ).rows;
        return { head: ['Event', 'Club', 'Created', 'Viewers', 'Watch minutes', 'Via influencers', 'Games played', 'Prizes won', 'Add-on'], rows: rows.map((r) => [r.event, r.club, r.created, r.viewers, Math.round(Number(r.watch) / 60), r.via_inf, r.plays, r.wins, r.addon ? 'Yes' : 'No']) };
      }
      case 'sms': {
        const rows = (
          await q.query(
            `SELECT COALESCE(t.name, '(admin test)') AS event, COALESCE(o.name, '') AS club, m.kind, count(*) FILTER (WHERE m.status = 'sent')::int AS sent,
                    count(*) FILTER (WHERE m.status = 'failed' AND m.error IS DISTINCT FROM 'no_credits')::int AS failed, count(*) FILTER (WHERE m.error = 'no_credits')::int AS no_credits
               FROM messages m LEFT JOIN tournaments t ON t.id = m.tournament_id LEFT JOIN orgs o ON o.id = t.org_id
              WHERE m.created_at AT TIME ZONE 'Asia/Kolkata' >= ${range} GROUP BY 1, 2, 3 ORDER BY sent DESC`,
          )
        ).rows;
        return { head: ['Event', 'Club', 'Kind', 'Sent', 'Failed', 'Not sent (no credits)', 'Cost (INR)'], rows: rows.map((r) => [r.event, r.club, r.kind, r.sent, r.failed, r.no_credits, r2(r.sent * platform.values.costs.smsInr)]) };
      }
      case 'margin': {
        const m = await margin(months);
        return {
          head: ['Month', 'Revenue after refunds (INR)', 'Fixed (INR)', 'Cloud engines (INR)', 'Bandwidth (INR)', 'SMS (INR)', 'Total cost (INR)', 'Margin (INR)', 'Live hours', 'Camera hours', 'Cloud hours', 'SMS sent'],
          rows: m.map((x) => [x.month, x.revenueInr, x.costs.fixed, x.costs.cloud, x.costs.bandwidth, x.costs.sms, x.costInr, x.marginInr, x.liveHours, x.cameraHours, x.cloudHours, x.sms]),
        };
      }
    }
  };
  const reportParams = (req: { params: unknown; query: unknown }) => ({
    kind: z.enum(REPORTS).parse((req.params as { kind: string }).kind.replace(/\.csv$/, '')),
    months: z.object({ months: z.coerce.number().int().min(1).max(36).default(6) }).parse(req.query).months,
  });
  app.get('/api/admin/reports/:kind', { preHandler: admin }, async (req, reply) => {
    const { kind, months } = reportParams(req);
    const r = await report(kind, months);
    if ((req.params as { kind: string }).kind.endsWith('.csv')) return csv(reply, `${kind}-${months}m`, r.head, r.rows);
    return r;
  });
}
