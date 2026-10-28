import type { Config } from './config.js';
import type { Repo, TournamentRow } from './repo.js';
import type { Sealer } from './crypto.js';
import type { YouTubeService } from './youtube.js';
import { watchUrl } from './youtube.js';
import { HttpError } from './errors.js';

export type DestinationPlatform = 'youtube' | 'facebook' | 'instagram' | 'other';
export type Privacy = 'public' | 'unlisted' | 'private';

export type NewDestination =
  | { kind: 'channel'; channelId: string; privacy?: Privacy; label?: string }
  | { kind: 'key'; platform: DestinationPlatform; streamUrl?: string; streamKey: string; label?: string; vertical?: boolean };

export interface DestinationRow {
  id: string;
  tournament_id: string;
  kind: 'channel' | 'key';
  platform: DestinationPlatform;
  label: string;
  channel_id: string | null;
  privacy: Privacy | null;
  yt_broadcast_id: string | null;
  yt_stream_id: string | null;
  url_enc: string | null;
  hint: string | null;
  vertical: boolean;
  enabled: boolean;
  created_at: Date;
  channel_title?: string | null;
}

/** Most extra destinations one event may have (each is one more stream out of the server). */
export const MAX_DESTINATIONS = 10;

/** Usual ingest servers, so a pasted key alone is enough for YouTube and Facebook. */
export const DEFAULT_INGEST: Partial<Record<DestinationPlatform, string>> = {
  youtube: 'rtmps://a.rtmps.youtube.com/live2',
  facebook: 'rtmps://live-api-s.facebook.com:443/rtmp/',
};

/** "rtmps://host/app/" + "key" → one URL. Accepts a URL that already ends in the key. */
export function joinStreamUrl(server: string, key: string): string {
  const s = server.trim();
  const k = key.trim();
  if (!/^rtmps?:\/\/[^\s/]+/i.test(s)) throw new HttpError(400, 'bad_stream_url', 'The stream URL must start with rtmp:// or rtmps:// (copy it from the platform).');
  if (!k) return s;
  return s.endsWith('/') ? `${s}${k}` : `${s}/${k}`;
}

/**
 * Extra places one event streams to, beyond the main YouTube / Facebook / Instagram:
 *  - kind "channel": a YouTube channel connected with Google sign-in. A broadcast is made on
 *    it (auto-start, auto-stop), so it goes live and ends with the show by itself.
 *  - kind "key": any stream URL + key pasted by the organiser (another YouTube channel, a
 *    Facebook profile or Page, an Instagram account, or any RTMP service).
 * The relays (relay.ts) send each one its own copy of the programme.
 */
