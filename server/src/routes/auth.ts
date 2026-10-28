import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';
import { hashPassword, requireAuth, signPrincipal, verifyPassword, type Principal } from '../auth.js';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { eventProfile } from '../event-types.js';
import { constantTimeEqual, guestId, normaliseJoinCode } from '../crypto.js';

const email = z.string().trim().email().max(200);
const password = z.string().min(8, 'Password must be at least 8 characters').max(200);

export function registerAuthRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, googleSignIn } = ctx;

  const sessionFor = async (u: { id: string; email: string; name: string; is_platform_admin: boolean }) => {
    const principal: Principal = { kind: 'user', id: u.id, email: u.email, name: u.name, platformAdmin: u.is_platform_admin };
    const orgs = await repo.memberships(u.id);
    return {
      token: signPrincipal(config, principal),
      user: { id: u.id, email: u.email, name: u.name, platformAdmin: u.is_platform_admin },
      orgs: orgs.map((o) => ({ id: o.org_id, name: o.org_name, role: o.role })),
    };
  };

  /** Self-serve: an organiser creates an account and their club in one step. */
  app.post('/api/auth/signup', async (req, reply) => {
    if (!config.SIGNUP_ENABLED) throw new HttpError(403, 'signup_disabled', 'Sign-up is closed on this server. Ask an organiser to add you.');
    const body = z
      .object({ name: z.string().trim().min(1).max(80), email, password, orgName: z.string().trim().min(2).max(100) })
      .parse(req.body);
    if (await repo.userByEmail(body.email)) throw new HttpError(409, 'email_taken', 'An account with that email already exists. Sign in instead.');
    const passwordHash = await hashPassword(body.password);
    const user = await repo.tx(async (c) => {
      const u = await repo.createUser({ email: body.email, name: body.name, passwordHash }, c);
      const org = await repo.createOrg(body.orgName, c);
      await repo.addMember(org.id, u.id, 'owner', c);
      return u;
    });
    reply.status(201);
    return sessionFor(user);
  });

  app.post('/api/auth/login', async (req) => {
    const body = z.object({ email, password: z.string().min(1) }).parse(req.body);
    const u = await repo.userByEmail(body.email);
    if (u && !u.disabled && !u.password_hash) {
      throw new HttpError(401, 'use_google', 'This account signs in with Google. Tap “Continue with Google”.');
    }
    if (!u || u.disabled || !u.password_hash || !(await verifyPassword(body.password, u.password_hash))) {
      throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
    }
    return sessionFor(u);
  });

  /** What sign-in options this server offers (the website and app read it to show the Google button). */
  app.get('/api/auth/config', async () => ({
    signupEnabled: config.SIGNUP_ENABLED,
    google: googleSignIn.enabled ? { clientId: googleSignIn.webClientId } : null,
  }));

  /**
   * Sign in with Google (app and website), one step for new and returning organisers.
   * Finds the account by Google identity, else links the account with the same (Google-verified)
   * email, else creates one. A new account has no organisation yet unless `orgName` is given;
   * the app and website ask for its name on the next screen (POST /api/orgs).
   */
  app.post('/api/auth/google', async (req, reply) => {
    const body = z.object({ idToken: z.string().min(20).max(4096), orgName: z.string().trim().min(2).max(100).optional() }).parse(req.body);
    const id = await googleSignIn.verify(body.idToken);
    let newUser = false;
    const user = await repo.tx(async (c) => {
      let u = await repo.userByGoogleSub(id.sub, c);
      if (!u) {
        const byEmail = await repo.userByEmail(id.email, c);
        if (byEmail) u = await repo.linkGoogle(byEmail.id, id.sub, c);
      }
      if (!u) {
        if (!config.SIGNUP_ENABLED) throw new HttpError(403, 'signup_disabled', 'Sign-up is closed on this server. Ask an organiser to add you.');
        u = await repo.createUser({ email: id.email, name: id.name, passwordHash: null, googleSub: id.sub }, c);
        newUser = true;
        if (body.orgName) {
          const org = await repo.createOrg(body.orgName, c);
          await repo.addMember(org.id, u.id, 'owner', c);
        }
      }
      return u;
    });
    if (user.disabled) throw new HttpError(401, 'account_disabled', 'This account is disabled. Contact support.');
    if (newUser) reply.status(201);
    return { ...(await sessionFor(user)), newUser };
  });

  // ---------------------------------------------------------------- web-to-app handoff (QR)
  const HANDOFF_TTL_MS = 5 * 60_000;
  const hashCode = (code: string) => crypto.createHash('sha256').update(code).digest('hex');
  const base = () => config.PUBLIC_BASE_URL.replace(/\/$/, '');

  /** Signed in on the website: a one-time code (as a QR) that signs the app in to the same account. */
  app.post('/api/auth/handoff', { preHandler: requireAuth(config, 'user') }, async (req, reply) => {
    const p = req.principal!;
    if (p.kind !== 'user') throw new HttpError(403, 'forbidden', 'Only accounts can do this.');
    const code = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS);
    await repo.db.query('DELETE FROM auth_handoffs WHERE expires_at < now() - interval \'1 day\'');
    await repo.db.query('INSERT INTO auth_handoffs (code_hash, user_id, expires_at) VALUES ($1, $2, $3)', [hashCode(code), p.id, expiresAt]);
    const url = `${base()}/app/login/${code}`;
    reply.status(201);
    return { code, url, expiresAt: expiresAt.toISOString(), qrSvg: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
  });

  /** The app exchanges a scanned handoff code for a session, once. */
  app.post('/api/auth/handoff/redeem', async (req) => {
    const body = z.object({ code: z.string().min(20).max(100) }).parse(req.body);
    const row = (
      await repo.db.query<{ user_id: string }>(
        `UPDATE auth_handoffs SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
        [hashCode(body.code)],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, 'handoff_invalid', 'That QR code has expired or was already used. Show a new one on the website (Account page).');
    const u = await repo.userById(row.user_id);
    if (!u || u.disabled) throw new HttpError(401, 'account_disabled', 'This account is disabled. Contact support.');
    return sessionFor(u);
  });

  /** A handoff QR opened by the phone's own camera app: point to the Go Live app. */
  app.get('/app/login/:code', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    const brand = config.BRAND_NAME.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Log in to ${brand}</title>
<style>body{font-family:system-ui,-apple-system,Roboto,sans-serif;background:#0b0e10;color:#fff;margin:0;padding:24px;max-width:520px}.muted{color:#aab4ad}ol{padding-left:20px;line-height:1.7}</style></head><body>
<h1>Log in to the ${brand} app</h1><ol><li>Install <b>${brand}</b> from Google Play or the App Store and open it.</li><li>Tap <b>Sign in</b>, then <b>Scan QR from website</b>, and scan the code on your computer screen again.</li></ol>
<p class="muted">The code works once and expires 5 minutes after it was shown.</p></body></html>`;
  });

  app.get('/api/me', { preHandler: requireAuth(config) }, async (req) => {
    const p = req.principal!;
    if (p.kind === 'user') {
      const u = await repo.userById(p.id);
      if (!u || u.disabled) throw new HttpError(401, 'unauthorized', 'Sign in again.');
      const orgs = await repo.memberships(u.id);
      return {
        principal: { kind: 'user', id: u.id, email: u.email, name: u.name, platformAdmin: u.is_platform_admin },
        orgs: orgs.map((o) => ({ id: o.org_id, name: o.org_name, role: o.role })),
      };
    }
    const t = await repo.tournamentById(p.tournamentId);
    if (!t || t.archived) throw new HttpError(401, 'unauthorized', 'This tournament has ended. Join again with a new code.');
    return {
      principal: { kind: p.kind, id: p.id, name: p.name, role: p.kind === 'guest' ? p.role : 'engine' },
      tournament: { id: t.id, name: t.name, venue: t.venue, eventType: t.event_type ?? 'golf', profile: eventProfile(t.event_type) },
      orgs: [],
    };
  });

  /**
   * Volunteers join a tournament with the code printed on the QR poster. No account:
   * the token is scoped to that tournament and role. The device id keeps the same
   * identity (and camera slot) if the volunteer rejoins.
   */
  app.post('/api/join', async (req) => {
    const body = z
      .object({ code: z.string().min(4).max(20), deviceId: z.string().min(8).max(128), name: z.string().trim().min(1).max(60) })
      .parse(req.body);
    const jc = await repo.joinCode(normaliseJoinCode(body.code));
    if (!jc || jc.revoked || (jc.expires_at && jc.expires_at.getTime() < Date.now())) {
      throw new HttpError(404, 'invalid_code', 'That code is not valid. Check it with the organiser.');
    }
    const t = await repo.tournamentById(jc.tournament_id);
    if (!t || t.archived) throw new HttpError(404, 'invalid_code', 'That tournament has ended.');
    await repo.useJoinCode(jc.code);
    const principal: Principal = { kind: 'guest', id: guestId(t.id, body.deviceId), name: body.name, tournamentId: t.id, role: jc.role };
    return {
      token: signPrincipal(config, principal),
      role: jc.role,
      guest: { id: principal.id, name: body.name },
      tournament: { id: t.id, name: t.name, venue: t.venue, eventType: t.event_type ?? 'golf', profile: eventProfile(t.event_type) },
    };
  });

  /** The OBS agent (laptop or cloud) exchanges the tournament's engine key for a token. */
  app.post('/api/engine/token', async (req) => {
    const body = z.object({ tournamentId: z.string().uuid(), engineKey: z.string().min(16) }).parse(req.body);
    const t = await repo.tournamentById(body.tournamentId);
    if (!t || !constantTimeEqual(body.engineKey, t.engine_key)) {
      throw new HttpError(401, 'invalid_engine_key', 'Engine key or tournament ID is wrong. Copy them again from Tournament > Engine setup.');
    }
    return {
      token: signPrincipal(config, { kind: 'engine', id: `engine-${t.id.slice(0, 8)}`, name: 'Broadcast engine', tournamentId: t.id }),
      tournament: { id: t.id, name: t.name, mode: t.production_mode },
    };
  });

  /** What a phone's own camera app opens after scanning the QR poster. */
  app.get('/join/:code', async (req, reply) => {
    const code = normaliseJoinCode((req.params as { code: string }).code);
    const jc = await repo.joinCode(code);
    const t = jc && !jc.revoked ? await repo.tournamentById(jc.tournament_id) : null;
    const server = config.PUBLIC_BASE_URL.replace(/\/$/, '');
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const role = jc ? { camera: 'Camera operator', scorer: 'Scorer', commentator: 'Commentator' }[jc.role] : '';
    reply.type('text/html; charset=utf-8');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join ${t ? esc(t.name) : esc(config.BRAND_NAME)}</title>
<style>body{font-family:system-ui,-apple-system,Roboto,sans-serif;background:#0b0e10;color:#fff;margin:0;padding:24px;max-width:520px}
h1{font-size:22px;margin:8px 0}.code{font:700 40px/1.2 ui-monospace,monospace;letter-spacing:6px;background:#1d3b2a;padding:16px;border-radius:12px;text-align:center;margin:20px 0}
.muted{color:#aab4ad}ol{padding-left:20px;line-height:1.7}</style></head><body>
${
  t && jc
    ? `<div class="muted">${esc(config.BRAND_NAME)} · ${esc(role)}</div><h1>${esc(t.name)}</h1>${t.venue ? `<div class="muted">${esc(t.venue)}</div>` : ''}
<div class="code">${esc(code)}</div>
<ol><li>Install <b>${esc(config.BRAND_NAME)}</b> (App Store / Google Play) and open it.</li>
<li>Tap <b>Join with code</b>, then <b>Scan QR</b> on this poster, or type the server <b>${esc(server.replace(/^https?:\/\//, ''))}</b> and the code above.</li>
<li>Enter your name and follow the steps on screen.</li></ol>`
    : `<h1>This join code is not valid</h1><p class="muted">Ask the organiser for a new QR code.</p>`
}
</body></html>`;
  });
}
