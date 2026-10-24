import crypto from 'node:crypto';

/** URL-safe random secret (hex), safe inside SRT stream IDs and URLs without escaping. */
export function randomSecret(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// No 0/O, 1/I/L: codes are read off printed posters and typed on phones.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function joinCode(length = 6): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function normaliseJoinCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** AES-256-GCM for secrets at rest (YouTube refresh tokens, stream keys). */
export class Sealer {
  private readonly key: Buffer;

  constructor(hexKey: string) {
    this.key = Buffer.from(hexKey, 'hex');
    if (this.key.length !== 32) throw new Error('DATA_KEY must be 32 bytes (64 hex chars)');
  }

  seal(plain: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
  }

  open(sealed: string): string {
    const [v, iv, tag, enc] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !enc) throw new Error('bad sealed value');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
  }

  /** HMAC signature for time-limited links (replay files for OBS, clip share links). */
  sign(payload: string, expiresAtSec: number): string {
    const mac = crypto.createHmac('sha256', this.key).update(`${payload}|${expiresAtSec}`).digest('base64url').slice(0, 32);
    return `${expiresAtSec}.${mac}`;
  }

  verify(payload: string, sig: string | undefined): boolean {
    if (!sig) return false;
    const [exp, mac] = sig.split('.');
    const expiresAt = Number(exp);
    if (!Number.isFinite(expiresAt) || !mac || expiresAt < Date.now() / 1000) return false;
    const expected = crypto.createHmac('sha256', this.key).update(`${payload}|${expiresAt}`).digest('base64url').slice(0, 32);
    return constantTimeEqual(mac, expected);
  }
}

/** Stable guest id for a device in a tournament, so re-joining keeps the same camera slot. */
export function guestId(tournamentId: string, deviceId: string): string {
  return 'g' + crypto.createHash('sha256').update(`${tournamentId}:${deviceId}`).digest('hex').slice(0, 20);
}
