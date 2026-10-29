import crypto from 'node:crypto';
import QRCode from 'qrcode';
import type { Config } from './config.js';
import type { Repo, TournamentRow } from './repo.js';
import type { Sealer } from './crypto.js';
import { HttpError } from './errors.js';
import { QUALIFIED_SEC, describeAgent } from './viewership.js';
import { Messenger, normalisePhone } from './messaging.js';

export const INFLUENCER_PLATFORMS = ['instagram', 'youtube', 'facebook', 'whatsapp', 'x', 'other'] as const;

export interface InfluencerRow {
  id: string;
  tournament_id: string;
  name: string;
  handle: string | null;
  platform: (typeof INFLUENCER_PLATFORMS)[number];
  slug: string;
  terms: string | null;
  pan_enc: string | null;
  stats_key: string;
  archived: boolean;
  created_at: Date;
}

export function slugify(s: string, max = 24): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, max)
      .replace(/-$/, '') || 'x'
  );
}

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export interface InfluencerStats {
  id: string;
  name: string;
  handle: string | null;
  platform: string;
  link: string;
  clicks: number;
  viewers: number;
  qualifiedViewers: number;
  bouncedViewers: number;
  watchMinutes: number;
  avgWatchSec: number;
  unmutedRate: number;
  returningViewers: number;
  reminders: number;
  arrivedBeforeLive: number;
  arrivedFirst10Min: number;
  arrivedLater: number;
  watchingNow: number;
}

/**
 * Influencer links (viewership step 2). Each influencer of an event gets a short link
 * /w/<event>/<slug> with its own link preview, a QR code, and a private stats page /i/<key>.
 * A viewer is credited to the first influencer link they opened (within attribution_days).
 */
