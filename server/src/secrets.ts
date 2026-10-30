import type { Repo } from './repo.js';
import type { Sealer } from './crypto.js';

/**
 * Settings with secrets that admins set in the web panel (payment gateway, SMS), stored
 * encrypted with DATA_KEY. A value set here wins over the server config (.env).
 */
export class PlatformSecrets {
  constructor(private readonly repo: Repo, private readonly sealer: Sealer) {}

  async get<T extends object>(key: string): Promise<T | null> {
    const r = (await this.repo.db.query<{ value_enc: string }>('SELECT value_enc FROM platform_secrets WHERE key = $1', [key])).rows[0];
    if (!r) return null;
    try {
      return JSON.parse(this.sealer.open(r.value_enc)) as T;
    } catch {
      return null;
    }
  }

  async set(key: string, value: object, by: string | null): Promise<void> {
    await this.repo.db.query(
      `INSERT INTO platform_secrets (key, value_enc, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, this.sealer.seal(JSON.stringify(value)), by],
    );
  }

  async remove(key: string): Promise<void> {
    await this.repo.db.query('DELETE FROM platform_secrets WHERE key = $1', [key]);
  }

  async updatedAt(key: string): Promise<Date | null> {
    return (await this.repo.db.query<{ updated_at: Date }>('SELECT updated_at FROM platform_secrets WHERE key = $1', [key])).rows[0]?.updated_at ?? null;
  }
}

/** "abcd…wxyz": enough to recognise a key without showing it. */
export const maskSecret = (s: string | null | undefined) => (!s ? null : s.length <= 8 ? '••••' : `${s.slice(0, 4)}…${s.slice(-4)}`);
