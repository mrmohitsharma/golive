import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';
import { ORG_ROLES, hashPassword, userOf } from '../auth.js';
import { fromCc } from '../billing.js';
import { adminGuard } from './web.js';

const uuid = z.string().uuid();
const idOf = (req: { params: unknown }, k = 'id') => uuid.parse((req.params as Record<string, string>)[k]);

/** Features an admin can switch off for one club (all on by default). */
export const CLUB_FEATURES = ['cloud', 'viewership'] as const;
export type ClubFeature = (typeof CLUB_FEATURES)[number];
export const featureOn = (features: Record<string, unknown> | null | undefined, f: ClubFeature) => (features ?? {})[f] !== false;

const FEATURE_TEXT: Record<ClubFeature, string> = {
  cloud: 'Cloud production is turned off for your club. Use laptop mode, or contact Go Live support.',
  viewership: 'Influencers & games is turned off for your club. Contact Go Live support.',
};
/** Throws when an admin switched this feature off for the club. */
export async function requireClubFeature(repo: Ctx['repo'], orgId: string, f: ClubFeature): Promise<void> {
  const r = (await repo.db.query('SELECT features FROM orgs WHERE id = $1', [orgId])).rows[0];
  if (r && !featureOn(r.features, f)) throw new HttpError(403, 'feature_off', FEATURE_TEXT[f]);
}

/**
 * V7 super admin (web): dashboard, clubs, users, events across all clubs and the live monitor.
 * Platform admins have owner rights in every club, so club screens and the control room work
 * for them too; these routes add the platform-wide views and controls.
 */
