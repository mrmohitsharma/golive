import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Principal } from './auth.js';
import type { Repo, UserRow } from './repo.js';

type UserPrincipal = Extract<Principal, { kind: 'user' }>;

/** Keys in request bodies that never go into the audit log. */
const SECRET = /pass|secret|token|key|otp|hash|card|cvv/i;

function scrub(v: unknown, depth = 0): unknown {
  if (v == null || typeof v !== 'object') return typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v;
  if (depth > 3) return '…';
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => scrub(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET.test(k) ? '[hidden]' : scrub(x, depth + 1);
  return out;
}

/**
 * Sessions you can take back, and the audit log (V7 web).
 *  - Every user token is checked against the database (cached for 10 s): disabled accounts,
 *    "sign out everywhere" (users.token_ver) and removed admin rights take effect at once.
 *  - Every change made by a platform admin, or by an admin logged in as someone, is logged.
 */
export class Sessions {
  private cache = new Map<string, { at: number; row: UserRow | null }>();

  constructor(private readonly repo: Repo, private readonly ttlMs = 10_000) {}

  forget(userId: string): void {
    this.cache.delete(userId);
  }

  private async user(id: string): Promise<UserRow | null> {
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.row;
    const row = await this.repo.userById(id);
    this.cache.set(id, { at: Date.now(), row });
    if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value!);
    return row;
  }

  /** The principal as the database sees it now, or null when the session is no longer valid. */
  async check(p: UserPrincipal): Promise<Principal | null> {
    const u = await this.user(p.id);
    if (!u || u.disabled) return null;
    if ((u.token_ver ?? 0) !== (p.ver ?? 0)) return null;
    if (p.impersonator) {
      const admin = await this.user(p.impersonator.id);
      if (!admin || admin.disabled || !admin.is_platform_admin) return null;
      return { ...p, platformAdmin: false };
    }
    return { ...p, platformAdmin: u.is_platform_admin, name: u.name, email: u.email };
  }

  /** Signs a user out of every device (and the app). */
  async signOutEverywhere(userId: string): Promise<void> {
    await this.repo.db.query('UPDATE users SET token_ver = token_ver + 1 WHERE id = $1', [userId]);
    this.forget(userId);
  }

  async write(entry: {
    actor: { id: string | null; email: string };
    asUser?: { id: string; email: string } | null;
    action: string;
    targetKind?: string | null;
    targetId?: string | null;
    orgId?: string | null;
    status?: number | null;
    detail?: unknown;
    ip?: string | null;
  }): Promise<void> {
    await this.repo.db.query(
      `INSERT INTO audit_log (actor_id, actor_email, as_user_id, as_user_email, action, target_kind, target_id, org_id, status, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entry.actor.id,
        entry.actor.email,
        entry.asUser?.id ?? null,
        entry.asUser?.email ?? null,
        entry.action,
        entry.targetKind ?? null,
        entry.targetId ?? null,
        entry.orgId ?? null,
        entry.status ?? null,
        JSON.stringify(scrub(entry.detail ?? {})),
        entry.ip ?? null,
      ],
    );
  }

  /**
   * onSend hook (before the reply leaves, so a change is logged before anyone sees it done): logs every change (not GET) made by a platform admin, or while an admin is
   * logged in as someone else. Reads stay out of the log; refused requests are logged too.
   */
  hook = async (req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> => {
    const p = req.principal;
    if (!p || p.kind !== 'user' || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return payload;
    if (!p.platformAdmin && !p.impersonator) return payload;
    const route = req.routeOptions?.url ?? req.url.split('?')[0];
    if ((req as { auditDone?: boolean }).auditDone) return payload;
    (req as { auditDone?: boolean }).auditDone = true;
    const params = (req.params ?? {}) as Record<string, string>;
    const targetId = params.id ?? params.wid ?? params.mid ?? params.iid ?? null;
    const kind = /\/orgs\//.test(route) ? 'org' : /\/users\//.test(route) ? 'user' : /\/tournaments\//.test(route) ? 'tournament' : /\/payments\//.test(route) ? 'payment' : null;
    await this.write({
      actor: p.impersonator ? { id: p.impersonator.id, email: p.impersonator.email } : { id: p.id, email: p.email },
      asUser: p.impersonator ? { id: p.id, email: p.email } : null,
      action: `${req.method} ${route}`,
      targetKind: kind,
      targetId,
      orgId: kind === 'org' ? targetId : null,
      status: reply.statusCode,
      detail: { params, body: req.body ?? null },
      ip: req.ip,
    }).catch((err) => req.log.warn({ err }, 'audit log write failed'));
    return payload;
  };
}
