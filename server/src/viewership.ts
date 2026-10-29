import crypto from 'node:crypto';
import type { Config } from './config.js';
import type { Repo, TournamentRow } from './repo.js';
import { HttpError } from './errors.js';

/** A view counts ("qualified") after this many seconds actually watched. */
export const QUALIFIED_SEC = 30;
/** The watch page reports every 30 s; a report may claim at most this many seconds. */
export const BEAT_SEC = 30;
const BEAT_SLACK_SEC = 8;
/** Viewers seen in the last 75 s are "watching now". */
const WATCHING_WINDOW_MS = 75_000;
/** More viewers than this from one network in one event are not counted (fake-view cap). */
export const NET_CAP_DEFAULT = 25;
/** A new visit when a viewer comes back after this long away. */
const NEW_VISIT_MS = 30 * 60_000;

export interface ViewerRow {
  id: string;
  tournament_id: string;
  viewer_key: string;
  ref_id: string | null;
  device: string;
  app: string;
  net_hash: string | null;
  flagged: boolean;
  visits: number;
  watched_sec: number;
  unmuted_sec: number;
  live_sec: number;
  replay_sec: number;
  first_seen_at: Date;
  last_seen_at: Date;
}

interface Pending {
  tournamentId: string;
  watched: number;
  unmuted: number;
  live: number;
  replay: number;
}

interface Presence {
  at: number;
  unmuted: boolean;
}

/** What a phone tells us about itself (from the User-Agent): device kind and the app it opened in. */
export function describeAgent(ua: string): { device: string; app: string; bot: boolean } {
  const s = ua.toLowerCase();
  const bot = !s || /bot|crawler|spider|headless|phantom|puppeteer|playwright|selenium|curl|wget|python-requests|httpclient|lighthouse/.test(s);
  const app = /instagram/.test(s) ? 'instagram' : /fban|fbav|fb_iab/.test(s) ? 'facebook' : /whatsapp/.test(s) ? 'whatsapp' : 'browser';
  const device = /ipad|tablet/.test(s) ? 'tablet' : /mobi|android|iphone/.test(s) ? 'mobile' : /windows|macintosh|linux|cros/.test(s) ? 'desktop' : 'other';
  return { device, app, bot };
}

/**
 * Viewership engine, step 1: counts who watches on the watch page and for how long.
 *  - Viewer clock: seconds a viewer actually watched (video playing, tab visible). It continues
 *    where it left off when they come back.
 *  - Stream clock: seconds since the event's first Go live (tournaments.first_live_at).
 * Reports from the page are added up in memory and written in one statement every few seconds,
 * so 10,000 viewers (about 330 reports a second) cost a handful of queries.
 */
export class ViewershipService {
  private pending = new Map<string, Pending>();
  private presence = new Map<string, Map<string, Presence>>();
  private youtubeNow = new Map<string, { viewers: number; at: number }>();
  /** Which influencer brought each viewer (for "watching now" per influencer). */
  private refs = new Map<string, string | null>();
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
    private readonly isLive: (tournamentId: string) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  // ---------------------------------------------------------------- tokens
  /** "<viewer id>.<event id>.<flag>.<signature>": proves a report comes from the page that started the view. */
  private sign(viewerId: string, tournamentId: string, flagged = false): string {
    const f = flagged ? '1' : '0';
    const sig = crypto.createHmac('sha256', this.config.JWT_SECRET).update(`view:${viewerId}:${tournamentId}:${f}`).digest('base64url').slice(0, 22);
    return `${viewerId}.${tournamentId}.${f}.${sig}`;
  }

