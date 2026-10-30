import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Config } from './config.js';
import type { Repo, TournamentRow } from './repo.js';
import { HttpError } from './errors.js';

export type ChatSource = 'watch' | 'youtube' | 'facebook';

export interface ChatRow {
  id: string;
  tournament_id: string;
  source: ChatSource;
  external_id: string | null;
  author: string;
  author_key: string;
  text: string;
  is_question: boolean;
  hidden: boolean;
  pinned: boolean;
  answered: boolean;
  created_at: Date;
}

/** What viewers see. */
export function chatPublicDto(r: ChatRow) {
  return { id: Number(r.id), source: r.source, author: r.author, text: r.text, question: r.is_question, pinned: r.pinned, at: r.created_at.toISOString() };
}

/** What commentators and directors see (includes hidden messages and moderation flags). */
export function chatStaffDto(r: ChatRow) {
  return { ...chatPublicDto(r), hidden: r.hidden, answered: r.answered };
}

export interface SourceStatus {
  state: 'off' | 'reading' | 'error';
  error: string | null;
  lastAt: string | null;
}

interface Feed {
  /** Newest last; the last FEED_SIZE messages including hidden ones. */
  rows: ChatRow[];
  version: number;
  bans: Set<string>;
}

const FEED_SIZE = 200;
const MAX_LEN = 200;
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|in|net|org|io|co|xyz|me|ly|gg|app|link)\b)/i;
const QUESTION_START = /^(q[:.-]|question|how|what|why|who|when|where|which|can|could|will|would|is|are|does|do|did|should|kya|kaise|kaun|kab|kahan|kitn[aei]|kyun|kyon)\b/i;

/** Words masked in every source (English and common Hindi/Hinglish abuse). Extend with CHAT_BLOCKED_WORDS. */
const BLOCKED = [
  'fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bitch', 'bastard', 'asshole', 'dick', 'cunt', 'whore', 'slut', 'retard',
  'chutiya', 'chutiye', 'madarchod', 'maderchod', 'bhenchod', 'behenchod', 'bhosdike', 'bhosadike', 'gaand', 'gandu', 'lund', 'lauda', 'loda', 'randi', 'kutiya', 'jhaatu',
];

export function isQuestion(text: string): boolean {
  const t = text.trim();
  if (t.length < 8) return false;
  if (t.includes('?')) return true;
  // "What a shot!" is an exclamation, not a question.
  return QUESTION_START.test(t) && !/^(what|how) an? /i.test(t) && !t.endsWith('!');
}

export class ChatService {
  private feeds = new Map<string, Feed>();
  private loading = new Map<string, Promise<Feed>>();
  private lastPost = new Map<string, number>();
  private ipHits = new Map<string, number[]>();
  private blocked: RegExp;
  readonly sources = new Map<string, { youtube: SourceStatus; facebook: SourceStatus }>();
  /** Called after any change, so the hub can tell connected staff. */
  onChange: (tournamentId: string) => void = () => {};

