import crypto from 'node:crypto';
import type { Config } from './config.js';
import type { Repo, TournamentRow } from './repo.js';
import type { Mailer } from './email.js';
import type { MediaService } from './replay.js';
import { HttpError } from './errors.js';
import { THEMES } from './branding.js';

/**
 * V9 brand channels: one per club, at <slug>.gogetslive.com (and /c/<slug>). The page shows
 * what is live, what is coming, past events by series and the best clips; viewers follow by
 * email and get an email when the channel goes live and an hour before a scheduled event.
 */

/** Subdomains that can never be a channel (ours, or confusing). */
export const RESERVED = new Set(
  'www app api admin live web watch www2 mail email smtp imap pop ftp cdn static assets media hls srt rtmp support help docs blog status dev staging test demo beta pay payments billing account accounts login signup auth sso secure shop store go golive gogetslive ns ns1 ns2 mx root info contact about terms privacy refunds shipping c e w'.split(' '),
);
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

export interface ChannelLook {
  theme: string;
  accent: string | null;
  logo: { file: string; v: string } | null;
  links: { label: string; url: string }[];
  sponsors: string[];
}

export interface ChannelRow {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  description: string;
  look: Partial<ChannelLook>;
  public: boolean;
  featured_tournament_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const str = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function lookOf(c: Pick<ChannelRow, 'look'>): ChannelLook {
  const l = (c.look ?? {}) as Partial<ChannelLook>;
  return {
    theme: typeof l.theme === 'string' && THEMES.some((t) => t.id === l.theme) ? l.theme : 'conference',
    accent: typeof l.accent === 'string' && /^#[0-9a-f]{6}$/i.test(l.accent) ? l.accent.toLowerCase() : null,
    logo: l.logo && typeof l.logo.file === 'string' && /^[0-9a-f-]{36}-[0-9a-f]{10}\.(png|jpg|webp)$/.test(l.logo.file) ? { file: l.logo.file, v: String(l.logo.v ?? '') } : null,
    links: Array.isArray(l.links)
      ? l.links
          .map((x) => ({ label: str((x as { label?: unknown })?.label, 30), url: str((x as { url?: unknown })?.url, 300) }))
          .filter((x) => x.label && /^https:\/\/[^\s<>"]+$/.test(x.url))
          .slice(0, 8)
      : [],
    sponsors: Array.isArray(l.sponsors) ? l.sponsors.map((x) => str(x, 60)).filter(Boolean).slice(0, 12) : [],
  };
}

export const channelLogoUrl = (l: ChannelLook) => (l.logo ? `/api/public/branding/${l.logo.file}?v=${encodeURIComponent(l.logo.v)}` : null);

export class ChannelService {
  isLive: (tid: string) => boolean = () => false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
    private readonly mailer: Mailer,
    private readonly media: MediaService,
  ) {}

  private get db() {
    return this.repo.db;
  }
  get base() {
    return this.config.PUBLIC_BASE_URL.replace(/\/$/, '');
  }

  /** The channel's own address: https://<slug>.<domain> when the domain is ours, else /c/<slug>. */
  url(slug: string): string {
    const host = (() => {
      try {
        return new URL(this.base).hostname;
      } catch {
        return '';
      }
    })();
    const d = this.config.CHANNEL_DOMAIN.toLowerCase();
    return host === d || host.endsWith('.' + d) ? `https://${slug}.${d}` : `${this.base}/c/${slug}`;
  }

  async byOrg(orgId: string): Promise<ChannelRow | null> {
    return (await this.db.query<ChannelRow>('SELECT * FROM channels WHERE org_id = $1', [orgId])).rows[0] ?? null;
  }
  async bySlug(slug: string): Promise<ChannelRow | null> {
    return (await this.db.query<ChannelRow>('SELECT * FROM channels WHERE slug = $1', [slug.toLowerCase()])).rows[0] ?? null;
  }

  /** Why a slug cannot be used, or null. */
  async slugProblem(slug: string, orgId: string): Promise<string | null> {
    if (!SLUG.test(slug)) return 'Use 3 to 30 small letters, digits or hyphens (not at the start or end).';
    if (RESERVED.has(slug)) return 'That name is reserved. Pick another.';
    const hit = await this.bySlug(slug);
    if (hit && hit.org_id !== orgId) return 'That name is taken. Pick another.';
    return null;
  }

  async save(orgId: string, v: { slug: string; name: string; description?: string; public?: boolean; look?: Partial<ChannelLook>; featuredTournamentId?: string | null }): Promise<ChannelRow> {
    const slug = v.slug.trim().toLowerCase();
    const problem = await this.slugProblem(slug, orgId);
    if (problem) throw new HttpError(400, 'bad_slug', problem);
    const cur = await this.byOrg(orgId);
    const look = lookOf({ look: { ...(cur?.look ?? {}), ...(v.look ?? {}), logo: cur?.look?.logo ?? null } });
    if (v.featuredTournamentId) {
      const t = await this.repo.tournamentById(v.featuredTournamentId);
      if (!t || t.org_id !== orgId) throw new HttpError(400, 'bad_event', 'Pick one of your own events.');
    }
    const r = await this.db.query<ChannelRow>(
      `INSERT INTO channels (org_id, slug, name, description, look, public, featured_tournament_id) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id) DO UPDATE SET slug = $2, name = $3, description = $4, look = $5, public = $6, featured_tournament_id = $7, updated_at = now() RETURNING *`,
      [orgId, slug, str(v.name, 60) || slug, (v.description ?? cur?.description ?? '').trim().slice(0, 600), JSON.stringify(look), v.public ?? cur?.public ?? true, v.featuredTournamentId ?? null],
    );
    return r.rows[0];
  }

  async setLogo(orgId: string, logo: { file: string; v: string } | null): Promise<ChannelRow> {
    const c = await this.byOrg(orgId);
    if (!c) throw new HttpError(409, 'no_channel', 'Save your brand page first.');
    const r = await this.db.query<ChannelRow>('UPDATE channels SET look = $2, updated_at = now() WHERE id = $1 RETURNING *', [c.id, JSON.stringify({ ...c.look, logo })]);
    return r.rows[0];
  }

  /** For an event's watch page: the link back to its brand channel. */
  async link(orgId: string): Promise<{ name: string; url: string } | null> {
    const c = await this.byOrg(orgId);
    return c ? { name: c.name, url: this.url(c.slug) } : null;
  }

  /** Events of the club that the channel shows (public, not archived, not hidden). */
  async events(orgId: string): Promise<TournamentRow[]> {
    return (
      await this.db.query<TournamentRow>(
        `SELECT * FROM tournaments WHERE org_id = $1 AND NOT archived AND public_watch AND NOT channel_hidden ORDER BY coalesce(starts_at, first_live_at, starts_on::timestamptz, created_at) DESC LIMIT 300`,
        [orgId],
      )
    ).rows;
  }

  eventPath(t: Pick<TournamentRow, 'id' | 'watch_slug'>) {
    return `/${t.watch_slug || t.id}`;
  }

  /** What the public channel page needs. */
  async publicView(c: ChannelRow) {
    const look = lookOf(c);
    const theme = THEMES.find((t) => t.id === look.theme) ?? THEMES[0];
    const evs = await this.events(c.org_id);
    const now = Date.now();
    const card = (t: TournamentRow) => ({
      id: t.id,
      name: t.name,
      venue: t.venue,
      series: t.series ?? null,
      path: this.eventPath(t),
      live: this.isLive(t.id),
      startsAt: t.starts_at ? new Date(t.starts_at).toISOString() : null,
      startsOn: t.starts_on,
      wentLiveAt: t.first_live_at ? new Date(t.first_live_at).toISOString() : null,
    });
    const live = evs.filter((t) => this.isLive(t.id)).map(card);
    const upcoming = evs
      .filter((t) => !this.isLive(t.id) && !t.first_live_at && (t.starts_at ? new Date(t.starts_at).getTime() > now - 3 * 3600_000 : t.starts_on ? new Date(t.starts_on + 'T23:59:59+05:30').getTime() > now : false))
      .sort((a, b) => (a.starts_at ? new Date(a.starts_at).getTime() : Date.parse(a.starts_on + 'T09:00:00+05:30')) - (b.starts_at ? new Date(b.starts_at).getTime() : Date.parse(b.starts_on + 'T09:00:00+05:30')))
      .map(card);
    const past = evs.filter((t) => !this.isLive(t.id) && t.first_live_at).map(card);
    const clips = (
      await this.db.query<{ id: string; title: string | null; camera_name: string; hole: number | null; duration_sec: string; tournament_id: string; event_name: string }>(
        `SELECT c.id, c.title, c.camera_name, c.hole, c.duration_sec, c.tournament_id, t.name AS event_name FROM clips c JOIN tournaments t ON t.id = c.tournament_id
          WHERE t.org_id = $1 AND c.status = 'ready' AND c.public AND t.public_watch AND NOT t.archived AND NOT t.channel_hidden ORDER BY c.created_at DESC LIMIT 12`,
        [c.org_id],
      )
    ).rows.map((x) => {
      const l = this.media.shareLinks(x.id);
      return { id: x.id, title: x.title || x.camera_name, event: x.event_name, durationSec: Number(x.duration_sec), thumbUrl: l.thumbUrl, videoUrl: l.landscapeUrl };
    });
    const featured = c.featured_tournament_id ? evs.find((t) => t.id === c.featured_tournament_id) : null;
    // The main player: live, else the next event, else the featured or latest replay.
    const hero = live[0] ? { kind: 'live', event: live[0] } : upcoming[0] ? { kind: 'upcoming', event: upcoming[0] } : featured ? { kind: 'replay', event: card(featured) } : past[0] ? { kind: 'replay', event: past[0] } : null;
    const followers = (await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM channel_followers WHERE channel_id = $1 AND verified_at IS NOT NULL', [c.id])).rows[0].n;
    return {
      channel: {
        slug: c.slug,
        name: c.name,
        description: c.description,
        url: this.url(c.slug),
        logoUrl: channelLogoUrl(look),
        links: look.links,
        sponsors: look.sponsors,
        followers,
        colors: { bg: theme.bg, panel: theme.panel, panel2: theme.panel2, line: theme.line, ink: theme.ink, muted: theme.muted, accent: look.accent ?? theme.accent, live: theme.live },
        font: theme.font,
      },
      hero,
      live,
      upcoming,
      past,
      clips,
    };
  }

  // ---------------------------------------------------------------- followers
  async follow(c: ChannelRow, email: string): Promise<void> {
    const e = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 200) throw new HttpError(400, 'bad_email', 'Type a valid email address.');
    const token = crypto.randomBytes(18).toString('base64url');
    const r = await this.db.query<{ token: string; verified_at: Date | null }>(
      `INSERT INTO channel_followers (channel_id, email, token) VALUES ($1, $2, $3) ON CONFLICT (channel_id, email) DO UPDATE SET email = EXCLUDED.email RETURNING token, verified_at`,
      [c.id, e, token],
    );
    if (r.rows[0].verified_at) return;
    await this.mailer.send({
      to: e,
      subject: `Confirm: follow ${c.name}`,
      body: [`Confirm that you want an email when ${c.name} goes live, and an hour before scheduled events.`, 'If you did not ask for this, ignore this email.'],
      button: { text: 'Yes, follow', url: `${this.base}/follow/${r.rows[0].token}` },
      kind: 'channel_follow',
      ref: `${c.id}:${e}:${Date.now()}`,
      orgId: c.org_id,
    });
  }

  async confirmFollow(token: string): Promise<ChannelRow | null> {
    const r = (await this.db.query<{ channel_id: string }>('UPDATE channel_followers SET verified_at = coalesce(verified_at, now()) WHERE token = $1 RETURNING channel_id', [token])).rows[0];
    if (!r) return null;
    return (await this.db.query<ChannelRow>('SELECT * FROM channels WHERE id = $1', [r.channel_id])).rows[0] ?? null;
  }

  async unfollow(token: string): Promise<ChannelRow | null> {
    const r = (await this.db.query<{ channel_id: string }>('DELETE FROM channel_followers WHERE token = $1 RETURNING channel_id', [token])).rows[0];
    if (!r) return null;
    return (await this.db.query<ChannelRow>('SELECT * FROM channels WHERE id = $1', [r.channel_id])).rows[0] ?? null;
  }

  async followerCount(channelId: string): Promise<{ verified: number; pending: number }> {
    const r = (await this.db.query<{ v: number; p: number }>('SELECT count(*) FILTER (WHERE verified_at IS NOT NULL)::int AS v, count(*) FILTER (WHERE verified_at IS NULL)::int AS p FROM channel_followers WHERE channel_id = $1', [channelId])).rows[0];
    return { verified: r.v, pending: r.p };
  }

  private async mailFollowers(c: ChannelRow, t: TournamentRow, kind: 'live' | 'reminder'): Promise<number> {
    const fs = (await this.db.query<{ email: string; token: string }>('SELECT email, token FROM channel_followers WHERE channel_id = $1 AND verified_at IS NOT NULL', [c.id])).rows;
    const url = this.url(c.slug) + this.eventPath(t);
    for (const f of fs) {
      await this.mailer.send({
        to: f.email,
        subject: kind === 'live' ? `${c.name} is live now: ${t.name}` : `Starting in an hour: ${t.name} on ${c.name}`,
        body: [
          kind === 'live' ? `${t.name} has just gone live on ${c.name}.` : `${t.name} starts in about an hour on ${c.name}.`,
          `[Stop these emails](${this.base}/unfollow/${f.token})`,
        ],
        button: { text: kind === 'live' ? 'Watch now' : 'Open the event', url },
        kind: kind === 'live' ? 'channel_live' : 'channel_reminder',
        ref: `${t.id}:${kind}:${f.email}:${new Date().toISOString().slice(0, 13)}`,
        orgId: c.org_id,
      });
    }
    return fs.length;
  }

  /** A channel event went live: one email to every follower (at most once every 6 hours per event). */
  async wentLive(tid: string): Promise<number> {
    const t = await this.repo.tournamentById(tid);
    if (!t || t.archived || !t.public_watch || t.channel_hidden) return 0;
    const c = await this.byOrg(t.org_id);
    if (!c) return 0;
    const claim = await this.db.query("UPDATE tournaments SET live_alerted_at = now() WHERE id = $1 AND (live_alerted_at IS NULL OR live_alerted_at < now() - interval '6 hours') RETURNING id", [tid]);
    if (!claim.rows[0]) return 0;
    return this.mailFollowers(c, t, 'live');
  }

  /** Every minute: reminders for channel events starting in about an hour. */
  async remindDue(): Promise<number> {
    const due = (
      await this.db.query<TournamentRow>(
        `UPDATE tournaments SET reminded_at = now() WHERE id IN (
           SELECT t.id FROM tournaments t JOIN channels c ON c.org_id = t.org_id
            WHERE t.starts_at BETWEEN now() + interval '50 minutes' AND now() + interval '65 minutes'
              AND t.reminded_at IS NULL AND NOT t.archived AND t.public_watch AND NOT t.channel_hidden AND t.first_live_at IS NULL)
         RETURNING *`,
      )
    ).rows;
    let n = 0;
    for (const t of due) {
      const c = await this.byOrg(t.org_id);
      if (c) n += await this.mailFollowers(c, t, 'reminder');
    }
    return n;
  }

  start(): void {
    this.timer = setInterval(() => void this.remindDue().catch(() => {}), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
