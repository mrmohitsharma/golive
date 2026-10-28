import { createPublicKey, type KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Config } from './config.js';
import { HttpError } from './errors.js';

/** What we keep from a verified Google ID token. */
export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'] as const;

/**
 * "Sign in with Google" for the app and the website: verifies a Google ID token
 * (RS256 signature against Google's published keys, issuer, audience = one of our OAuth
 * client IDs, expiry, verified email). Only the `openid email profile` scopes are used,
 * so no extra Google review is needed.
 */
export class GoogleSignIn {
  private keys = new Map<string, KeyObject>();
  private keysExpireAt = 0;

  constructor(
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Client IDs whose tokens we accept (Web, Android, iOS). The Web ID is also the website button's. */
  get audiences(): string[] {
    const ids = (this.config.GOOGLE_SIGNIN_CLIENT_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (this.config.GOOGLE_CLIENT_ID && !ids.includes(this.config.GOOGLE_CLIENT_ID)) ids.push(this.config.GOOGLE_CLIENT_ID);
    return ids;
  }

  /** The client ID the website's button uses (first configured). */
  get webClientId(): string | null {
    return this.audiences[0] ?? null;
  }

  get enabled(): boolean {
    return this.audiences.length > 0;
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    if (!this.enabled) throw new HttpError(409, 'google_signin_off', 'Google sign-in is not set up on this server.');
    const header = jwt.decode(idToken, { complete: true })?.header;
    if (!header?.kid || header.alg !== 'RS256') throw this.invalid();
    const key = await this.key(header.kid);
    let claims: jwt.JwtPayload;
    try {
      claims = jwt.verify(idToken, key, {
        algorithms: ['RS256'],
        issuer: [...ISSUERS],
        audience: this.audiences as [string, ...string[]],
        clockTimestamp: Math.floor(this.now() / 1000),
        clockTolerance: 30,
      }) as jwt.JwtPayload;
    } catch {
      throw this.invalid();
    }
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    const verified = claims.email_verified === true || claims.email_verified === 'true';
    if (!claims.sub || !email) throw this.invalid();
    if (!verified) throw new HttpError(401, 'google_email_unverified', 'Your Google account email is not verified. Verify it with Google, or sign up with email.');
    const name = (typeof claims.name === 'string' && claims.name.trim()) || email.split('@')[0];
    return { sub: String(claims.sub), email, name: name.slice(0, 80) };
  }

  private invalid() {
    return new HttpError(401, 'google_token_invalid', 'Google sign-in did not work. Try again.');
  }

  private async key(kid: string): Promise<KeyObject> {
    if (this.now() >= this.keysExpireAt || !this.keys.has(kid)) await this.loadKeys();
    const k = this.keys.get(kid);
    if (!k) throw this.invalid();
    return k;
  }

  /** Google rotates its keys; the Cache-Control max-age says how long a set is good for. */
  private async loadKeys(): Promise<void> {
    const res = await this.fetchImpl(this.config.GOOGLE_CERTS_URL);
    if (!res.ok) throw new HttpError(503, 'google_unreachable', 'Cannot reach Google right now. Try again in a minute.');
    const body = (await res.json()) as { keys?: Jwk[] };
    const keys = new Map<string, KeyObject>();
    for (const k of body.keys ?? []) {
      if (k.kty !== 'RSA' || !k.kid) continue;
      keys.set(k.kid, createPublicKey({ key: { kty: k.kty, n: k.n, e: k.e }, format: 'jwk' }));
    }
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600);
    this.keys = keys;
    this.keysExpireAt = this.now() + Math.min(Math.max(maxAge, 60), 86_400) * 1000;
  }
}