  /**
   * YouTube and Facebook comments copied into the combined chat are deleted after 30 days
   * (YouTube API Services policy: stored API data is refreshed or deleted within 30 days).
   * Watch-page messages stay with the event until it is deleted.
   */
  async purgePlatformComments(days = 30): Promise<number> {
    const r = await this.repo.db.query(
      "DELETE FROM chat_messages WHERE source IN ('youtube', 'facebook') AND created_at < now() - make_interval(days => $1)",
      [days],
    );
    return r.rowCount ?? 0;
  }

  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
    private readonly now: () => number = Date.now,
  ) {
    const extra = (config.CHAT_BLOCKED_WORDS ?? '')
      .split(',')
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);
    const words = [...new Set([...BLOCKED, ...extra])].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    this.blocked = new RegExp(`\\b(${words.join('|')})\\b`, 'gi');
  }

  // ------------------------------------------------------------------ feed
  private async feed(tid: string): Promise<Feed> {
    const f = this.feeds.get(tid);
    if (f) return f;
    let p = this.loading.get(tid);
    if (!p) {
      p = (async () => {
        const [rows, bans] = await Promise.all([
          this.repo.db.query<ChatRow>('SELECT * FROM chat_messages WHERE tournament_id = $1 ORDER BY id DESC LIMIT $2', [tid, FEED_SIZE]),
          this.repo.db.query<{ source: string; author_key: string }>('SELECT source, author_key FROM chat_bans WHERE tournament_id = $1', [tid]),
        ]);
        const feed: Feed = { rows: rows.rows.reverse(), version: 1, bans: new Set(bans.rows.map((b) => `${b.source}:${b.author_key}`)) };
        this.feeds.set(tid, feed);
        this.loading.delete(tid);
        return feed;
      })();
      this.loading.set(tid, p);
    }
    return p;
  }

  private changed(tid: string, feed: Feed) {
    feed.version++;
    this.onChange(tid);
  }

  /** Cleans text: one line, length limit, abuse masked. Returns null if nothing is left. */
  clean(text: string): string | null {
    const t = text.replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
    if (!t) return null;
    return t.replace(this.blocked, (w) => w[0] + '*'.repeat(Math.max(1, w.length - 1)));
  }

  /**
   * Adds a message from any source. Duplicates (same YouTube/Facebook id) and banned
   * authors are dropped silently. Returns the stored row or null.
   */
  async add(
    tid: string,
    m: { source: ChatSource; externalId?: string | null; author: string; authorKey: string; text: string; ipHash?: string | null; at?: Date },
  ): Promise<ChatRow | null> {
    const feed = await this.feed(tid);
    if (feed.bans.has(`${m.source}:${m.authorKey}`)) return null;
    const text = this.clean(m.text);
    if (!text) return null;
    const author = m.author.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Viewer';
    const r = await this.repo.db.query<ChatRow>(
      `INSERT INTO chat_messages (tournament_id, source, external_id, author, author_key, text, is_question, ip_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, now()))
       ON CONFLICT (tournament_id, source, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING *`,
      [tid, m.source, m.externalId ?? null, author, m.authorKey, text, isQuestion(text), m.ipHash ?? null, m.at ?? null],
    );
    const row = r.rows[0];
    if (!row) return null;
    feed.rows.push(row);
    if (feed.rows.length > FEED_SIZE) feed.rows.splice(0, feed.rows.length - FEED_SIZE);
    this.changed(tid, feed);
    return row;
  }

  /**
   * Viewers poll this. `v` = the version they have: unchanged → tiny reply. Otherwise the
   * messages after `after`, the ids hidden since (so they disappear), and the pinned one.
   */
  async publicView(t: TournamentRow, after: number, v: number | null) {
    const feed = await this.feed(t.id);
    const base = { enabled: t.chat_enabled !== false, slowSec: t.chat_slow_sec ?? 3, version: feed.version };
    if (v === feed.version) return { ...base, unchanged: true };
    const pinned = [...feed.rows].reverse().find((r) => r.pinned && !r.hidden) ?? null;
    return {
      ...base,
      messages: feed.rows.filter((r) => Number(r.id) > after && !r.hidden).slice(-100).map(chatPublicDto),
      hidden: feed.rows.filter((r) => r.hidden).map((r) => Number(r.id)),
      pinned: pinned ? chatPublicDto(pinned) : null,
    };
  }

  async staffView(t: TournamentRow, v: number | null) {
    const feed = await this.feed(t.id);
    const sources = this.sources.get(t.id) ?? { youtube: offStatus(), facebook: offStatus() };
    const base = { enabled: t.chat_enabled !== false, slowSec: t.chat_slow_sec ?? 3, version: feed.version, sources };
    if (v === feed.version) return { ...base, unchanged: true };
    return { ...base, messages: feed.rows.map(chatStaffDto) };
  }

  settingsChanged(t: TournamentRow) {
    const f = this.feeds.get(t.id);
    if (f) this.changed(t.id, f);
  }

  setSource(tid: string, source: 'youtube' | 'facebook', s: Partial<SourceStatus>) {
    const cur = this.sources.get(tid) ?? { youtube: offStatus(), facebook: offStatus() };
    const prev = cur[source];
    cur[source] = { ...prev, ...s };
    this.sources.set(tid, cur);
    const f = this.feeds.get(tid);
    if (f && (prev.state !== cur[source].state || prev.error !== cur[source].error)) this.changed(tid, f);
  }

  // ------------------------------------------------------------------ watch-page viewers
  /** A viewer types a name once; the token keeps it (and a stable id for slow mode and bans). */
  viewerToken(t: TournamentRow, name: string, ip: string): { token: string; name: string } {
    this.limitIp(ip, 10);
    const clean = this.clean(name)?.slice(0, 30);
    if (!clean || clean.length < 2) throw new HttpError(400, 'bad_name', 'Enter a name of at least 2 letters.');
    if (/\*/.test(clean)) throw new HttpError(400, 'bad_name', 'Please choose another name.');
    const vid = 'v' + crypto.randomBytes(9).toString('hex');
    const token = jwt.sign({ v: vid, n: clean, t: t.id }, this.config.JWT_SECRET, { audience: 'cg-chat', expiresIn: '30d', issuer: 'cogolfer-live' });
    return { token, name: clean };
  }

  private viewer(token: string | undefined, tid: string): { vid: string; name: string } {
    try {
      const c = jwt.verify(token ?? '', this.config.JWT_SECRET, { audience: 'cg-chat', issuer: 'cogolfer-live' }) as { v: string; n: string; t: string };
      if (c.t !== tid) throw new Error('other tournament');
      return { vid: c.v, name: c.n };
    } catch {
      throw new HttpError(401, 'chat_name_needed', 'Enter your name to chat.');
    }
  }

  private limitIp(ip: string, perMinute: number) {
    const key = ipHash(ip);
    const now = this.now();
    const hits = (this.ipHits.get(key) ?? []).filter((x) => now - x < 60_000);
    if (hits.length >= perMinute) throw new HttpError(429, 'too_fast', 'Too many messages from this connection. Wait a minute.');
    hits.push(now);
    this.ipHits.set(key, hits);
    if (this.ipHits.size > 50_000) this.ipHits.clear();
  }

  async post(t: TournamentRow, token: string | undefined, text: string, ip: string): Promise<ChatRow> {
    if (!t.chat_enabled) throw new HttpError(403, 'chat_off', 'Chat is turned off for this broadcast.');
    const v = this.viewer(token, t.id);
    const feed = await this.feed(t.id);
    if (feed.bans.has(`watch:${v.vid}`)) throw new HttpError(403, 'chat_banned', 'You can no longer post in this chat.');
    if (LINK.test(text)) throw new HttpError(400, 'no_links', 'Links are not allowed in the chat.');
    const slow = (t.chat_slow_sec ?? 3) * 1000;
    const last = this.lastPost.get(`${t.id}:${v.vid}`) ?? 0;
    if (this.now() - last < slow) throw new HttpError(429, 'slow_mode', `Slow mode: one message every ${t.chat_slow_sec} seconds.`);
    this.limitIp(ip, 30);
    const row = await this.add(t.id, { source: 'watch', author: v.name, authorKey: v.vid, text, ipHash: ipHash(ip) });
    if (!row) throw new HttpError(400, 'empty_message', 'Type a message first.');
    this.lastPost.set(`${t.id}:${v.vid}`, this.now());
    return row;
  }

  // ------------------------------------------------------------------ moderation
  async byId(id: number): Promise<ChatRow | null> {
    return (await this.repo.db.query<ChatRow>('SELECT * FROM chat_messages WHERE id = $1', [id])).rows[0] ?? null;
  }

  async update(row: ChatRow, patch: { hidden?: boolean; pinned?: boolean; answered?: boolean }): Promise<ChatRow> {
    const feed = await this.feed(row.tournament_id);
    // One pinned message at a time: pinning a new one unpins the previous.
    if (patch.pinned) await this.repo.db.query('UPDATE chat_messages SET pinned = false WHERE tournament_id = $1 AND pinned', [row.tournament_id]);
    const next = (
      await this.repo.db.query<ChatRow>(
        `UPDATE chat_messages SET hidden = COALESCE($2, hidden), pinned = COALESCE($3, pinned), answered = COALESCE($4, answered), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [row.id, patch.hidden ?? null, patch.pinned ?? null, patch.answered ?? null],
      )
    ).rows[0];
    for (let i = 0; i < feed.rows.length; i++) {
      const r = feed.rows[i];
      if (r.id === next.id) feed.rows[i] = next;
      else if (patch.pinned && r.pinned) feed.rows[i] = { ...r, pinned: false };
    }
    this.changed(row.tournament_id, feed);
    return next;
  }

  /** Bans the author of a message from this tournament's chat and hides all their messages. */
  async ban(row: ChatRow, by: string): Promise<number> {
    const feed = await this.feed(row.tournament_id);
    await this.repo.db.query(
      'INSERT INTO chat_bans (tournament_id, source, author_key, author, banned_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
      [row.tournament_id, row.source, row.author_key, row.author, by],
    );
    const r = await this.repo.db.query<{ id: string }>(
      'UPDATE chat_messages SET hidden = true, pinned = false, updated_at = now() WHERE tournament_id = $1 AND source = $2 AND author_key = $3 RETURNING id',
      [row.tournament_id, row.source, row.author_key],
    );
    const ids = new Set(r.rows.map((x) => x.id));
    feed.bans.add(`${row.source}:${row.author_key}`);
    feed.rows = feed.rows.map((x) => (ids.has(x.id) ? { ...x, hidden: true, pinned: false } : x));
    this.changed(row.tournament_id, feed);
    return ids.size;
  }

  /** Lets a banned author post again (their hidden messages stay hidden). */
  async unban(tid: string, source: string, authorKey: string): Promise<void> {
    await this.repo.db.query('DELETE FROM chat_bans WHERE tournament_id = $1 AND source = $2 AND author_key = $3', [tid, source, authorKey]);
    this.feeds.get(tid)?.bans.delete(`${source}:${authorKey}`);
  }
}

function offStatus(): SourceStatus {
  return { state: 'off', error: null, lastAt: null };
}

export function ipHash(ip: string): string {
  return crypto.createHash('sha256').update(`cg-chat:${ip}`).digest('hex').slice(0, 24);

}
