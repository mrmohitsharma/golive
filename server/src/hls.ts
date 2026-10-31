import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Repo, TournamentRow } from './repo.js';
import type { PlatformSecrets } from './secrets.js';
import type { RelayTarget, HlsSpec } from './relay.js';

/** Admin > Streaming. The API key and origin secret never leave the server except to admins. */
export interface CdnSettings {
  /** Our player on the watch page (and /embed). Off: the watch page uses YouTube as before. */
  playerEnabled: boolean;
  /** CDN hostname viewers load from, e.g. golive-live.b-cdn.net. Empty: straight from this server. */
  host: string | null;
  pullZoneId: number | null;
  apiKey: string;
  /** What the CDN charges, for the cost view. Bunny Volume is $0.005, Standard Asia $0.03. */
  costPerGbUsd: number;
  /** Only the CDN may read /hls (it sends X-Origin-Secret, set as a Bunny edge rule). */
  lockOrigin: boolean;
  originSecret: string;
}

export interface WatchInfo {
  live: string | null;
  replays: { url: string; startedAt: string; durationSec: number }[];
  embedUrl: string;
}

export interface SessionRow {
  id: string;
  tournament_id: string;
  name: string;
  started_at: Date;
  ended_at: Date | null;
  duration_sec: number | null;
  bytes: string | null;
}

const DEFAULTS: CdnSettings = { playerEnabled: true, host: null, pullZoneId: null, apiKey: '', costPerGbUsd: 0.005, lockOrigin: false, originSecret: '' };
export const SESSION_RE = /^s[0-9a-z]{6,12}$/;

/**
 * Our own watch player. The relay turns the programme into HLS (720p and 480p by default)
 * under HLS_DIR/<event>/<session>/; this service keeps track of the sessions, turns a
 * finished session into a replay (a VOD playlist over the same segments), deletes old ones,
 * and talks to the Bunny API for the setup check and the bandwidth bill.
 */
export class HlsService {
  private cached: CdnSettings = { ...DEFAULTS };
  private ticker: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
    private readonly secrets: PlatformSecrets,
    private readonly log: FastifyBaseLogger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get root(): string {
    return this.config.HLS_DIR || path.join(this.config.MEDIA_DIR, 'hls');
  }

  get settings(): CdnSettings {
    return this.cached;
  }

  async reload(): Promise<void> {
    const c = this.config;
    const env: Partial<CdnSettings> = {
      ...(c.CDN_HOST ? { host: c.CDN_HOST.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase() } : {}),
      ...(c.BUNNY_PULL_ZONE_ID ? { pullZoneId: c.BUNNY_PULL_ZONE_ID } : {}),
      ...(c.BUNNY_API_KEY ? { apiKey: c.BUNNY_API_KEY } : {}),
    };
    const saved = (await this.secrets.get<Partial<CdnSettings>>('cdn')) ?? {};
    // Saved in the panel wins; an empty saved key falls back to the .env one.
    this.cached = { ...DEFAULTS, ...env, ...saved, apiKey: saved.apiKey || env.apiKey || '' };
  }

  async save(patch: Partial<CdnSettings>, by: string | null): Promise<CdnSettings> {
    const next: CdnSettings = { ...this.cached, ...patch };
    if (next.lockOrigin && !next.originSecret) next.originSecret = crypto.randomBytes(18).toString('base64url');
    await this.secrets.set('cdn', next, by);
    await this.reload();
    return this.cached;
  }

  /** Viewers' base URL for /hls: the CDN when set, else this server. */
  get base(): string {
    return this.cached.host ? `https://${this.cached.host}` : this.config.PUBLIC_BASE_URL.replace(/\/$/, '');
  }

  get on(): boolean {
    return this.config.HLS_ENABLED && this.cached.playerEnabled;
  }

  /** The watch player stream for this event (on unless the club switched it off for it). */
  wanted(t: TournamentRow): boolean {
    return this.on && t.outputs?.watch?.enabled !== false;
  }

