/**
 * A small in-memory cache for hot public reads (watch and channel pages polled by every viewer).
 * Values live `ttlMs`; requests that miss at the same moment share one load, so 1,000 viewers
 * polling together cost one database round, not 1,000. `drop` clears a key after a change.
 */
export class TtlCache {
  private values = new Map<string, { at: number; value: unknown }>();
  private loading = new Map<string, Promise<unknown>>();

  constructor(private readonly max = 2000) {}

  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.values.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    const pending = this.loading.get(key);
    if (pending) return pending as Promise<T>;
    const p = load()
      .then((value) => {
        this.values.set(key, { at: Date.now(), value });
        if (this.values.size > this.max) this.values.delete(this.values.keys().next().value!);
        return value;
      })
      .finally(() => this.loading.delete(key));
    this.loading.set(key, p);
    return p;
  }

  /** Forgets one key, or every key starting with `prefix*`. */
  drop(key: string): void {
    if (key.endsWith('*')) {
      const pre = key.slice(0, -1);
      for (const k of this.values.keys()) if (k.startsWith(pre)) this.values.delete(k);
    } else this.values.delete(key);
  }
}
