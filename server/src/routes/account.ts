import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';
import { hashPassword, requireAuth, signPrincipal, userOf, verifyPassword } from '../auth.js';
import type { SmtpSettings } from '../email.js';
import { maskSecret } from '../secrets.js';
import { adminGuard } from './web.js';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const password = z.string().min(8, 'Use at least 8 characters.').max(200);

/**
 * V7: your own account (name, password, forgot password) and the email (SMTP) settings.
 */
export function registerAccountRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, mailer, sessions } = ctx;
  const user = requireAuth(config, 'user');
  const admin = adminGuard(ctx);
  const base = () => config.PUBLIC_BASE_URL.replace(/\/$/, '');

  // ---------------------------------------------------------------- your account
  app.patch('/api/me', { preHandler: user }, async (req) => {
    const p = userOf(req);
    const b = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    await repo.db.query('UPDATE users SET name = $2 WHERE id = $1', [p.id, b.name]);
    sessions.forget(p.id);
    return { ok: true, name: b.name };
  });

  /**
   * Changes (or, for Google-only accounts, sets) the password. Other devices are signed out;
   * this one gets a new token.
   */
  app.post('/api/me/password', { preHandler: user }, async (req) => {
    const p = userOf(req);
    if (p.impersonator) throw new HttpError(403, 'impersonating', 'Not available while logged in as someone else.');
    const b = z.object({ currentPassword: z.string().max(200).optional(), newPassword: password }).parse(req.body);
    const u = (await repo.userById(p.id))!;
    if (u.password_hash && !(b.currentPassword && (await verifyPassword(b.currentPassword, u.password_hash)))) {
      throw new HttpError(400, 'wrong_password', 'Your current password is not right.');
    }
    const r = await repo.db.query<{ token_ver: number }>('UPDATE users SET password_hash = $2, token_ver = token_ver + 1 WHERE id = $1 RETURNING token_ver', [
      p.id,
      await hashPassword(b.newPassword),
    ]);
    sessions.forget(p.id);
    return { ok: true, token: signPrincipal(config, { kind: 'user', id: u.id, email: u.email, name: u.name, platformAdmin: u.is_platform_admin, ver: r.rows[0].token_ver }) };
  });

  // ---------------------------------------------------------------- forgot password
  /** Always answers the same, so it does not reveal which emails have accounts. */
  app.post('/api/auth/forgot', async (req) => {
    const b = z.object({ email: z.string().trim().toLowerCase().email() }).parse(req.body);
    const u = await repo.userByEmail(b.email);
    if (u && !u.disabled) {
      const recent = Number((await repo.db.query<{ n: string }>("SELECT count(*)::text AS n FROM password_resets WHERE user_id = $1 AND created_at >= now() - interval '1 hour'", [u.id])).rows[0].n);
      if (recent < 3) {
        const token = crypto.randomBytes(24).toString('base64url');
        await repo.db.query("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sha(token), u.id]);
        await mailer.send({
          to: u.email,
          kind: 'password_reset',
          subject: `Reset your ${config.BRAND_NAME} password`,
          body: [`Hi ${u.name.split(' ')[0]},`, 'Someone (hopefully you) asked to reset your password. The link works for 1 hour, once.', 'If it was not you, ignore this email: your password stays the same.'],
          button: { text: 'Choose a new password', url: `${base()}/reset-password?token=${token}` },
        });
      }
    }
    return { ok: true, message: 'If that email has an account, a reset link is on its way. Check your inbox (and spam) in a minute.' };
  });

  app.post('/api/auth/reset', async (req) => {
    const b = z.object({ token: z.string().min(20).max(100), password }).parse(req.body);
    const r = await repo.tx(async (c) => {
      const row = (
        await c.query<{ user_id: string }>('UPDATE password_resets SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id', [sha(b.token)])
      ).rows[0];
      if (!row) throw new HttpError(400, 'reset_link_invalid', 'This reset link has expired or was already used. Ask for a new one.');
      await c.query('UPDATE users SET password_hash = $2, token_ver = token_ver + 1 WHERE id = $1', [row.user_id, await hashPassword(b.password)]);
      return row;
    });
    sessions.forget(r.user_id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- email (SMTP) settings
  const smtpDto = () => {
    const s = mailer.saved;
    return {
      live: mailer.live,
      host: s?.host ?? '',
      port: s?.port ?? 587,
      secure: s?.secure ?? false,
      user: s?.user ?? '',
      pass: maskSecret(s?.pass),
      fromName: s?.fromName ?? config.BRAND_NAME,
      fromEmail: s?.fromEmail ?? '',
      replyTo: s?.replyTo ?? config.SUPPORT_EMAIL ?? null,
      enabled: s?.enabled ?? false,
    };
  };
  app.get('/api/admin/email', { preHandler: admin }, async () => smtpDto());
  const smtpBody = z.object({
    host: z.string().trim().min(3).max(200),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    user: z.string().trim().max(300),
    pass: z.string().max(500).optional(),
    fromName: z.string().trim().min(1).max(80),
    fromEmail: z.string().trim().email(),
    replyTo: z.string().trim().email().nullish().or(z.literal('').transform(() => null)),
    enabled: z.boolean(),
  });
  app.put('/api/admin/email', { preHandler: admin }, async (req) => {
    const b = smtpBody.parse(req.body);
    const v: SmtpSettings = { ...b, pass: b.pass || mailer.saved?.pass || '', replyTo: b.replyTo ?? null };
    await ctx.secrets.set('smtp', v, userOf(req).id);
    await mailer.reload();
    return smtpDto();
  });
  app.post('/api/admin/email/test', { preHandler: admin }, async (req) => {
    const b = z.object({ to: z.string().trim().email() }).parse(req.body);
    const ok = await mailer.send({ to: b.to, kind: 'test', subject: `Test email from ${config.BRAND_NAME}`, body: ['If you can read this, email is set up correctly.'] });
    const last = (await repo.db.query('SELECT status, error FROM emails ORDER BY id DESC LIMIT 1')).rows[0];
    return { ok, status: last?.status, error: last?.error ?? null };
  });
  app.get('/api/admin/emails', { preHandler: admin }, async (req) => {
    const f = z.object({ status: z.enum(['sent', 'failed', 'not_sent']).optional(), kind: z.string().max(40).optional() }).parse(req.query);
    const w: string[] = [];
    const v: unknown[] = [];
    if (f.status) (v.push(f.status), w.push(`e.status = $${v.length}`));
    if (f.kind) (v.push(f.kind), w.push(`e.kind = $${v.length}`));
    const rows = (await repo.db.query(`SELECT e.*, o.name AS club FROM emails e LEFT JOIN orgs o ON o.id = e.org_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY e.id DESC LIMIT 300`, v)).rows;
    return { emails: rows.map((e) => ({ id: Number(e.id), at: new Date(e.created_at).toISOString(), to: e.to_email, subject: e.subject, kind: e.kind, status: e.status, error: e.error, club: e.club })) };
  });
}