  /** What OBS reports it sends (set in app.ts from the hub). */
  engineVideo: (tournamentId: string) => { outputHeight: number; kbps: number | null } | null | undefined = () => null;

  private static parse(list: string) {
    return list.split(',').map((p) => {
      const [h, k] = p.split(':').map(Number);
      return { height: h, kbps: k };
    });
  }

  /**
   * The qualities to make. In 'auto' mode, a programme OBS already sends at 720p (or less) and
   * a sane bitrate is passed through as the top quality: no re-encode, almost no CPU. A bigger
   * or unknown programme (an older agent, OBS in Advanced output mode) is encoded as before.
   */
  spec(t: TournamentRow): HlsSpec {
    const c = this.config;
    let renditions: HlsSpec['renditions'];
    if (c.HLS_RENDITIONS === 'auto') {
      const ladder = HlsService.parse(c.HLS_LADDER);
      const v = this.engineVideo(t.id);
      const fits = v && v.outputHeight > 0 && v.outputHeight <= c.PROGRAMME_HEIGHT && v.kbps != null && v.kbps <= c.PROGRAMME_KBPS * 1.25;
      renditions = fits ? [{ height: v.outputHeight, kbps: v.kbps!, copy: true }, ...ladder.filter((r) => r.height < v.outputHeight)] : ladder;
    } else renditions = HlsService.parse(c.HLS_RENDITIONS);
    return { dir: path.join(this.root, t.id), renditions, preset: c.HLS_PRESET, segmentSec: c.HLS_SEGMENT_SEC };
  }

  target(t: TournamentRow): RelayTarget {
    const hls = this.spec(t);
    // The URL carries the recipe, so a change (e.g. the agent reports 720p) restarts the encode.
    const recipe = hls.renditions.map((r) => (r.copy ? 'copy' : `${r.height}:${r.kbps}`)).join(',');
    return { id: 'watch', platform: 'watch', url: `${hls.dir}#${recipe}`, vertical: false, hls };
  }

  // ------------------------------------------------------------------ sessions

  /** Sessions whose master playlist is written (and corrected): only those are offered to viewers. */
  private ready = new Set<string>();

