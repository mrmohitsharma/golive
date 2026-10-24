import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Repo, TournamentOutputs, TournamentRow } from './repo.js';
import type { Sealer } from './crypto.js';
import type { YouTubeService } from './youtube.js';
import type { FacebookService } from './facebook.js';
import { HttpError } from './errors.js';
import { engineOutputUrl, internalRtspUrl, programmePath } from './media.js';
import { PLATFORMS, type Platform, type RelayManager, type RelayTarget, type RelayStatus } from './relay.js';
import { watchUrl } from './youtube.js';

export interface PlatformState {
  platform: Platform;
  /** Account / key in place (YouTube broadcast created, Facebook Page chosen, Instagram key pasted). */
  configured: boolean;
  /** The director wants this platform for this tournament. */
  enabled: boolean;
  /** off = not sending; connecting / live / retrying while the stream is on. */
  state: 'off' | RelayStatus['state'];
  since: string | null;
  error: string | null;
  /** Where viewers watch (YouTube video, Facebook live video). */
  link: string | null;
  /** Instagram: last characters of the pasted key, to recognise it. */
  hint: string | null;
}

export interface OutputsState {
  /** OBS sends one stream to this server and the server restreams it. */
  relay: boolean;
  platforms: PlatformState[];
}

/**
 * Multistreaming: OBS sends ONE programme stream to MediaMTX; this service decides which
 * platforms get it and drives the relays (RelayManager). YouTube and Facebook broadcasts are
 * created through their APIs; Instagram has no API, so the director pastes the stream URL and
 * key from instagram.com (Live Producer) before each event.
 */
