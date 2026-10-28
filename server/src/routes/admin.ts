import { PLATFORM } from '../youtube.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';
import { requireAuth, userOf } from '../auth.js';
import { fromCc, packSchema, pricingSchema, txDto } from '../billing.js';
import { paymentDto } from '../payments.js';

const uuid = z.string().uuid();
const idParam = (req: { params: unknown }) => uuid.parse((req.params as { id: string }).id);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = [path.resolve(here, '../../public'), path.resolve(here, '../../../public')].find((p) => fs.existsSync(p));

/**
 * CoGolfers staff panel (/admin): pricing, credit packs, clubs, wallets, suspensions,
 * live broadcasts and payments. Only platform admins (users.is_platform_admin), checked
 * against the database on every call so revoking access is immediate.
 */
export function registerAdminRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, billing, payments, hub } = ctx;
  const signedIn = requireAuth(config, 'user');
  const admin = async (req: FastifyRequest, reply: Parameters<typeof signedIn>[1]) => {
    await signedIn(req, reply);
    const u = await repo.userById(userOf(req).id);
    if (!u || u.disabled || !u.is_platform_admin) throw new HttpError(403, 'not_admin', 'This page is for CoGolfers administrators only.');
  };
  const q = repo.db;
  const by = (req: FastifyRequest) => `admin:${userOf(req).email}`;

  app.get('/admin', async (_req, reply) => {
    if (!publicDir) throw new HttpError(500, 'missing_assets', 'Admin page assets are missing.');
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "frame-ancestors 'none'");
    return reply.send(fs.readFileSync(path.join(publicDir, 'admin.html')));
  });

  app.get('/api/admin/overview', { preHandler: admin }, async () => {
    const r = (
      await q.query<Record<string, string>>(
        `SELECT
          (SELECT count(*) FROM orgs)::text AS clubs,
          (SELECT count(*) FROM org_billing WHERE suspended)::text AS suspended,
          (SELECT count(*) FROM tournaments WHERE created_at >= date_trunc('month', now()))::text AS tournaments_month,
          (SELECT COALESCE(sum(amount_inr), 0) FROM payments WHERE status = 'paid' AND paid_at >= date_trunc('month', now()))::text AS revenue_month,
          (SELECT COALESCE(sum(amount_inr), 0) FROM payments WHERE status = 'paid')::text AS revenue_total,
          (SELECT COALESCE(-sum(amount_cc), 0) FROM wallet_tx WHERE kind IN ('cameras', 'minutes') AND updated_at >= date_trunc('month', now()))::text AS spent_month_cc,
          (SELECT COALESCE(sum(quantity), 0) FROM wallet_tx WHERE kind = 'minutes' AND updated_at >= date_trunc('month', now()))::text AS paid_minutes_month,
          (SELECT COALESCE(sum(balance_cc), 0) FROM org_billing)::text AS balances_cc`,
      )
    ).rows[0];
    return {
      clubs: Number(r.clubs),
      suspended: Number(r.suspended),
      liveNow: hub.streamingTournaments().length,
      tournamentsThisMonth: Number(r.tournaments_month),
      revenueThisMonthInr: Number(r.revenue_month),
      revenueTotalInr: Number(r.revenue_total),
      creditsSpentThisMonth: fromCc(r.spent_month_cc),
      paidMinutesThisMonth: Number(r.paid_minutes_month),
      creditsHeldByClubs: fromCc(r.balances_cc),
      billingEnabled: billing.enabled,
      paymentsEnabled: payments.enabled,
      cashfreeMode: config.CASHFREE_ENV,
    };
  });

  // ---------------------------------------------------------------- pricing and packs
  app.get('/api/admin/settings', { preHandler: admin }, async () => billing.settings());

  app.put('/api/admin/settings', { preHandler: admin }, async (req) => {
    const body = z.object({ pricing: pricingSchema.optional(), packs: z.array(packSchema).min(1).max(12).optional() }).parse(req.body);
    await billing.saveSettings(body, userOf(req).id);
    return billing.settings();
  });

  // ---------------------------------------------------------------- clubs
  app.get('/api/admin/orgs', { preHandler: admin }, async (req) => {
    const search = z.object({ q: z.string().trim().max(100).optional() }).parse(req.query).q;
    const rows = (
      await q.query(
        `SELECT o.id, o.name, o.created_at,
                COALESCE(b.balance_cc, 0)::text AS balance_cc, COALESCE(b.suspended, false) AS suspended,
                COALESCE(b.overrides, '{}'::jsonb) AS overrides,
                (SELECT string_agg(u.email, ', ') FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND m.role = 'owner') AS owners,
                (SELECT count(*) FROM tournaments t WHERE t.org_id = o.id)::int AS tournaments,
                (SELECT COALESCE(sum(t.live_seconds), 0) FROM tournaments t WHERE t.org_id = o.id)::int AS live_seconds,
                (SELECT max(t.created_at) FROM tournaments t WHERE t.org_id = o.id) AS last_tournament,
                (SELECT COALESCE(-sum(w.amount_cc), 0) FROM wallet_tx w WHERE w.org_id = o.id AND w.kind IN ('cameras', 'minutes'))::text AS spent_cc,
                (SELECT COALESCE(sum(p.amount_inr), 0) FROM payments p WHERE p.org_id = o.id AND p.status = 'paid')::text AS paid_inr
         FROM orgs o LEFT JOIN org_billing b ON b.org_id = o.id
         WHERE $1::text IS NULL OR o.name ILIKE '%' || $1 || '%'
            OR EXISTS (SELECT 1 FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND u.email ILIKE '%' || $1 || '%')
         ORDER BY o.created_at DESC LIMIT 500`,
        [search || null],
      )
    ).rows;
    const live = new Set<string>();
    for (const tid of hub.streamingTournaments()) {
      const t = await repo.tournamentById(tid);
      if (t) live.add(t.org_id);
    }
    return {
      orgs: rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at.toISOString(),
        owners: r.owners,
        balance: fromCc(r.balance_cc),
        suspended: r.suspended,
        customPricing: Object.keys(r.overrides ?? {}).length > 0,
        tournaments: r.tournaments,
        liveMinutes: Math.round(r.live_seconds / 60),
        lastTournamentAt: r.last_tournament?.toISOString() ?? null,
        creditsSpent: fromCc(r.spent_cc),
        paidInr: Number(r.paid_inr),
        liveNow: live.has(r.id),
      })),
    };
  });

  app.get('/api/admin/orgs/:id', { preHandler: admin }, async (req) => {
    const orgId = idParam(req);
    const org = await repo.orgById(orgId);
    if (!org) throw new HttpError(404, 'org_not_found', 'Club not found.');
    const b = await billing.orgBilling(orgId);
    const [pricing, settings, members, tournaments, txs, pays] = await Promise.all([
      billing.pricingFor(orgId, b),
      billing.settings(),
      repo.members(orgId),
      q.query(
        `SELECT t.id, t.name, t.venue, t.starts_on, t.archived, t.live_seconds, t.billed_minutes, t.extra_cameras, t.created_at,
                (SELECT count(*) FROM cameras c WHERE c.tournament_id = t.id)::int AS cameras
         FROM tournaments t WHERE t.org_id = $1 ORDER BY t.created_at DESC LIMIT 100`,
        [orgId],
      ),
      billing.transactions(orgId, 100),
      payments.list({ orgId }, 50),
    ]);
    const streaming = new Set(hub.streamingTournaments());
    return {
      org: { id: org.id, name: org.name, createdAt: org.created_at.toISOString() },
      balance: fromCc(b.balance_cc),
      suspended: b.suspended,
      suspendedReason: b.suspended_reason,
      overrides: b.overrides ?? {},
      platformPricing: settings.pricing,
      pricing,
      details: { name: b.billing_name, phone: b.billing_phone, email: b.billing_email, gstin: b.gstin },
      members: members.map((m) => ({ userId: m.user_id, email: m.email, name: m.name, role: m.role })),
      tournaments: tournaments.rows.map((t) => ({
        id: t.id,
        name: t.name,
        venue: t.venue,
        startsOn: t.starts_on,
        archived: t.archived,
        liveMinutes: Math.round(t.live_seconds / 60),
        paidMinutes: Math.max(0, t.billed_minutes),
        cameras: t.cameras,
        extraCameras: t.extra_cameras,
        liveNow: streaming.has(t.id),
      })),
      transactions: txs.map(txDto),
      payments: pays.map(paymentDto),
    };
  });

  app.patch('/api/admin/orgs/:id/billing', { preHandler: admin }, async (req) => {
    const orgId = idParam(req);
    if (!(await repo.orgById(orgId))) throw new HttpError(404, 'org_not_found', 'Club not found.');
    const body = z
      .object({
        overrides: pricingSchema.partial().optional(),
        suspended: z.boolean().optional(),
        suspendedReason: z.string().trim().max(200).nullable().optional(),
      })
      .parse(req.body);
    const b = await billing.updateOrgBilling(orgId, body);
    // A suspension takes effect on live broadcasts straight away.
    if (body.suspended) await billing.tick().catch(() => {});
    return { suspended: b.suspended, suspendedReason: b.suspended_reason, overrides: b.overrides, pricing: await billing.pricingFor(orgId, b) };
  });

  app.post('/api/admin/orgs/:id/credits', { preHandler: admin }, async (req) => {
    const orgId = idParam(req);
    if (!(await repo.orgById(orgId))) throw new HttpError(404, 'org_not_found', 'Club not found.');
    const body = z.object({ credits: z.number().min(-10_000_000).max(10_000_000), note: z.string().trim().min(2).max(200) }).parse(req.body);
    return { balance: await billing.adminAdjust(orgId, body.credits, body.note, by(req)) };
  });

  // ---------------------------------------------------------------- live and payments
  app.get('/api/admin/live', { preHandler: admin }, async () => {
    const out = [];
    for (const tid of hub.streamingTournaments()) {
      const t = await repo.tournamentById(tid);
      if (!t) continue;
      const org = await repo.orgById(t.org_id);
      const s = await billing.tournamentState(t);
      out.push({
        tournamentId: t.id,
        tournamentName: t.name,
        venue: t.venue,
        orgId: t.org_id,
        orgName: org?.name ?? '',
        mode: t.production_mode,
        cameras: s.cameras.used,
        cameraLimit: s.cameras.limit,
        liveMinutes: Math.round(s.minutes.liveSeconds / 60),
        remainingMinutes: s.minutes.remainingSeconds === null ? null : Math.floor(s.minutes.remainingSeconds / 60),
        balance: s.balance,
        grace: s.grace,
        watchUrl: `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/watch/${t.id}`,
      });
    }
    return { live: out };
  });

  app.get('/api/admin/payments', { preHandler: admin }, async (req) => {
    const f = z.object({ status: z.enum(['created', 'paid', 'failed', 'expired']).optional() }).parse(req.query);
    return { payments: (await payments.list({ status: f.status }, 200)).map(paymentDto) };
  });

  /** Ask Cashfree again (a payer says money left their account but no credits arrived). */
  app.post('/api/admin/payments/:id/recheck', { preHandler: admin }, async (req) => {
    const p = await payments.byId(idParam(req));
    if (!p) throw new HttpError(404, 'payment_not_found', 'Payment not found.');
    return { payment: paymentDto(await payments.confirm(p)) };
  });

  // ---------------------------------------------------------------- the Go Live YouTube channel
  /** The platform's own channel: organisers without YouTube go live on it (onboarding P1-6). */
  app.get('/api/admin/golive-channel', { preHandler: admin }, async () => ({
    youtubeConfigured: ctx.youtube.enabled,
    channel: ctx.youtube.enabled ? await ctx.youtube.platformChannel() : null,
  }));

  app.post('/api/admin/golive-channel/connect', { preHandler: admin }, async (req) => ({ url: ctx.youtube.authUrl(PLATFORM, userOf(req).id) }));

  app.patch('/api/admin/golive-channel', { preHandler: admin }, async (req) => {
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    await ctx.youtube.setPlatformEnabled(body.enabled);
    return { channel: await ctx.youtube.platformChannel() };
  });

  app.delete('/api/admin/golive-channel', { preHandler: admin }, async (_req, reply) => {
    await ctx.youtube.disconnectPlatform();
    reply.status(204);
    return null;
  });

  // ---------------------------------------------------------------- administrators
  app.get('/api/admin/admins', { preHandler: admin }, async () => ({
    admins: (await q.query('SELECT id, email, name FROM users WHERE is_platform_admin AND NOT disabled ORDER BY email')).rows,
  }));

  app.post('/api/admin/admins', { preHandler: admin }, async (req) => {
    const body = z.object({ email: z.string().trim().email() }).parse(req.body);
    const u = await repo.userByEmail(body.email);
    if (!u) throw new HttpError(404, 'user_not_found', 'No account with that email. They need to sign up in the app first.');
    await q.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [u.id]);
    return { admin: { id: u.id, email: u.email, name: u.name } };
  });

  app.delete('/api/admin/admins/:id', { preHandler: admin }, async (req, reply) => {
    const id = idParam(req);
    const n = Number((await q.query<{ n: string }>('SELECT count(*)::text AS n FROM users WHERE is_platform_admin AND NOT disabled')).rows[0].n);
    if (n <= 1) throw new HttpError(409, 'last_admin', 'There must be at least one administrator.');
    await q.query('UPDATE users SET is_platform_admin = false WHERE id = $1', [id]);
    reply.status(204);
    return null;
  });
}