export function registerAdminWebRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, hub, billing, viewership, sessions } = ctx;
  const admin = adminGuard(ctx);
  const q = repo.db;
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, '');

  // ---------------------------------------------------------------- dashboard
  app.get('/api/admin/dashboard', { preHandler: admin }, async () => {
    const live = hub.streamingTournaments();
    let watching = 0;
    let youtube = 0;
    let cameras = 0;
    const warnings: { tournamentId: string; name: string; text: string }[] = [];
    for (const tid of live) {
      watching += viewership.watchingNow(tid).watching;
      youtube += viewership.youtubeViewers(tid) ?? 0;
      const t = await repo.tournamentById(tid);
      const e = hub.engineState(tid);
      for (const w of e.warnings) warnings.push({ tournamentId: tid, name: t?.name ?? '', text: w });
      if (!e.obsConnected) warnings.push({ tournamentId: tid, name: t?.name ?? '', text: 'The broadcast engine (OBS) is not connected.' });
      cameras += Number((await q.query<{ n: string }>('SELECT count(*)::text AS n FROM cameras WHERE tournament_id = $1', [tid])).rows[0].n);
    }
    const period = async (since: string) => {
      const r = (
        await q.query<Record<string, string>>(
          `SELECT
             (SELECT COALESCE(sum(amount_inr), 0) FROM payments WHERE status = 'paid' AND paid_at >= ${since})::text AS revenue,
             (SELECT count(*) FROM payments WHERE status = 'paid' AND paid_at >= ${since})::text AS payments,
             (SELECT count(*) FROM orgs WHERE created_at >= ${since})::text AS clubs,
             (SELECT count(*) FROM users WHERE created_at >= ${since})::text AS users,
             (SELECT count(*) FROM tournaments WHERE created_at >= ${since})::text AS events,
             (SELECT count(*) FROM tournaments WHERE first_live_at >= ${since})::text AS first_live,
             (SELECT COALESCE(-sum(amount_cc), 0) FROM wallet_tx WHERE kind IN ('cameras', 'minutes', 'destinations', 'viewership', 'messages') AND updated_at >= ${since})::text AS spent_cc,
             (SELECT COALESCE(sum(watched_sec), 0) FROM viewers WHERE first_seen_at >= ${since})::text AS watch_sec`,
        )
      ).rows[0];
      return {
        revenueInr: Number(r.revenue),
        payments: Number(r.payments),
        newClubs: Number(r.clubs),
        newUsers: Number(r.users),
        newEvents: Number(r.events),
        eventsWentLive: Number(r.first_live),
        creditsSpent: fromCc(r.spent_cc),
        watchMinutes: Math.round(Number(r.watch_sec) / 60),
      };
    };
    const [today, week, month] = await Promise.all([period("date_trunc('day', now())"), period("now() - interval '7 days'"), period("date_trunc('month', now())")]);
    const series = (
      await q.query<{ d: string; revenue: string; clubs: string; events: string }>(
        `SELECT to_char(d, 'YYYY-MM-DD') AS d,
                (SELECT COALESCE(sum(amount_inr), 0) FROM payments WHERE status = 'paid' AND paid_at::date = d::date)::text AS revenue,
                (SELECT count(*) FROM orgs WHERE created_at::date = d::date)::text AS clubs,
                (SELECT count(*) FROM tournaments WHERE created_at::date = d::date)::text AS events
           FROM generate_series(now() - interval '29 days', now(), interval '1 day') AS d ORDER BY d`,
      )
    ).rows.map((r) => ({ day: r.d, revenueInr: Number(r.revenue), newClubs: Number(r.clubs), newEvents: Number(r.events) }));
    const alerts = (
      await q.query<Record<string, string>>(
        `SELECT
           (SELECT count(*) FROM payments WHERE status = 'failed' AND created_at >= now() - interval '24 hours')::text AS failed_payments,
           (SELECT count(*) FROM payments WHERE status = 'created' AND created_at < now() - interval '30 minutes' AND created_at >= now() - interval '2 days')::text AS stuck_payments,
           (SELECT count(*) FROM messages WHERE status = 'failed' AND created_at >= now() - interval '24 hours')::text AS failed_messages,
           (SELECT count(*) FROM org_billing WHERE suspended)::text AS suspended,
           (SELECT count(*) FROM org_billing b WHERE b.balance_cc < 100 * 100 AND EXISTS (SELECT 1 FROM tournaments t WHERE t.org_id = b.org_id AND NOT t.archived AND t.created_at >= now() - interval '30 days'))::text AS low_balance`,
      )
    ).rows[0];
    return {
      now: { liveEvents: live.length, cameras, watchingOnPage: watching, watchingOnYoutube: youtube },
      today,
      week,
      month,
      series,
      alerts: {
        failedPayments24h: Number(alerts.failed_payments),
        stuckPayments: Number(alerts.stuck_payments),
        failedMessages24h: Number(alerts.failed_messages),
        suspendedClubs: Number(alerts.suspended),
        lowBalanceActiveClubs: Number(alerts.low_balance),
        engineWarnings: warnings,
      },
    };
  });

  // ---------------------------------------------------------------- clubs (edit, owner, features, delete)
  app.get('/api/admin/orgs/:id/extra', { preHandler: admin }, async (req) => {
    const id = idOf(req);
    const r = (await q.query('SELECT features, admin_notes FROM orgs WHERE id = $1', [id])).rows[0];
    if (!r) throw new HttpError(404, 'org_not_found', 'Club not found.');
    return {
      features: Object.fromEntries(CLUB_FEATURES.map((f) => [f, featureOn(r.features, f)])),
      notes: r.admin_notes,
      audit: (await q.query('SELECT id, at, actor_email, as_user_email, action FROM audit_log WHERE org_id = $1 OR target_id = $2 ORDER BY id DESC LIMIT 30', [id, id])).rows.map((a) => ({
        id: Number(a.id),
        at: new Date(a.at).toISOString(),
        actor: a.actor_email,
        asUser: a.as_user_email,
        action: a.action,
      })),
    };
  });

  app.patch('/api/admin/orgs/:id', { preHandler: admin }, async (req) => {
    const id = idOf(req);
    const b = z
      .object({
        name: z.string().trim().min(2).max(100).optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
        features: z.object(Object.fromEntries(CLUB_FEATURES.map((f) => [f, z.boolean()])) as Record<ClubFeature, z.ZodBoolean>).partial().optional(),
      })
      .parse(req.body);
    const cur = (await q.query('SELECT features FROM orgs WHERE id = $1', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'org_not_found', 'Club not found.');
    const features = { ...(cur.features ?? {}), ...(b.features ?? {}) };
    if (b.features?.viewership === false) await q.query('UPDATE tournaments SET viewership_on_at = NULL WHERE org_id = $1', [id]);
    await q.query(
      `UPDATE orgs SET name = COALESCE($2, name), admin_notes = CASE WHEN $3::boolean THEN $4 ELSE admin_notes END, features = $5 WHERE id = $1`,
      [id, b.name ?? null, b.notes !== undefined, b.notes ?? null, JSON.stringify(features)],
    );
    return { ok: true, features: Object.fromEntries(CLUB_FEATURES.map((f) => [f, featureOn(features, f)])) };
  });

  /** Adds someone (by email) to a club with a role, or changes their role. */
  app.post('/api/admin/orgs/:id/members', { preHandler: admin }, async (req) => {
    const id = idOf(req);
    const b = z.object({ email: z.string().trim().email(), role: z.enum(ORG_ROLES) }).parse(req.body);
    if (!(await repo.orgById(id))) throw new HttpError(404, 'org_not_found', 'Club not found.');
    const u = await repo.userByEmail(b.email);
    if (!u) throw new HttpError(404, 'user_not_found', 'No account with that email. Create the user first (Users > Add user).');
    await q.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [id, u.id, b.role],
    );
    return { ok: true };
  });

  /** Makes this member the owner; other owners become directors (one owner per club). */
  app.post('/api/admin/orgs/:id/transfer', { preHandler: admin }, async (req) => {
    const id = idOf(req);
    const b = z.object({ userId: uuid }).parse(req.body);
    await repo.tx(async (c) => {
      const m = await c.query('SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2', [id, b.userId]);
      if (!m.rowCount) throw new HttpError(404, 'not_member', 'That person is not in this club. Add them first.');
      await c.query(`UPDATE org_members SET role = 'director' WHERE org_id = $1 AND role = 'owner' AND user_id <> $2`, [id, b.userId]);
      await c.query(`UPDATE org_members SET role = 'owner' WHERE org_id = $1 AND user_id = $2`, [id, b.userId]);
    });
    return { ok: true };
  });

  app.delete('/api/admin/orgs/:id', { preHandler: admin }, async (req, reply) => {
    const id = idOf(req);
    const b = z.object({ confirmName: z.string() }).parse(req.body ?? {});
    const org = await repo.orgById(id);
    if (!org) throw new HttpError(404, 'org_not_found', 'Club not found.');
    if (b.confirmName.trim() !== org.name) throw new HttpError(400, 'confirm_name', 'Type the club name exactly to delete it.');
    const tids = (await q.query<{ id: string }>('SELECT id FROM tournaments WHERE org_id = $1', [id])).rows.map((r) => r.id);
    if (tids.some((t) => hub.streamingTournaments().includes(t))) throw new HttpError(409, 'live', 'This club is live right now. Stop the broadcast first.');
    await q.query('DELETE FROM orgs WHERE id = $1', [id]);
    reply.status(204);
    return null;
  });

  // ---------------------------------------------------------------- users
  const userDto = (r: Record<string, any>) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    login: r.google_sub ? (r.password_hash ? 'Google + password' : 'Google') : 'Password',
    platformAdmin: r.is_platform_admin,
    disabled: r.disabled,
    createdAt: new Date(r.created_at).toISOString(),
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
    clubs: r.clubs ?? [],
  });
  const usersSql = `SELECT u.*, COALESCE((SELECT json_agg(json_build_object('id', o.id, 'name', o.name, 'role', m.role) ORDER BY o.name)
                                FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = u.id), '[]') AS clubs FROM users u`;

  app.get('/api/admin/users', { preHandler: admin }, async (req) => {
    const f = z.object({ q: z.string().trim().max(100).optional(), filter: z.enum(['all', 'admins', 'disabled', 'no-club']).default('all') }).parse(req.query);
    const where: string[] = [];
    const vals: unknown[] = [];
    if (f.q) {
      vals.push(`%${f.q}%`);
      where.push(`(u.email ILIKE $1 OR u.name ILIKE $1)`);
    }
    if (f.filter === 'admins') where.push('u.is_platform_admin');
    if (f.filter === 'disabled') where.push('u.disabled');
    if (f.filter === 'no-club') where.push('NOT EXISTS (SELECT 1 FROM org_members m WHERE m.user_id = u.id)');
    const rows = (await q.query(`${usersSql} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.created_at DESC LIMIT 500`, vals)).rows;
    return { users: rows.map(userDto) };
  });

  app.get('/api/admin/users/:id', { preHandler: admin }, async (req) => {
    const id = idOf(req);
    const r = (await q.query(`${usersSql} WHERE u.id = $1`, [id])).rows[0];
    if (!r) throw new HttpError(404, 'not_found', 'User not found.');
    const audit = (await q.query('SELECT id, at, actor_email, as_user_email, action FROM audit_log WHERE target_id = $1::text OR as_user_id = $1::uuid OR actor_id = $1::uuid ORDER BY id DESC LIMIT 30', [id])).rows;
    return {
      user: userDto(r),
      audit: audit.map((a) => ({ id: Number(a.id), at: new Date(a.at).toISOString(), actor: a.actor_email, asUser: a.as_user_email, action: a.action })),
    };
  });

  /** Creates an account (e.g. an invite-only launch); returns a one-time password to hand over. */
  app.post('/api/admin/users', { preHandler: admin }, async (req, reply) => {
    const b = z
      .object({ email: z.string().trim().toLowerCase().email(), name: z.string().trim().min(1).max(80), clubName: z.string().trim().min(2).max(100).nullish() })
      .parse(req.body);
    if (await repo.userByEmail(b.email)) throw new HttpError(409, 'email_taken', 'An account with that email already exists.');
    const password = tempPassword();
    const u = await repo.tx(async (c) => {
      const user = await repo.createUser({ email: b.email, name: b.name, passwordHash: await hashPassword(password) }, c);
      if (b.clubName) {
        const org = await repo.createOrg(b.clubName, c);
        await repo.addMember(org.id, user.id, 'owner', c);
      }
      return user;
    });
    reply.status(201);
    return { user: { id: u.id, email: u.email, name: u.name }, password };
  });

  app.patch('/api/admin/users/:id', { preHandler: admin }, async (req) => {
    const id = idOf(req);
    const me = userOf(req);
    const b = z
      .object({ name: z.string().trim().min(1).max(80).optional(), email: z.string().trim().toLowerCase().email().optional(), disabled: z.boolean().optional(), platformAdmin: z.boolean().optional() })
      .parse(req.body);
    const u = await repo.userById(id);
    if (!u) throw new HttpError(404, 'not_found', 'User not found.');
    if (id === me.id && (b.disabled || b.platformAdmin === false)) throw new HttpError(400, 'self', 'You cannot disable yourself or remove your own admin access.');
    if (b.email && b.email !== u.email && (await repo.userByEmail(b.email))) throw new HttpError(409, 'email_taken', 'Another account already uses that email.');
    if (b.platformAdmin === false && u.is_platform_admin) {
      const n = Number((await q.query<{ n: string }>('SELECT count(*)::text AS n FROM users WHERE is_platform_admin AND NOT disabled')).rows[0].n);
      if (n <= 1) throw new HttpError(409, 'last_admin', 'There must be at least one administrator.');
    }
    await q.query(
      `UPDATE users SET name = COALESCE($2, name), email = COALESCE($3, email), disabled = COALESCE($4, disabled), is_platform_admin = COALESCE($5, is_platform_admin),
              token_ver = token_ver + CASE WHEN $4::boolean IS TRUE OR $3::text IS NOT NULL THEN 1 ELSE 0 END
        WHERE id = $1`,
      [id, b.name ?? null, b.email ?? null, b.disabled ?? null, b.platformAdmin ?? null],
    );
    sessions.forget(id);
    return { ok: true };
  });

  /** Sets a new temporary password (shown once) and signs the user out everywhere. */
  app.post('/api/admin/users/:id/reset-password', { preHandler: admin }, async (req) => {
    const id = idOf(req);
    if (!(await repo.userById(id))) throw new HttpError(404, 'not_found', 'User not found.');
    const password = tempPassword();
    await q.query('UPDATE users SET password_hash = $2, token_ver = token_ver + 1 WHERE id = $1', [id, await hashPassword(password)]);
    sessions.forget(id);
    return { password };
  });

  /** Deletes an account (DPDP request). Clubs where they are the only owner must be handed over or deleted first. */
  app.delete('/api/admin/users/:id', { preHandler: admin }, async (req, reply) => {
    const id = idOf(req);
    if (id === userOf(req).id) throw new HttpError(400, 'self', 'You cannot delete your own account here.');
    const sole = (
      await q.query<{ name: string }>(
        `SELECT o.name FROM org_members m JOIN orgs o ON o.id = m.org_id
          WHERE m.user_id = $1 AND m.role = 'owner'
            AND NOT EXISTS (SELECT 1 FROM org_members m2 WHERE m2.org_id = m.org_id AND m2.role = 'owner' AND m2.user_id <> $1)`,
        [id],
      )
    ).rows;
    if (sole.length) throw new HttpError(409, 'sole_owner', `They are the only owner of ${sole.map((s) => s.name).join(', ')}. Transfer or delete the club first.`);
    await q.query('DELETE FROM users WHERE id = $1', [id]);
    sessions.forget(id);
    reply.status(204);
    return null;
  });

  // ---------------------------------------------------------------- events across all clubs
  app.get('/api/admin/events', { preHandler: admin }, async (req) => {
    const f = z
      .object({ q: z.string().trim().max(100).optional(), status: z.enum(['all', 'live', 'active', 'archived']).default('all'), org: uuid.optional() })
      .parse(req.query);
    const where: string[] = [];
    const vals: unknown[] = [];
    if (f.q) {
      vals.push(`%${f.q}%`);
      where.push(`(t.name ILIKE $${vals.length} OR o.name ILIKE $${vals.length} OR t.venue ILIKE $${vals.length})`);
    }
    if (f.org) {
      vals.push(f.org);
      where.push(`t.org_id = $${vals.length}`);
    }
    const live = new Set(hub.streamingTournaments());
    if (f.status === 'live') {
      vals.push([...live]);
      where.push(`t.id = ANY($${vals.length}::uuid[])`);
    }
    if (f.status === 'active') where.push('NOT t.archived');
    if (f.status === 'archived') where.push('t.archived');
    const rows = (
      await q.query(
        `SELECT t.id, t.name, t.venue, t.starts_on, t.archived, t.event_type, t.production_mode, t.public_watch, t.created_at, t.first_live_at,
                t.live_seconds, t.billed_minutes, t.viewership_on_at, t.org_id, o.name AS org_name,
                (SELECT count(*) FROM cameras c WHERE c.tournament_id = t.id)::int AS cameras,
                (SELECT count(*) FROM viewers v WHERE v.tournament_id = t.id AND NOT v.flagged)::int AS viewers,
                (SELECT COALESCE(sum(v.watched_sec), 0) FROM viewers v WHERE v.tournament_id = t.id AND NOT v.flagged)::bigint AS watch_sec
           FROM tournaments t JOIN orgs o ON o.id = t.org_id
           ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY t.created_at DESC LIMIT 500`,
        vals,
      )
    ).rows;
    return {
      events: rows.map((t) => ({
        id: t.id,
        name: t.name,
        venue: t.venue,
        startsOn: t.starts_on,
        archived: t.archived,
        eventType: t.event_type ?? 'golf',
        mode: t.production_mode,
        publicWatch: t.public_watch !== false,
        createdAt: new Date(t.created_at).toISOString(),
        firstLiveAt: t.first_live_at ? new Date(t.first_live_at).toISOString() : null,
        liveMinutes: Math.round(t.live_seconds / 60),
        paidMinutes: Math.max(0, t.billed_minutes),
        addonOn: Boolean(t.viewership_on_at),
        orgId: t.org_id,
        orgName: t.org_name,
        cameras: t.cameras,
        viewers: t.viewers,
        watchMinutes: Math.round(Number(t.watch_sec) / 60),
        liveNow: live.has(t.id),
        watchUrl: `${base}/watch/${t.id}`,
      })),
    };
  });

  /** Emergency: ends the broadcast on every platform now (the engine stops streaming). */
  app.post('/api/admin/events/:id/stop', { preHandler: admin }, async (req) => {
    const id = idOf(req);
    const t = await repo.tournamentById(id);
    if (!t) throw new HttpError(404, 'not_found', 'Event not found.');
    hub.systemStop(id);
    hub.alert(id, 'error', 'A Go Live administrator ended this broadcast.');
    return { ok: true };
  });

  // ---------------------------------------------------------------- live monitor
  app.get('/api/admin/live-monitor', { preHandler: admin }, async () => {
    const out = [];
    for (const tid of hub.streamingTournaments()) {
      const t = await repo.tournamentById(tid);
      if (!t) continue;
      const org = await repo.orgById(t.org_id);
      const e = hub.engineState(tid);
      const s = await billing.tournamentState(t);
      const cams = (await q.query<{ id: string; name: string }>('SELECT id, name FROM cameras WHERE tournament_id = $1 ORDER BY created_at', [tid])).rows;
      const onAir = cams.find((c) => c.id === e.programmeCameraId);
      out.push({
        tournamentId: t.id,
        name: t.name,
        orgId: t.org_id,
        orgName: org?.name ?? '',
        mode: t.production_mode,
        engineConnected: e.connected && e.obsConnected,
        streaming: e.streaming,
        onAir: e.fallbackActive ? 'Fallback screen' : e.replayActive ? 'Replay' : onAir?.name ?? null,
        onAirCameraId: e.fallbackActive || e.replayActive ? null : (onAir?.id ?? null),
        warnings: e.warnings,
        cameras: cams.length,
        watchingOnPage: viewership.watchingNow(tid).watching,
        watchingOnYoutube: viewership.youtubeViewers(tid),
        liveMinutes: Math.round(s.minutes.liveSeconds / 60),
        remainingMinutes: s.minutes.remainingSeconds === null ? null : Math.floor(s.minutes.remainingSeconds / 60),
        balance: s.balance,
        watchUrl: `${base}/watch/${t.id}`,
      });
    }
    return { live: out };
  });
}

/** 12 characters, easy to read out (no 0/O, 1/l). */
function tempPassword(): string {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(12), (b) => a[b % a.length]).join('');
}