  started(tournamentId: string, session: string): void {
    // FFmpeg writes the master after the first segments; fix its bandwidth figures, then publish.
    const dir = path.join(this.root, tournamentId, session);
    let tries = 0;
    const poll = setInterval(() => {
      if (++tries > 240 || fixMaster(dir)) {
        clearInterval(poll);
        if (tries <= 240) this.ready.add(session);
      }
    }, 250);
    poll.unref();
    void this.repo.db
      .query('INSERT INTO watch_sessions (tournament_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tournamentId, session])
      .catch((err) => this.log.warn({ err: (err as Error).message }, 'watch session insert failed'));
  }

  ended(tournamentId: string, session: string): void {
    void this.close(tournamentId, session).catch((err) => this.log.warn({ err: (err as Error).message, session }, 'watch session close failed'));
  }

  /** Writes the replay playlists for a finished session and records its length and size. */
  async close(tournamentId: string, session: string): Promise<{ durationSec: number; bytes: number }> {
    const dir = path.join(this.root, tournamentId, session);
    const r = finalize(dir, this.config.HLS_SEGMENT_SEC);
    await this.repo.db.query(
      'UPDATE watch_sessions SET ended_at = coalesce(ended_at, now()), duration_sec = $3, bytes = $4 WHERE tournament_id = $1 AND name = $2',
      [tournamentId, session, Math.round(r.durationSec), r.bytes],
    );
    return r;
  }

  /** After a restart of this server: sessions it never saw end. */
  async recover(live: (tournamentId: string) => boolean): Promise<void> {
    const open = (await this.repo.db.query<SessionRow>('SELECT * FROM watch_sessions WHERE ended_at IS NULL AND deleted_at IS NULL')).rows;
    for (const s of open) if (!live(s.tournament_id)) await this.close(s.tournament_id, s.name).catch(() => {});
  }

  /** Deletes sessions older than HLS_RETENTION_DAYS (their replays go too). */
  async cleanup(now = Date.now()): Promise<number> {
    const cutoff = now - this.config.HLS_RETENTION_DAYS * 86_400_000;
    let removed = 0;
    if (!fs.existsSync(this.root)) return 0;
    for (const tid of fs.readdirSync(this.root)) {
      const tdir = path.join(this.root, tid);
      if (!fs.statSync(tdir).isDirectory()) continue;
      for (const s of fs.readdirSync(tdir)) {
        if (!SESSION_RE.test(s)) continue;
        const sdir = path.join(tdir, s);
        if (fs.statSync(sdir).mtimeMs >= cutoff) continue;
        fs.rmSync(sdir, { recursive: true, force: true });
        removed++;
        await this.repo.db.query('UPDATE watch_sessions SET deleted_at = now() WHERE tournament_id::text = $1 AND name = $2', [tid, s]).catch(() => {});
      }
      if (!fs.readdirSync(tdir).length) fs.rmdirSync(tdir);
    }
    return removed;
  }

  start(): void {
    const run = () => void this.cleanup().catch((err) => this.log.warn({ err: (err as Error).message }, 'hls cleanup failed'));
    run();
    this.ticker = setInterval(run, 6 * 3600_000);
    this.ticker.unref();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
  }

  /** What the watch page plays: the live stream while FFmpeg is writing it, and the replays. */
  async info(t: TournamentRow, liveNow: boolean): Promise<WatchInfo | null> {
    const rows = (
      await this.repo.db.query<SessionRow>(
        'SELECT * FROM watch_sessions WHERE tournament_id = $1 AND deleted_at IS NULL ORDER BY started_at DESC LIMIT 20',
        [t.id],
      )
    ).rows;
    if (!this.on && !rows.length) return null;
    const current = rows.find((r) => !r.ended_at);
    const url = (s: string, f: string) => `${this.base}/hls/${t.id}/${s}/${f}`;
    return {
      live: liveNow && current && this.ready.has(current.name) && this.wanted(t) ? url(current.name, 'master.m3u8') : null,
      replays: rows
        .filter((r) => r.ended_at && (r.duration_sec ?? 0) >= 10)
        .map((r) => ({ url: url(r.name, 'replay.m3u8'), startedAt: r.started_at.toISOString(), durationSec: r.duration_sec ?? 0 })),
      embedUrl: `${this.config.PUBLIC_BASE_URL.replace(/\/$/, '')}/embed/${t.id}`,
    };
  }

  async sessions(limit = 50) {
    return (
      await this.repo.db.query<SessionRow & { event: string; club: string }>(
        `SELECT w.*, t.name AS event, o.name AS club FROM watch_sessions w JOIN tournaments t ON t.id = w.tournament_id
           JOIN orgs o ON o.id = t.org_id ORDER BY w.started_at DESC LIMIT $1`,
        [limit],
      )
    ).rows.map((r) => ({
      id: Number(r.id),
      eventId: r.tournament_id,
      event: r.event,
      club: r.club,
      startedAt: r.started_at.toISOString(),
      endedAt: r.ended_at?.toISOString() ?? null,
      durationSec: r.duration_sec,
      bytes: r.bytes == null ? null : Number(r.bytes),
      deleted: Boolean((r as { deleted_at?: Date | null }).deleted_at),
    }));
  }

  // ------------------------------------------------------------------ Bunny API

  private async bunny<T>(p: string): Promise<T> {
    const res = await this.fetchImpl(`https://api.bunny.net${p}`, { headers: { AccessKey: this.cached.apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401) throw new Error('Bunny rejected the API key.');
    if (res.status === 404) throw new Error('Bunny has no pull zone with that id.');
    if (!res.ok) throw new Error(`Bunny answered ${res.status}.`);
    return (await res.json()) as T;
  }

  /** The setup check behind the Test button: the pull zone, its origin, and a request through it. */
  async test(): Promise<{ name: string; ok: boolean; detail: string }[]> {
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const s = this.cached;
    checks.push({ name: 'Player', ok: this.on, detail: this.on ? 'Our player is on for the watch page.' : this.config.HLS_ENABLED ? 'Switched off here.' : 'HLS_ENABLED is false in the server .env.' });
    if (s.apiKey && s.pullZoneId) {
      try {
        const z = await this.bunny<{ Name: string; OriginUrl: string; Type: number; Hostnames?: { Value: string }[] }>(`/pullzone/${s.pullZoneId}`);
        const origin = (z.OriginUrl || '').replace(/\/$/, '');
        const ours = this.config.PUBLIC_BASE_URL.replace(/\/$/, '');
        const hosts = (z.Hostnames ?? []).map((h) => h.Value);
        checks.push({ name: 'Pull zone', ok: true, detail: `${z.Name} (${z.Type === 1 ? 'Volume' : 'Standard'} network) · ${hosts.join(', ')}` });
        checks.push({
          name: 'Origin',
          ok: origin === ours,
          detail: origin === ours ? `Pulls from ${origin}` : `Pulls from ${origin || '(nothing)'}; set the Origin URL in Bunny to ${ours}`,
        });
        if (s.host && hosts.length && !hosts.includes(s.host)) checks.push({ name: 'Hostname', ok: false, detail: `${s.host} is not one of this pull zone's hostnames.` });
      } catch (err) {
        checks.push({ name: 'Pull zone', ok: false, detail: (err as Error).message });
      }
    } else checks.push({ name: 'Pull zone', ok: false, detail: 'Add the pull zone id and API key to check it and to see the bandwidth bill.' });
    if (s.host) {
      try {
        const res = await this.fetchImpl(`https://${s.host}/hls/ping?t=${Date.now()}`, { signal: AbortSignal.timeout(10_000) });
        const body = await res.text();
        checks.push({ name: 'Through the CDN', ok: res.ok && body.trim() === 'ok', detail: res.ok ? 'Viewers can reach the stream through the CDN.' : `The CDN answered ${res.status}${res.status === 403 ? ' (origin lock: add the edge rule)' : ''}.` });
      } catch (err) {
        checks.push({ name: 'Through the CDN', ok: false, detail: `Could not reach https://${s.host}: ${(err as Error).message}` });
      }
    } else checks.push({ name: 'CDN', ok: false, detail: 'No CDN hostname: viewers load the stream straight from this server (fine for tests, costly at scale).' });
    return checks;
  }

  /** Bandwidth and the estimated bill from Bunny's statistics. */
  async stats(days: number, usdInr: number) {
    const s = this.cached;
    if (!s.apiKey || !s.pullZoneId) return null;
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const d = (x: Date) => x.toISOString().slice(0, 10);
    const r = await this.bunny<{ TotalBandwidthUsed: number; TotalRequestsServed: number; CacheHitRate: number; BandwidthUsedChart?: Record<string, number> }>(
      `/statistics?pullZone=${s.pullZoneId}&dateFrom=${d(from)}&dateTo=${d(to)}`,
    );
    const gb = r.TotalBandwidthUsed / 1e9;
    const usd = gb * s.costPerGbUsd;
    return {
      days,
      bandwidthGb: Math.round(gb * 100) / 100,
      requests: r.TotalRequestsServed,
      cacheHitRate: Math.round(r.CacheHitRate * 10) / 10,
      costUsd: Math.round(usd * 100) / 100,
      costInr: Math.round(usd * usdInr),
      daily: Object.entries(r.BandwidthUsedChart ?? {}).map(([day, bytes]) => ({ day: day.slice(0, 10), gb: Math.round((bytes / 1e9) * 100) / 100 })),
    };
  }
}

/**
 * Turns a session folder into a replay: for each quality a VOD playlist over every segment
 * written (durations from FFmpeg's live playlist where it still lists them), and
 * replay.m3u8, a copy of the master pointing at those playlists.
 */
export function finalize(dir: string, segmentSec: number): { durationSec: number; bytes: number } {
  if (!fs.existsSync(dir)) return { durationSec: 0, bytes: 0 };
  let bytes = 0;
  let top = 0;
  const variants = fs.readdirSync(dir).filter((v) => /^v\w+$/.test(v) && fs.statSync(path.join(dir, v)).isDirectory());
  for (const v of variants) {
    const vdir = path.join(dir, v);
    const known = new Map<string, number>();
    const live = path.join(vdir, 'live.m3u8');
    if (fs.existsSync(live)) {
      const lines = fs.readFileSync(live, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = /^#EXTINF:([\d.]+)/.exec(lines[i]);
        if (m && lines[i + 1]) known.set(lines[i + 1].trim(), Number(m[1]));
      }
    }
    const segs = fs.readdirSync(vdir).filter((f) => /^s\d+\.ts$/.test(f)).sort();
    let total = 0;
    let max = segmentSec;
    const body: string[] = [];
    for (const f of segs) {
      const size = fs.statSync(path.join(vdir, f)).size;
      bytes += size;
      if (!size) continue;
      const d = known.get(f) ?? segmentSec;
      total += d;
      max = Math.max(max, d);
      body.push(`#EXTINF:${d.toFixed(6)},`, f);
    }
    const head = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(max)}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
    fs.writeFileSync(path.join(vdir, 'vod.m3u8'), [...head, ...body, '#EXT-X-ENDLIST', ''].join('\n'));
    top = Math.max(top, total);
  }
  fixMaster(dir);
  const master = path.join(dir, 'master.m3u8');
  if (fs.existsSync(master)) fs.writeFileSync(path.join(dir, 'replay.m3u8'), fs.readFileSync(master, 'utf8').replace(/live\.m3u8/g, 'vod.m3u8'));
  return { durationSec: top, bytes };
}

/**
 * FFmpeg cannot measure a copied stream's bitrate, so the master playlist under-states it
 * (e.g. 176 kbps for 2.5 Mbps video) and players would pick it on slow links. Rewrites each
 * BANDWIDTH from the real segment sizes (peak, +10%). Returns false until the master and a
 * first segment of every quality exist.
 */
export function fixMaster(dir: string): boolean {
  const master = path.join(dir, 'master.m3u8');
  if (!fs.existsSync(master)) return false;
  const lines = fs.readFileSync(master, 'utf8').split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(v\w+)\/live\.m3u8$/.exec(lines[i].trim());
    if (!m || !lines[i - 1]?.startsWith('#EXT-X-STREAM-INF:')) continue;
    const vdir = path.join(dir, m[1]);
    const durs = new Map<string, number>();
    try {
      const pl = fs.readFileSync(path.join(vdir, 'live.m3u8'), 'utf8').split('\n');
      for (let j = 0; j < pl.length; j++) {
        const d = /^#EXTINF:([\d.]+)/.exec(pl[j]);
        if (d && pl[j + 1]) durs.set(pl[j + 1].trim(), Number(d[1]));
      }
    } catch {
      return false;
    }
    let peak = 0;
    for (const [f, d] of durs) {
      if (d < 1) continue;
      try {
        peak = Math.max(peak, (fs.statSync(path.join(vdir, f)).size * 8) / d);
      } catch {}
    }
    if (!peak) return false;
    const bw = Math.round(peak * 1.1);
    const cur = Number(/BANDWIDTH=(\d+)/.exec(lines[i - 1])?.[1] ?? 0);
    if (cur < bw * 0.8) {
      lines[i - 1] = lines[i - 1].replace(/BANDWIDTH=\d+/, `BANDWIDTH=${bw}`);
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(master + '.tmp', lines.join('\n'));
    fs.renameSync(master + '.tmp', master);
  }
  return true;
}
