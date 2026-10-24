import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export type Db = pg.Pool;

// DATE columns (tournament start day) stay "YYYY-MM-DD": no time zone shift, no midnight timestamp.
pg.types.setTypeParser(1082, (v: string) => v);

export function createDb(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

const here = path.dirname(fileURLToPath(import.meta.url));

function migrationsDir(): string {
  // Works from src/ (tsx) and dist/ (compiled): migrations live next to package.json.
  const candidates = [path.resolve(here, '../migrations'), path.resolve(here, '../../migrations')];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('migrations directory not found');
  return found;
}

export async function migrate(db: Db): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(424242)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const dir = migrationsDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    client.release();
  }
  return applied;
}