export class InfluencersService {
  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
    private readonly sealer: Sealer,
    private readonly messenger: Messenger,
    private readonly watchingByRef: (tournamentId: string) => Map<string, number>,
  ) {}

  private get base() {
    return this.config.PUBLIC_BASE_URL.replace(/\/$/, '');
  }

  /** The event's short-link name, made from its name the first time it is needed. */
  async eventSlug(t: TournamentRow): Promise<string> {
    if (t.watch_slug) return t.watch_slug;
    for (let i = 0; i < 5; i++) {
      const slug = `${slugify(t.name, 14)}-${crypto.randomBytes(2).toString('hex')}`;
      const r = await this.repo.db.query('UPDATE tournaments SET watch_slug = $2 WHERE id = $1 AND watch_slug IS NULL', [t.id, slug]).catch(() => null);
      if (r?.rowCount) return slug;
      const now = (await this.repo.tournamentById(t.id))?.watch_slug;
      if (now) return now;
    }
    throw new HttpError(500, 'slug_failed', 'Could not make a link for this event. Try again.');
  }

  linkFor(eventSlug: string, inf: Pick<InfluencerRow, 'slug'>): string {
    return `${this.base}/w/${eventSlug}/${inf.slug}`;
  }

  statsUrl(inf: Pick<InfluencerRow, 'stats_key'>): string {
    return `${this.base}/i/${inf.stats_key}`;
  }

  async list(tournamentId: string, includeArchived = false): Promise<InfluencerRow[]> {
    return (
      await this.repo.db.query<InfluencerRow>(
        `SELECT * FROM influencers WHERE tournament_id = $1 ${includeArchived ? '' : 'AND NOT archived'} ORDER BY created_at, id`,
        [tournamentId],
      )
    ).rows;
  }

  async get(tournamentId: string, id: string): Promise<InfluencerRow> {
    const r = (await this.repo.db.query<InfluencerRow>('SELECT * FROM influencers WHERE id = $1 AND tournament_id = $2', [id, tournamentId])).rows[0];
    if (!r) throw new HttpError(404, 'influencer_not_found', 'That influencer is not on this event.');
    return r;
  }

  async create(
    t: TournamentRow,
    input: { name: string; handle?: string | null; platform?: InfluencerRow['platform']; slug?: string | null; terms?: string | null; pan?: string | null },
  ): Promise<InfluencerRow> {
    const pan = input.pan?.trim().toUpperCase() || null;
    if (pan && !PAN_RE.test(pan)) throw new HttpError(400, 'bad_pan', 'PAN looks wrong: 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F).');
    const want = slugify(input.slug || input.handle?.replace(/^@/, '') || input.name, 20);
    const taken = new Set((await this.list(t.id, true)).map((i) => i.slug));
    let slug = want;
    for (let n = 2; taken.has(slug); n++) slug = `${want}-${n}`;
    await this.eventSlug(t);
    return (
      await this.repo.db.query<InfluencerRow>(
        `INSERT INTO influencers (tournament_id, name, handle, platform, slug, terms, pan_enc, stats_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          t.id,
          input.name.trim(),
          input.handle?.trim() || null,
          input.platform ?? 'instagram',
          slug,
          input.terms?.trim() || null,
          pan ? this.sealer.seal(pan) : null,
          crypto.randomBytes(18).toString('base64url'),
        ],
      )
    ).rows[0];
  }

  async update(
    tournamentId: string,
    id: string,
    patch: { name?: string; handle?: string | null; platform?: InfluencerRow['platform']; terms?: string | null; pan?: string | null; archived?: boolean },
  ): Promise<InfluencerRow> {
    await this.get(tournamentId, id);
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const add = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (patch.name !== undefined) add('name', patch.name.trim());
    if (patch.handle !== undefined) add('handle', patch.handle?.trim() || null);
    if (patch.platform !== undefined) add('platform', patch.platform);
    if (patch.terms !== undefined) add('terms', patch.terms?.trim() || null);
    if (patch.archived !== undefined) add('archived', patch.archived);
    if (patch.pan !== undefined) {
      const pan = patch.pan?.trim().toUpperCase() || null;
      if (pan && !PAN_RE.test(pan)) throw new HttpError(400, 'bad_pan', 'PAN looks wrong: 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F).');
      add('pan_enc', pan ? this.sealer.seal(pan) : null);
    }
    if (sets.length) await this.repo.db.query(`UPDATE influencers SET ${sets.join(', ')} WHERE id = $1`, vals);
    return this.get(tournamentId, id);
  }

  async rotateStatsKey(tournamentId: string, id: string): Promise<InfluencerRow> {
    await this.get(tournamentId, id);
    await this.repo.db.query('UPDATE influencers SET stats_key = $2 WHERE id = $1', [id, crypto.randomBytes(18).toString('base64url')]);
    return this.get(tournamentId, id);
  }

  dto(inf: InfluencerRow, eventSlug: string) {
    const pan = inf.pan_enc ? this.sealer.open(inf.pan_enc) : null;
    return {
      id: inf.id,
      name: inf.name,
      handle: inf.handle,
      platform: inf.platform,
      slug: inf.slug,
      terms: inf.terms,
      panHint: pan ? `${pan.slice(0, 2)}******${pan.slice(-2)}` : null,
      archived: inf.archived,
      link: this.linkFor(eventSlug, inf),
      statsUrl: this.statsUrl(inf),
      createdAt: inf.created_at.toISOString(),
    };
  }

  async qrSvg(link: string): Promise<string> {
    return QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  }

  // ---------------------------------------------------------------- public side
  async byLink(eventSlug: string, slug: string): Promise<{ t: TournamentRow; inf: InfluencerRow | null } | null> {
    const t = (await this.repo.db.query<TournamentRow>('SELECT * FROM tournaments WHERE watch_slug = $1', [eventSlug])).rows[0];
    if (!t || t.archived || !t.public_watch) return null;
    const inf = slug
      ? ((await this.repo.db.query<InfluencerRow>('SELECT * FROM influencers WHERE tournament_id = $1 AND slug = $2 AND NOT archived', [t.id, slug])).rows[0] ?? null)
      : null;
    return { t, inf };
  }

  async byStatsKey(key: string): Promise<InfluencerRow | null> {
    return (await this.repo.db.query<InfluencerRow>('SELECT * FROM influencers WHERE stats_key = $1', [key])).rows[0] ?? null;
  }

  /** The watch page says which link a viewer came from (?r=<slug>). */
  async refIdFor(tournamentId: string, slug: string | null | undefined): Promise<string | null> {
    if (!slug || !/^[a-z0-9-]{1,40}$/.test(slug)) return null;
    return (
      (await this.repo.db.query<{ id: string }>('SELECT id FROM influencers WHERE tournament_id = $1 AND slug = $2 AND NOT archived', [tournamentId, slug])).rows[0]?.id ?? null
    );
  }

  /** A tap on the link. Link previews (WhatsApp, Instagram, Facebook crawlers) and bots are not clicks. */
  async recordClick(inf: InfluencerRow, userAgent: string, live: boolean): Promise<boolean> {
    const a = describeAgent(userAgent);
    if (a.bot || /whatsapp\/|facebookexternalhit|facebot|twitterbot|telegrambot|slackbot|discordbot|linkedinbot|skypeuripreview|googlebot|bingbot/i.test(userAgent)) return false;
    await this.repo.db.query('INSERT INTO influencer_clicks (influencer_id, device, app, live) VALUES ($1, $2, $3, $4)', [inf.id, a.device, a.app, live]);
    return true;
  }

  // ---------------------------------------------------------------- "Remind me"
  async addReminder(t: TournamentRow, phoneInput: string, refId: string | null): Promise<{ created: boolean }> {
    const phone = normalisePhone(phoneInput);
    const r = await this.repo.db.query(
      `INSERT INTO reminders (tournament_id, ref_id, phone, consent_at) VALUES ($1, $2, $3, now()) ON CONFLICT (tournament_id, phone) DO NOTHING`,
      [t.id, refId, phone],
    );
    return { created: Boolean(r.rowCount) };
  }

  /** The stream started: message everyone who asked to be reminded, once. */
  async sendReminders(t: TournamentRow): Promise<number> {
    const rows = (
      await this.repo.db.query<{ id: string; phone: string }>(
        `UPDATE reminders SET sent_at = now() WHERE tournament_id = $1 AND sent_at IS NULL RETURNING id, phone`,
        [t.id],
      )
    ).rows;
    if (!rows.length) return 0;
    const link = `${this.base}/watch/${t.id}`;
    return this.messenger.send(rows.map((r) => ({ kind: 'reminder' as const, phone: r.phone, vars: [t.name.slice(0, 30), link], tournamentId: t.id })));
  }

  // ---------------------------------------------------------------- reports
  async stats(t: TournamentRow): Promise<InfluencerStats[]> {
    const eventSlug = await this.eventSlug(t);
    const infs = await this.list(t.id);
    if (!infs.length) return [];
    const rows = (
      await this.repo.db.query<Record<string, string>>(
        `SELECT i.id,
                (SELECT count(*) FROM influencer_clicks c WHERE c.influencer_id = i.id)::text AS clicks,
                (SELECT count(*) FROM reminders r WHERE r.ref_id = i.id)::text AS reminders,
                count(v.id) FILTER (WHERE v.watched_sec > 0)::text AS viewers,
                count(v.id) FILTER (WHERE v.watched_sec >= $2)::text AS qualified,
                count(v.id) FILTER (WHERE v.watched_sec > 0 AND v.watched_sec < $2)::text AS bounced,
                count(v.id) FILTER (WHERE v.unmuted_sec > 0)::text AS unmuted,
                count(v.id) FILTER (WHERE v.visits > 1)::text AS returning,
                COALESCE(sum(v.watched_sec), 0)::text AS watched,
                count(v.id) FILTER (WHERE v.watched_sec > 0 AND (t.first_live_at IS NULL OR v.first_seen_at < t.first_live_at))::text AS before_live,
                count(v.id) FILTER (WHERE v.watched_sec > 0 AND v.first_seen_at >= t.first_live_at AND v.first_seen_at < t.first_live_at + interval '10 minutes')::text AS first10,
                count(v.id) FILTER (WHERE v.watched_sec > 0 AND v.first_seen_at >= t.first_live_at + interval '10 minutes')::text AS later
           FROM influencers i
           JOIN tournaments t ON t.id = i.tournament_id
           LEFT JOIN viewers v ON v.ref_id = i.id AND NOT v.flagged
          WHERE i.tournament_id = $1 AND NOT i.archived
          GROUP BY i.id`,
        [t.id, QUALIFIED_SEC],
      )
    ).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const now = this.watchingByRef(t.id);
    return infs
      .map((i) => {
        const r = byId.get(i.id) ?? {};
        const n = (k: string) => Number(r[k] ?? 0);
        const viewers = n('viewers');
        return {
          id: i.id,
          name: i.name,
          handle: i.handle,
          platform: i.platform,
          link: this.linkFor(eventSlug, i),
          clicks: n('clicks'),
          viewers,
          qualifiedViewers: n('qualified'),
          bouncedViewers: n('bounced'),
          watchMinutes: Math.round(n('watched') / 60),
          avgWatchSec: viewers ? Math.round(n('watched') / viewers) : 0,
          unmutedRate: viewers ? Math.round((100 * n('unmuted')) / viewers) : 0,
          returningViewers: n('returning'),
          reminders: n('reminders'),
          arrivedBeforeLive: n('before_live'),
          arrivedFirst10Min: n('first10'),
          arrivedLater: n('later'),
          watchingNow: now.get(i.id) ?? 0,
        };
      })
      .sort((a, b) => b.qualifiedViewers - a.qualifiedViewers || b.watchMinutes - a.watchMinutes || b.clicks - a.clicks);
  }
}