export class OutputsService {
  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
    private readonly sealer: Sealer,
    private readonly youtube: YouTubeService,
    private readonly facebook: FacebookService,
    private readonly relay: RelayManager,
    private readonly log: FastifyBaseLogger,
  ) {}

  private wants(t: TournamentRow, p: Platform): boolean {
    const o = t.outputs ?? {};
    if (p === 'youtube') return o.youtube?.enabled !== false;
    return o[p]?.enabled === true;
  }

  private async configured(t: TournamentRow): Promise<Record<Platform, boolean>> {
    const fb = this.facebook.enabled ? await this.repo.orgFacebook(t.org_id) : null;
    return {
      youtube: Boolean(this.youtube.ingestFor(t)),
      facebook: Boolean(fb?.page_id),
      instagram: Boolean(t.outputs?.instagram?.urlEnc),
    };
  }

  /** Platforms that will receive the stream when the director goes live. */
  async active(t: TournamentRow): Promise<Platform[]> {
    const c = await this.configured(t);
    return PLATFORMS.filter((p) => c[p] && this.wants(t, p));
  }

  /** What OBS should stream to: this server when any platform is set up, else whatever OBS/agent has. */
  async engineOutput(t: TournamentRow): Promise<{ server: string; key: string } | null> {
    if (!(await this.active(t)).length) return null;
    const key = await this.repo.ensureOutputKey(t);
    return { server: engineOutputUrl(this.config, t.id, key, t.production_mode), key: '' };
  }

  async state(t: TournamentRow): Promise<OutputsState> {
    const c = await this.configured(t);
    const running = new Map(this.relay.status(t.id).map((s) => [s.platform, s]));
    const relay = PLATFORMS.some((p) => c[p] && this.wants(t, p));
    return {
      relay,
      platforms: PLATFORMS.map((p) => {
        const r = running.get(p);
        return {
          platform: p,
          configured: c[p],
          enabled: this.wants(t, p),
          state: r?.state ?? 'off',
          since: r?.since ?? null,
          error: r?.error ?? null,
          link: p === 'youtube' ? watchUrl(t.yt_broadcast_id) : p === 'facebook' ? t.fb_permalink : null,
          hint: p === 'instagram' ? (t.outputs?.instagram?.hint ?? null) : null,
        };
      }),
    };
  }

  async update(
    t: TournamentRow,
    patch: { youtube?: { enabled?: boolean }; facebook?: { enabled?: boolean }; instagram?: { enabled?: boolean; streamUrl?: string; streamKey?: string; clear?: boolean } },
  ): Promise<TournamentRow> {
    const o: TournamentOutputs = structuredClone(t.outputs ?? {});
    if (patch.youtube?.enabled !== undefined) o.youtube = { ...o.youtube, enabled: patch.youtube.enabled };
    if (patch.facebook?.enabled !== undefined) {
      if (patch.facebook.enabled && !(await this.configured(t)).facebook) {
        throw new HttpError(409, 'facebook_not_ready', 'Connect the club’s Facebook Page first (Organisation > Facebook).');
      }
      o.facebook = { ...o.facebook, enabled: patch.facebook.enabled };
    }
    const ig = patch.instagram;
    if (ig) {
      const next = { ...o.instagram };
      if (ig.clear) {
        next.urlEnc = null;
        next.hint = null;
        next.enabled = false;
      }
      if (ig.streamUrl !== undefined || ig.streamKey !== undefined) {
        const url = joinStreamUrl(ig.streamUrl ?? '', ig.streamKey ?? '');
        next.urlEnc = this.sealer.seal(url);
        next.hint = (ig.streamKey ?? url).slice(-4);
        if (ig.enabled === undefined) next.enabled = true;
      }
      if (ig.enabled !== undefined) {
        if (ig.enabled && !next.urlEnc) throw new HttpError(409, 'instagram_no_key', 'Paste the Instagram stream URL and key first.');
        next.enabled = ig.enabled;
      }
      o.instagram = next;
    }
    return (await this.repo.setOutputs(t.id, o))!;
  }

  /** "Go live" pressed: create the platform broadcasts that need one per stream (Facebook). */
  async prepare(t: TournamentRow): Promise<string[]> {
    const problems: string[] = [];
    const active = await this.active(t);
    if (active.includes('facebook') && !t.fb_live_video_id) {
      try {
        await this.facebook.createLive(t, {
          title: `${t.name}${t.venue ? ` · ${t.venue}` : ''}`,
          description: `Live from ${t.venue ?? t.name}. Produced with CoGolfer Live.`,
        });
      } catch (err) {
        problems.push((err as Error).message);
      }
    }
    return problems;
  }

  /** Starts / adjusts / stops the relays to match what is wanted, given whether OBS is streaming. */
  async reconcile(t: TournamentRow, streaming: boolean): Promise<void> {
    if (!streaming) {
      if (this.relay.isRunning(t.id)) this.relay.stop(t.id);
      return;
    }
    const active = await this.active(t);
    if (!active.length) return this.relay.stop(t.id);
    const fresh = (await this.repo.tournamentById(t.id)) ?? t;
    const targets: RelayTarget[] = [];
    for (const p of active) {
      const url = this.urlFor(fresh, p);
      if (url) targets.push({ platform: p, url, vertical: p === 'instagram' });
    }
    this.relay.setTargets(t.id, internalRtspUrl(this.config, programmePath(t.id)), targets);
  }

  /** "End stream": stop relays and close the Facebook live video. */
  async ended(t: TournamentRow): Promise<void> {
    this.relay.stop(t.id);
    const fresh = (await this.repo.tournamentById(t.id)) ?? t;
    if (fresh.fb_live_video_id) {
      await this.facebook.endLive(fresh).catch((err) => this.log.warn({ err: (err as Error).message }, 'facebook end failed'));
    }
  }

  private urlFor(t: TournamentRow, p: Platform): string | null {
    if (p === 'youtube') {
      const yt = this.youtube.ingestFor(t);
      return yt ? joinStreamUrl(yt.server, yt.key) : null;
    }
    if (p === 'facebook') return this.facebook.streamUrlFor(t);
    const enc = t.outputs?.instagram?.urlEnc;
    return enc ? this.sealer.open(enc) : null;
  }
}

/** "rtmps://host/rtmp/" + "key" → one URL. Accepts a URL that already ends in the key. */
export function joinStreamUrl(server: string, key: string): string {
  const s = server.trim();
  const k = key.trim();
  if (!/^rtmps?:\/\/[^\s/]+/i.test(s)) throw new HttpError(400, 'bad_stream_url', 'The stream URL must start with rtmps:// (copy it from the platform).');
  if (!k) return s;
  return s.endsWith('/') ? `${s}${k}` : `${s}/${k}`;
}
