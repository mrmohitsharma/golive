import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';
import { requireAuth, signPrincipal, userOf, type Principal } from '../auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = [path.resolve(here, '../../public/web'), path.resolve(here, '../../../public/web')].find((p) => fs.existsSync(p));
const TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

/** Signed-in platform admin (rights checked against the database by the session check). */
export function adminGuard(ctx: Ctx) {
  const signedIn = requireAuth(ctx.config, 'user');
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await signedIn(req, reply);
    const p = userOf(req);
    if (!p.platformAdmin || p.impersonator) throw new HttpError(403, 'not_admin', 'This page is for Go Live administrators only.');
  };
}

/**
 * The V7 web app (/web): one site for platform admins (everything) and for club owners and
 * directors (their events, team, wallet and the control room). Plain ES modules, no build step.
 */
export function registerWebRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, sessions } = ctx;
  const admin = adminGuard(ctx);
  const user = requireAuth(config, 'user');

  const page = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!webDir) throw new HttpError(500, 'missing_assets', 'Web app assets are missing.');
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "frame-ancestors 'none'");
    return reply.send(fs.readFileSync(path.join(webDir, 'index.html')));
  };
  app.get('/web', page);
  app.get('/web/*', page);
  app.get('/web-assets/:file', async (req, reply) => {
    const file = z.string().regex(/^[\w-]+\.(js|css|svg|png)$/).safeParse((req.params as { file: string }).file);
    if (!file.success || !webDir) throw new HttpError(404, 'not_found', 'Not found.');
    const full = path.join(webDir, file.data);
    if (!fs.existsSync(full)) throw new HttpError(404, 'not_found', 'Not found.');
    reply.type(TYPES[path.extname(full)] ?? 'application/octet-stream');
    reply.header('Cache-Control', 'no-cache');
    return reply.send(fs.readFileSync(full));
  });

  // ---------------------------------------------------------------- audit log
  app.get('/api/admin/audit', { preHandler: admin }, async (req) => {
    const qs = z
      .object({ q: z.string().max(100).optional(), actor: z.string().max(200).optional(), org: z.string().uuid().optional(), before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(req.query);
    const where: string[] = [];
    const vals: unknown[] = [];
    if (qs.q) {
      vals.push(`%${qs.q}%`);
      where.push(`(action ILIKE $${vals.length} OR target_id ILIKE $${vals.length} OR as_user_email ILIKE $${vals.length})`);
    }
    if (qs.actor) {
      vals.push(qs.actor.toLowerCase());
      where.push(`lower(actor_email) = $${vals.length}`);
    }
    if (qs.org) {
      vals.push(qs.org);
      where.push(`org_id = $${vals.length}`);
    }
    if (qs.before) {
      vals.push(qs.before);
      where.push(`id < $${vals.length}`);
    }
    vals.push(qs.limit);
    const rows = (
      await repo.db.query(
        `SELECT id, at, actor_email, as_user_email, action, target_kind, target_id, org_id, status, detail, ip
           FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT $${vals.length}`,
        vals,
      )
    ).rows;
    return {
      entries: rows.map((r) => ({
        id: Number(r.id),
        at: new Date(r.at).toISOString(),
        actor: r.actor_email,
        asUser: r.as_user_email,
        action: r.action,
        targetKind: r.target_kind,
        targetId: r.target_id,
        orgId: r.org_id,
        status: r.status,
        detail: r.detail,
        ip: r.ip,
      })),
    };
  });

  // ---------------------------------------------------------------- log in as (support)
  /** A 1-hour session as this user. Never as another admin. Logged in the audit log. */
  app.post('/api/admin/users/:id/impersonate', { preHandler: admin }, async (req) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const me = userOf(req);
    const u = await repo.userById(id);
    if (!u) throw new HttpError(404, 'not_found', 'User not found.');
    if (u.is_platform_admin) throw new HttpError(400, 'is_admin', 'You cannot log in as another administrator.');
    if (u.disabled) throw new HttpError(400, 'disabled', 'This account is disabled. Enable it first.');
    const principal: Principal = {
      kind: 'user',
      id: u.id,
      email: u.email,
      name: u.name,
      platformAdmin: false,
      ver: u.token_ver ?? 0,
      impersonator: { id: me.id, email: me.email },
    };
    const orgs = await repo.memberships(u.id);
    return {
      token: signPrincipal(config, principal, '1h'),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      user: { id: u.id, email: u.email, name: u.name, platformAdmin: false, impersonatedBy: me.email },
      orgs: orgs.map((o) => ({ id: o.org_id, name: o.org_name, role: o.role })),
    };
  });

  /** Ends a "log in as" session (the audit log records it; the browser drops the token). */
  app.post('/api/impersonation/stop', { preHandler: user }, async (req) => {
    const p = userOf(req);
    if (!p.impersonator) throw new HttpError(400, 'not_impersonating', 'You are not logged in as someone else.');
    return { ok: true };
  });

  /** Signs a user out of every browser and phone. */
  app.post('/api/admin/users/:id/sign-out', { preHandler: admin }, async (req) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    if (!(await repo.userById(id))) throw new HttpError(404, 'not_found', 'User not found.');
    await sessions.signOutEverywhere(id);
    return { ok: true };
  });

  /** The user's own "sign out of all devices". */
  app.post('/api/me/sign-out-everywhere', { preHandler: user }, async (req) => {
    const p = userOf(req);
    if (p.impersonator) throw new HttpError(403, 'impersonating', 'Not available while logged in as someone else.');
    await sessions.signOutEverywhere(p.id);
    return { ok: true };
  });
}