  verify(token: string): { viewerId: string; tournamentId: string; flagged: boolean } {
    const [viewerId, tournamentId, f, sig] = token.split('.');
    if (!viewerId || !tournamentId || (f !== '0' && f !== '1') || !sig) throw new HttpError(401, 'bad_view_token', 'Reload the page.');
    const expect = this.sign(viewerId, tournamentId, f === '1').split('.')[3];
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
      throw new HttpError(401, 'bad_view_token', 'Reload the page.');
    }
    return { viewerId, tournamentId, flagged: f === '1' };
  }

  private netHash(ip: string | undefined): string | null {
    if (!ip) return null;
    // The /24 (IPv4) or /48 (IPv6) network, salted: enough to cap one network, not to identify anyone.
    const net = ip.includes(':') ? ip.split(':').slice(0, 3).join(':') : ip.split('.').slice(0, 3).join('.');
    return crypto.createHmac('sha256', this.config.JWT_SECRET).update(`net:${net}`).digest('hex').slice(0, 16);
  }

  // ---------------------------------------------------------------- the stream clock
  /** Called when a stream goes live: the first time sets the event's stream clock. */
  async streamStarted(tournamentId: string): Promise<void> {
    await this.repo.db.query('UPDATE tournaments SET first_live_at = now() WHERE id = $1 AND first_live_at IS NULL', [tournamentId]);
  }

  streamClockSec(t: Pick<TournamentRow, 'first_live_at'>): number | null {
    return t.first_live_at ? Math.max(0, Math.floor((this.now() - new Date(t.first_live_at).getTime()) / 1000)) : null;
  }

  // ---------------------------------------------------------------- a viewer opens the page
  async start(
    t: TournamentRow,
    input: { viewerKey?: string | null; ip?: string; userAgent?: string; refId?: string | null; sharedBy?: string | null },
  ): Promise<{ token: string; viewerKey: string; watchedSec: number; viewer: ViewerRow; shareCode: string }> {
    const key = input.viewerKey && /^[A-Za-z0-9_-]{16,64}$/.test(input.viewerKey) ? input.viewerKey : crypto.randomBytes(18).toString('base64url');
    const agent = describeAgent(input.userAgent ?? '');
    const net = this.netHash(input.ip);
    const existing = (await this.repo.db.query<ViewerRow>('SELECT * FROM viewers WHERE tournament_id = $1 AND viewer_key = $2', [t.id, key])).rows[0];
    let viewer: ViewerRow;
    const days = t.attribution_days ?? 7;
    if (existing) {
      const away = this.now() - new Date(existing.last_seen_at).getTime();
      // First influencer link wins; a later link counts only if the viewer had none and
      // first came within the event's attribution window.
      const credit =
        input.refId && !existing.ref_id && this.now() - new Date(existing.first_seen_at).getTime() <= days * 86_400_000 ? input.refId : null;
      viewer = (
        await this.repo.db.query<ViewerRow>(
          'UPDATE viewers SET visits = visits + $2, last_seen_at = now(), ref_id = COALESCE(ref_id, $3) WHERE id = $1 RETURNING *',
          [existing.id, away > NEW_VISIT_MS ? 1 : 0, credit],
        )
      ).rows[0];
    } else {
      let flagged = agent.bot;
      if (!flagged && net) {
        const n = Number((await this.repo.db.query<{ n: string }>('SELECT count(*)::text AS n FROM viewers WHERE tournament_id = $1 AND net_hash = $2', [t.id, net])).rows[0].n);
        flagged = n >= (this.config.VIEW_NET_CAP ?? NET_CAP_DEFAULT);
      }
      // Came through another viewer's share link (e.g. a winner's): credit that viewer.
      const sharer = input.sharedBy && /^[A-Za-z0-9_-]{6,16}$/.test(input.sharedBy)
        ? ((await this.repo.db.query<{ id: string }>('SELECT id FROM viewers WHERE tournament_id = $1 AND share_code = $2', [t.id, input.sharedBy])).rows[0]?.id ?? null)
        : null;
      viewer = (
        await this.repo.db.query<ViewerRow>(
          `INSERT INTO viewers (tournament_id, viewer_key, ref_id, device, app, net_hash, flagged, shared_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (tournament_id, viewer_key) DO UPDATE SET last_seen_at = now() RETURNING *`,
          [t.id, key, input.refId ?? null, agent.device, agent.app, net, flagged, sharer],
        )
      ).rows[0];
    }
    this.refs.set(viewer.id, viewer.ref_id);
    let shareCode = (viewer as ViewerRow & { share_code?: string | null }).share_code ?? null;
    if (!shareCode) {
      shareCode = crypto.randomBytes(6).toString('base64url');
      await this.repo.db.query('UPDATE viewers SET share_code = $2 WHERE id = $1 AND share_code IS NULL', [viewer.id, shareCode]).catch(() => {
        shareCode = null;
      });
    }
    if (this.refs.size > 200_000) this.refs.delete(this.refs.keys().next().value!);
    return { token: this.sign(viewer.id, t.id, viewer.flagged), viewerKey: key, watchedSec: viewer.watched_sec, viewer, shareCode: shareCode ?? '' };
  }

  // ---------------------------------------------------------------- reports every 30 s
  /**
   * The page reports seconds watched (video playing, tab visible) and seconds unmuted since its
   * last report. Claims are capped to what could really have happened. Returns the viewer clock.
   */
  beat(token: string, playingSec: number, unmutedSec: number): { viewerId: string; tournamentId: string; addedSec: number } {
    const { viewerId, tournamentId, flagged } = this.verify(token);
    const cap = BEAT_SEC + BEAT_SLACK_SEC;
    const watched = Math.max(0, Math.min(cap, Math.floor(playingSec)));
    const unmuted = Math.max(0, Math.min(watched, Math.floor(unmutedSec)));
    const live = this.isLive(tournamentId);
    const p = this.pending.get(viewerId) ?? { tournamentId, watched: 0, unmuted: 0, live: 0, replay: 0 };
    p.watched += watched;
    p.unmuted += unmuted;
    if (live) p.live += watched;
    else p.replay += watched;
    this.pending.set(viewerId, p);
    // Bots and over-cap viewers are stored but never counted as watching.
    if (watched > 0 && !flagged) {
      let m = this.presence.get(tournamentId);
      if (!m) this.presence.set(tournamentId, (m = new Map()));
      m.set(viewerId, { at: this.now(), unmuted: unmuted > 0 });
    }
    return { viewerId, tournamentId, addedSec: watched };
  }

  /** A viewer's clock: stored seconds plus what is waiting to be written. */
  async viewerClock(viewerId: string): Promise<number> {
    const r = (await this.repo.db.query<{ watched_sec: number }>('SELECT watched_sec FROM viewers WHERE id = $1', [viewerId])).rows[0];
    return (r?.watched_sec ?? 0) + (this.pending.get(viewerId)?.watched ?? 0);
  }

  /** Writes the reports gathered since the last flush in one statement. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    if (!this.pending.size) return;
    const batch = [...this.pending.entries()];
    this.pending.clear();
    for (let i = 0; i < batch.length; i += 1000) {
      const part = batch.slice(i, i + 1000);
      const vals: unknown[] = [];
      const rows = part.map(([id, p], j) => {
        vals.push(id, p.watched, p.unmuted, p.live, p.replay);
        const b = j * 5;
        return `($${b + 1}::uuid, $${b + 2}::int, $${b + 3}::int, $${b + 4}::int, $${b + 5}::int)`;
      });
      try {
        await this.repo.db.query(
          `UPDATE viewers v SET watched_sec = v.watched_sec + x.w, unmuted_sec = v.unmuted_sec + x.u,
             live_sec = v.live_sec + x.l, replay_sec = v.replay_sec + x.r, last_seen_at = now()
           FROM (VALUES ${rows.join(', ')}) AS x(id, w, u, l, r) WHERE v.id = x.id`,
          vals,
        );
      } catch (err) {
        // Put them back so a database hiccup loses nothing.
        for (const [id, p] of part) {
          const q = this.pending.get(id);
          this.pending.set(id, q ? { ...q, watched: q.watched + p.watched, unmuted: q.unmuted + p.unmuted, live: q.live + p.live, replay: q.replay + p.replay } : p);
        }
        throw err;
      }
    }
  }

  // ---------------------------------------------------------------- watching now
  watchingNow(tournamentId: string): { watching: number; unmuted: number } {
    const m = this.presence.get(tournamentId);
    if (!m) return { watching: 0, unmuted: 0 };
    const since = this.now() - WATCHING_WINDOW_MS;
    let watching = 0;
    let unmuted = 0;
    for (const [id, p] of m) {
      if (p.at < since) {
        m.delete(id);
        continue;
      }
      watching++;
      if (p.unmuted) unmuted++;
    }
    return { watching, unmuted };
  }

  /** Viewers who reported in the last 75 s (the lucky draw only picks people still watching). */
  watchingViewers(tournamentId: string): Set<string> {
    this.watchingNow(tournamentId);
    return new Set(this.presence.get(tournamentId)?.keys() ?? []);
  }

  /** Watching now, per influencer link (viewers with no link are left out). */
  watchingByRef(tournamentId: string): Map<string, number> {
    this.watchingNow(tournamentId); // drops viewers who stopped reporting
    const out = new Map<string, number>();
    for (const id of this.presence.get(tournamentId)?.keys() ?? []) {
      const ref = this.refs.get(id);
      if (ref) out.set(ref, (out.get(ref) ?? 0) + 1);
    }
    return out;
  }

  setYoutubeViewers(tournamentId: string, viewers: number | null): void {
    if (viewers == null) this.youtubeNow.delete(tournamentId);
    else this.youtubeNow.set(tournamentId, { viewers, at: this.now() });
  }

  youtubeViewers(tournamentId: string): number | null {
    const y = this.youtubeNow.get(tournamentId);
    return y && this.now() - y.at < 5 * 60_000 ? y.viewers : null;
  }

  /** Once a minute: one row per event with viewers, for the graph and the peak. */
  async snapshotMinute(): Promise<void> {
    const at = new Date(Math.floor(this.now() / 60_000) * 60_000);
    const ids = new Set([...this.presence.keys(), ...this.youtubeNow.keys()]);
    for (const tid of ids) {
      const w = this.watchingNow(tid);
      const yt = this.youtubeViewers(tid);
      if (!w.watching && yt == null) continue;
      await this.repo.db.query(
        `INSERT INTO viewer_minutes (tournament_id, at, watching, unmuted, youtube) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tournament_id, at) DO UPDATE SET watching = EXCLUDED.watching, unmuted = EXCLUDED.unmuted, youtube = EXCLUDED.youtube`,
        [tid, at, w.watching, w.unmuted, yt],
      );
    }
  }

  // ---------------------------------------------------------------- the director's summary
  async summary(t: TournamentRow) {
    await this.flush().catch(() => {});
    const r = (
      await this.repo.db.query<Record<string, string | null>>(
        `SELECT count(*)::text AS opened,
                count(*) FILTER (WHERE watched_sec > 0)::text AS played,
                count(*) FILTER (WHERE watched_sec >= $2)::text AS qualified,
                count(*) FILTER (WHERE watched_sec > 0 AND watched_sec < $2)::text AS bounced,
                count(*) FILTER (WHERE unmuted_sec > 0)::text AS unmuted_viewers,
                count(*) FILTER (WHERE visits > 1)::text AS returning,
                COALESCE(sum(watched_sec), 0)::text AS watched, COALESCE(sum(unmuted_sec), 0)::text AS unmuted,
                COALESCE(sum(live_sec), 0)::text AS live, COALESCE(sum(replay_sec), 0)::text AS replay,
                count(*) FILTER (WHERE device = 'mobile')::text AS mobile,
                count(*) FILTER (WHERE app = 'instagram')::text AS instagram,
                count(*) FILTER (WHERE app = 'whatsapp')::text AS whatsapp,
                count(*) FILTER (WHERE shared_by IS NOT NULL AND watched_sec > 0)::text AS via_shares,
                (SELECT count(*) FROM viewers f WHERE f.tournament_id = $1 AND f.flagged)::text AS flagged
           FROM viewers WHERE tournament_id = $1 AND NOT flagged`,
        [t.id, QUALIFIED_SEC],
      )
    ).rows[0];
    const peak = (
      await this.repo.db.query<{ watching: number | null; youtube: number | null }>(
        'SELECT max(watching) AS watching, max(youtube) AS youtube FROM viewer_minutes WHERE tournament_id = $1',
        [t.id],
      )
    ).rows[0];
    const series = (
      await this.repo.db.query<{ at: Date; watching: number; unmuted: number; youtube: number | null }>(
        `SELECT at, watching, unmuted, youtube FROM viewer_minutes WHERE tournament_id = $1 ORDER BY at DESC LIMIT 360`,
        [t.id],
      )
    ).rows.reverse();
    const n = (k: string) => Number(r[k] ?? 0);
    const now = this.watchingNow(t.id);
    const played = n('played');
    return {
      streamStartedAt: t.first_live_at ? new Date(t.first_live_at).toISOString() : null,
      streamClockSec: this.streamClockSec(t),
      watchingNow: now.watching,
      unmutedNow: now.unmuted,
      peakWatching: Math.max(peak?.watching ?? 0, now.watching),
      youtube: { viewersNow: this.youtubeViewers(t.id), peak: peak?.youtube ?? null },
      pageOpens: n('opened'),
      viewers: played,
      qualifiedViewers: n('qualified'),
      bouncedViewers: n('bounced'),
      returningViewers: n('returning'),
      flaggedViewers: n('flagged'),
      watchMinutes: Math.round(n('watched') / 60),
      liveMinutes: Math.round(n('live') / 60),
      replayMinutes: Math.round(n('replay') / 60),
      avgWatchSec: played ? Math.round(n('watched') / played) : 0,
      unmutedRate: played ? Math.round((100 * n('unmuted_viewers')) / played) : 0,
      unmutedShareOfTime: n('watched') ? Math.round((100 * n('unmuted')) / n('watched')) : 0,
      apps: { instagram: n('instagram'), whatsapp: n('whatsapp') },
      viaViewerShares: n('via_shares'),
      mobileShare: played ? Math.round((100 * n('mobile')) / Math.max(1, n('opened'))) : 0,
      series: series.map((s) => ({ at: s.at.toISOString(), watching: s.watching, unmuted: s.unmuted, youtube: s.youtube })),
    };
  }
}

/** Can the watch page play this event's video? Influencer links and games need a playable video. */
export function playableVideo(t: TournamentRow, status?: { embeddable?: boolean; madeForKids?: boolean; privacy?: string | null } | null) {
  if (!t.yt_broadcast_id) {
    return { ok: false, reason: t.yt_source === 'key' ? 'Add the YouTube video link (event screen, YouTube card).' : 'Create the YouTube broadcast first (Start show does it).' };
  }
  const privacy = status?.privacy ?? t.yt_privacy;
  if (privacy === 'private') return { ok: false, reason: 'The YouTube broadcast is private: make it unlisted or public.' };
  if (status?.embeddable === false) return { ok: false, reason: 'Embedding is turned off for this YouTube video (YouTube Studio > video > Allow embedding).' };
  if (status?.madeForKids) return { ok: false, reason: 'The video is set "made for kids": YouTube does not allow it to play on other sites.' };
  return { ok: true, reason: status ? null : 'Not checked with YouTube (pasted video link).' };
}
