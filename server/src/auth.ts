import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { HttpError } from './errors.js';

/** Roles inside an organisation (and for guests, inside one tournament). */
export const ORG_ROLES = ['owner', 'director', 'scorer', 'commentator', 'camera'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
export const GUEST_ROLES = ['camera', 'scorer', 'commentator'] as const;
export type GuestRole = (typeof GUEST_ROLES)[number];

/**
 * Who is calling:
 *  - user:   an account (organisers, directors, staff). Rights come from org membership.
 *  - guest:  a volunteer who joined one tournament with a QR/join code. No account.
 *  - engine: the OBS agent of one tournament (laptop or cloud), authenticated by engine key.
 */
export type Principal =
  | { kind: 'user'; id: string; email: string; name: string; platformAdmin: boolean }
  | { kind: 'guest'; id: string; name: string; tournamentId: string; role: GuestRole }
  | { kind: 'engine'; id: string; name: string; tournamentId: string };

interface Claims {
  sub: string;
  k: 'user' | 'guest' | 'engine';
  n: string;
  e?: string;
  pa?: boolean;
  t?: string;
  r?: GuestRole;
}

export function principalKey(p: Principal): string {
  return `${p.kind}:${p.id}`;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signPrincipal(config: Config, p: Principal): string {
  const claims: Claims =
    p.kind === 'user'
      ? { sub: p.id, k: 'user', n: p.name, e: p.email, pa: p.platformAdmin || undefined }
      : p.kind === 'guest'
        ? { sub: p.id, k: 'guest', n: p.name, t: p.tournamentId, r: p.role }
        : { sub: p.id, k: 'engine', n: p.name, t: p.tournamentId };
  const ttl = p.kind === 'guest' ? config.GUEST_TTL : config.JWT_TTL;
  return jwt.sign(claims, config.JWT_SECRET, { expiresIn: ttl as jwt.SignOptions['expiresIn'], issuer: 'cogolfer-live' });
}

export function verifyPrincipal(config: Config, token: string): Principal | null {
  try {
    const c = jwt.verify(token, config.JWT_SECRET, { issuer: 'cogolfer-live' }) as Claims;
    if (!c.sub) return null;
    if (c.k === 'user') return { kind: 'user', id: c.sub, email: c.e ?? '', name: c.n, platformAdmin: Boolean(c.pa) };
    if (c.k === 'guest' && c.t && c.r && (GUEST_ROLES as readonly string[]).includes(c.r)) {
      return { kind: 'guest', id: c.sub, name: c.n, tournamentId: c.t, role: c.r };
    }
    if (c.k === 'engine' && c.t) return { kind: 'engine', id: c.sub, name: c.n, tournamentId: c.t };
    return null;
  } catch {
    return null;
  }
}

export function bearerFrom(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  const q = (req.query as Record<string, unknown> | undefined)?.token;
  return typeof q === 'string' ? q : undefined;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export function requireAuth(config: Config, ...kinds: Principal['kind'][]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const token = bearerFrom(req);
    const p = token ? verifyPrincipal(config, token) : null;
    if (!p) throw new HttpError(401, 'unauthorized', 'Sign in again: your session is missing or expired.');
    if (kinds.length && !kinds.includes(p.kind)) {
      throw new HttpError(403, 'forbidden', 'This action needs a signed-in account.');
    }
    req.principal = p;
  };
}

export function userOf(req: FastifyRequest) {
  const p = req.principal;
  if (!p || p.kind !== 'user') throw new HttpError(403, 'forbidden', 'This action needs a signed-in account.');
  return p;
}