export class DestinationsService {
  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
    private readonly sealer: Sealer,
    private readonly youtube: YouTubeService,
  ) {}

  async list(tournamentId: string): Promise<DestinationRow[]> {
    return (
      await this.repo.db.query<DestinationRow>(
        `SELECT d.*, c.channel_title FROM event_destinations d LEFT JOIN youtube_channels c ON c.id = d.channel_id
         WHERE d.tournament_id = $1 ORDER BY d.created_at, d.id`,
        [tournamentId],
      )
    ).rows;
  }

  async get(tournamentId: string, id: string): Promise<DestinationRow> {
    const row = (await this.list(tournamentId)).find((d) => d.id === id);
    if (!row) throw new HttpError(404, 'destination_not_found', 'That destination is not on this event.');
    return row;
  }

  /** Enabled destinations that can receive the stream right now. */
  async active(tournamentId: string): Promise<DestinationRow[]> {
    return (await this.list(tournamentId)).filter((d) => d.enabled && d.url_enc);
  }

  async enabledCount(tournamentId: string): Promise<number> {
    return (await this.list(tournamentId)).filter((d) => d.enabled).length;
  }

  urlFor(d: DestinationRow): string | null {
    return d.url_enc ? this.sealer.open(d.url_enc) : null;
  }

  /** Checks a new destination without saving it, so the organiser hears about a bad URL before any limit or payment. */
  async validate(t: TournamentRow, input: NewDestination): Promise<void> {
    if ((await this.list(t.id)).length >= MAX_DESTINATIONS) {
      throw new HttpError(409, 'too_many_destinations', `An event can stream to at most ${MAX_DESTINATIONS} extra destinations.`);
    }
    if (input.kind === 'channel') {
      const ch = (await this.youtube.channels(t.org_id)).find((c) => c.id === input.channelId);
      if (!ch || ch.main) {
        throw new HttpError(404, 'channel_not_found', ch?.main ? 'The main channel is already this event’s YouTube output.' : 'Connect that YouTube channel first.');
      }
      if ((await this.list(t.id)).some((d) => d.channel_id === ch.id)) {
        throw new HttpError(409, 'channel_already_added', `“${ch.title}” is already a destination of this event.`);
      }
      return;
    }
    const server = input.streamUrl?.trim() || DEFAULT_INGEST[input.platform];
    if (!server) throw new HttpError(400, 'stream_url_required', 'Paste the stream URL as well (copy it from the platform).');
    if (!input.streamKey.trim()) throw new HttpError(400, 'stream_key_required', 'Paste the stream key.');
    joinStreamUrl(server, input.streamKey);
  }

  /** Adds a destination. A connected channel gets its broadcast straight away, so problems show now, not at Go live. */
  async add(t: TournamentRow, input: NewDestination): Promise<DestinationRow> {
    await this.validate(t, input);
    if (input.kind === 'channel') {
      const ch = (await this.youtube.channels(t.org_id)).find((c) => c.id === input.channelId)!;
      const privacy = input.privacy ?? 'unlisted';
      const b = await this.youtube.createChannelBroadcast(t.org_id, ch.id, this.broadcastText(t, privacy));
      return this.insert({
        tournament_id: t.id,
        kind: 'channel',
        platform: 'youtube',
        label: input.label?.trim() || ch.title,
        channel_id: ch.id,
        privacy,
        yt_broadcast_id: b.broadcastId,
        yt_stream_id: b.streamId,
        url_enc: this.sealer.seal(b.url),
        hint: null,
        vertical: false,
      });
    }
    const url = joinStreamUrl((input.streamUrl?.trim() || DEFAULT_INGEST[input.platform])!, input.streamKey);
    return this.insert({
      tournament_id: t.id,
      kind: 'key',
      platform: input.platform,
      label: input.label?.trim() || defaultLabel(input.platform),
      channel_id: null,
      privacy: null,
      yt_broadcast_id: null,
      yt_stream_id: null,
      url_enc: this.sealer.seal(url),
      hint: input.streamKey.trim().slice(-4),
      vertical: input.vertical ?? input.platform === 'instagram',
    });
  }

  async update(
    t: TournamentRow,
    id: string,
    patch: { enabled?: boolean; label?: string; streamUrl?: string; streamKey?: string; vertical?: boolean; privacy?: Privacy },
  ): Promise<DestinationRow> {
    const d = await this.get(t.id, id);
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const add = (col: string, val: unknown) => {
      vals.push(val);
      sets.push(`${col} = $${vals.length}`);
    };
    if (patch.enabled !== undefined) add('enabled', patch.enabled);
    if (patch.label !== undefined) add('label', patch.label.trim() || d.label);
    if (patch.vertical !== undefined) add('vertical', patch.vertical);
    if (patch.streamKey !== undefined) {
      if (d.kind !== 'key') throw new HttpError(409, 'not_a_key_destination', 'This destination is a connected channel; it has no stream key to change.');
      const server = patch.streamUrl?.trim() || this.serverOf(d) || DEFAULT_INGEST[d.platform];
      if (!server) throw new HttpError(400, 'stream_url_required', 'Paste the stream URL as well.');
      add('url_enc', this.sealer.seal(joinStreamUrl(server, patch.streamKey)));
      add('hint', patch.streamKey.trim().slice(-4));
    }
    if (patch.privacy !== undefined && d.kind === 'channel') add('privacy', patch.privacy);
    if (sets.length) await this.repo.db.query(`UPDATE event_destinations SET ${sets.join(', ')} WHERE id = $1`, vals);
    return this.get(t.id, id);
  }

  async remove(t: TournamentRow, id: string): Promise<void> {
    await this.get(t.id, id);
    await this.repo.db.query('DELETE FROM event_destinations WHERE id = $1', [id]);
  }

  /**
   * Before "Go live": every enabled connected-channel destination needs a broadcast that has
   * not ended. YouTube ends a broadcast when its stream stops (auto-stop), so a second show of
   * the same event gets a fresh one. Returns problems to show the director; the rest go live.
   */
  async prepare(t: TournamentRow): Promise<string[]> {
    const problems: string[] = [];
    for (const d of await this.list(t.id)) {
      if (!d.enabled || d.kind !== 'channel' || !d.channel_id) continue;
      try {
        let usable = Boolean(d.yt_broadcast_id && d.url_enc);
        if (usable) {
          const life = await this.youtube.channelBroadcastStatus(t.org_id, d.channel_id, d.yt_broadcast_id!);
          usable = life !== null && life !== 'complete' && life !== 'revoked';
        }
        if (!usable) {
          const b = await this.youtube.createChannelBroadcast(t.org_id, d.channel_id, this.broadcastText(t, d.privacy ?? 'unlisted'));
          await this.repo.db.query('UPDATE event_destinations SET yt_broadcast_id = $2, yt_stream_id = $3, url_enc = $4 WHERE id = $1', [
            d.id,
            b.broadcastId,
            b.streamId,
            this.sealer.seal(b.url),
          ]);
        }
      } catch (err) {
        problems.push(`${d.label}: ${(err as Error).message}`);
      }
    }
    return problems;
  }

  linkFor(d: DestinationRow): string | null {
    return d.kind === 'channel' ? watchUrl(d.yt_broadcast_id) : null;
  }

  private broadcastText(t: TournamentRow, privacy: Privacy) {
    return {
      title: `${t.name}${t.venue ? ` · ${t.venue}` : ''}`,
      privacy,
      description: `Live from ${t.venue ?? t.name}. Produced with ${this.config.BRAND_NAME}.`,
    };
  }

  /** The server part of a pasted URL, so a new key can reuse it. */
  private serverOf(d: DestinationRow): string | null {
    if (!d.url_enc) return null;
    const url = this.sealer.open(d.url_enc);
    const i = url.lastIndexOf('/');
    return i > 'rtmps://'.length ? url.slice(0, i + 1) : null;
  }

  private async insert(v: Omit<DestinationRow, 'id' | 'enabled' | 'created_at' | 'channel_title'>): Promise<DestinationRow> {
    const r = await this.repo.db.query<{ id: string }>(
      `INSERT INTO event_destinations (tournament_id, kind, platform, label, channel_id, privacy, yt_broadcast_id, yt_stream_id, url_enc, hint, vertical)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [v.tournament_id, v.kind, v.platform, v.label.slice(0, 80), v.channel_id, v.privacy, v.yt_broadcast_id, v.yt_stream_id, v.url_enc, v.hint, v.vertical],
    );
    return this.get(v.tournament_id, r.rows[0].id);
  }
}

function defaultLabel(p: DestinationPlatform): string {
  return { youtube: 'YouTube (stream key)', facebook: 'Facebook (stream key)', instagram: 'Instagram', other: 'Custom destination' }[p];
}
