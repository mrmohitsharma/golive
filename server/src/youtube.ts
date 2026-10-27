import jwt from 'jsonwebtoken';
import type { Config } from './config.js';
import { youtubeEnabled } from './config.js';
import type { Repo, TournamentRow } from './repo.js';
import type { Sealer } from './crypto.js';
import { HttpError } from './errors.js';
import type { YoutubeState } from './protocol.js';

export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

/**
 * YouTube Live through the organiser's own channel:
 *  1. "Connect YouTube" once (Google OAuth, offline access) → refresh token stored encrypted.
 *  2. Per tournament, create a broadcast + RTMPS stream and bind them; OBS gets the key automatically.
 *  3. Poll broadcast lifecycle and ingest health for the Director app.
 * API reference: developers.google.com/youtube/v3/live/docs (liveBroadcasts, liveStreams).
 */
export class YouTubeService {
  private accessTokens = new Map<string, { token: string; exp: number }>();

  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
    private readonly sealer: Sealer,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return youtubeEnabled(this.config);
  }

  get redirectUri(): string {
    return `${this.config.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/youtube/callback`;
  }

  private ensureEnabled() {
    if (!this.enabled) {
      throw new HttpError(501, 'youtube_not_configured', 'YouTube is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
    }
  }

  /** Google consent URL. `state` is a signed, 15-minute token naming the org and user. */
  authUrl(orgId: string, userId: string): string {
    this.ensureEnabled();
    const state = jwt.sign({ o: orgId, u: userId, p: 'yt' }, this.config.JWT_SECRET, { expiresIn: '15m', issuer: 'cogolfer-live' });
    const q = new URLSearchParams({
      client_id: this.config.GOOGLE_CLIENT_ID!,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: YOUTUBE_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `${this.config.GOOGLE_AUTH_URL}?${q}`;
  }

  verifyState(state: string): { orgId: string; userId: string } {
    try {
      const c = jwt.verify(state, this.config.JWT_SECRET, { issuer: 'cogolfer-live' }) as { o: string; u: string; p: string };
      if (c.p !== 'yt') throw new Error('wrong purpose');
      return { orgId: c.o, userId: c.u };
    } catch {
      throw new HttpError(400, 'bad_state', 'This YouTube sign-in link expired. Start again from the app.');
    }
  }

  private async token(body: Record<string, string>): Promise<TokenResponse> {
    const res = await this.fetchImpl(this.config.GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.GOOGLE_CLIENT_ID!, client_secret: this.config.GOOGLE_CLIENT_SECRET!, ...body }),
    });
    const json = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || json.error) {
      throw new HttpError(502, 'google_token_error', `Google refused the request: ${json.error_description ?? json.error ?? res.status}`);
    }
    return json;
  }

  /** OAuth callback: exchange the code, read the channel, store the refresh token. */
  async completeConnect(code: string, state: string): Promise<{ orgId: string; channelTitle: string }> {
    this.ensureEnabled();
    const { orgId, userId } = this.verifyState(state);
    const t = await this.token({ code, redirect_uri: this.redirectUri, grant_type: 'authorization_code' });
    if (!t.refresh_token || !t.access_token) {
      throw new HttpError(502, 'no_refresh_token', 'Google did not grant offline access. Remove the app from your Google account permissions and connect again.');
    }
    const channel = await this.myChannel(t.access_token);
    await this.repo.saveOrgYoutube(orgId, {
      channelId: channel.id,
      channelTitle: channel.title,
      refreshTokenEnc: this.sealer.seal(t.refresh_token),
      userId,
    });
    this.accessTokens.set(orgId, { token: t.access_token, exp: Date.now() + ((t.expires_in ?? 3600) - 60) * 1000 });
    return { orgId, channelTitle: channel.title };
  }

  /** Forgets the channel and revokes our access at Google (best effort), as Google's user-data policy asks. */
  async disconnect(orgId: string): Promise<void> {
    this.accessTokens.delete(orgId);
    const row = await this.repo.orgYoutube(orgId).catch(() => null);
    await this.repo.deleteOrgYoutube(orgId);
    if (!row) return;
    try {
      const token = this.sealer.open(row.refresh_token_enc);
      await this.fetchImpl(this.config.GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      });
    } catch {
      /* already revoked or Google unreachable: the token is deleted on our side either way */
    }
  }

  private async accessToken(orgId: string): Promise<string> {
    const cached = this.accessTokens.get(orgId);
    if (cached && cached.exp > Date.now()) return cached.token;
    const row = await this.repo.orgYoutube(orgId);
    if (!row) throw new HttpError(409, 'youtube_not_connected', 'Connect a YouTube channel for this organisation first.');
    const t = await this.token({ refresh_token: this.sealer.open(row.refresh_token_enc), grant_type: 'refresh_token' });
    if (!t.access_token) throw new HttpError(502, 'google_token_error', 'Google did not return an access token.');
    this.accessTokens.set(orgId, { token: t.access_token, exp: Date.now() + ((t.expires_in ?? 3600) - 60) * 1000 });
    return t.access_token;
  }

  private async call<T>(accessToken: string, method: string, path: string, query: Record<string, string>, body?: unknown): Promise<T> {
    const url = `${this.config.YOUTUBE_API_BASE}/${path}?${new URLSearchParams(query)}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: { reason?: string }[] } };
    if (!res.ok) {
      const reason = json.error?.errors?.[0]?.reason;
      if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
        throw new HttpError(429, 'youtube_quota', 'YouTube API quota for today is used up (it resets at midnight Pacific time).');
      }
      if (reason === 'liveChatEnded' || reason === 'liveChatNotFound' || reason === 'liveChatDisabled') {
        throw new HttpError(409, 'youtube_chat_unavailable', reason === 'liveChatDisabled' ? 'Live chat is turned off for this YouTube broadcast.' : 'The YouTube live chat has ended.');
      }
      const hint =
        reason === 'liveStreamingNotEnabled'
          ? ' Live streaming is not enabled on this channel yet (enable it in YouTube Studio; the first time takes up to 24 hours).'
          : '';
      throw new HttpError(502, 'youtube_api_error', `YouTube: ${json.error?.message ?? `HTTP ${res.status}`}${hint}`);
    }
    return json as T;
  }

  async myChannel(accessToken: string): Promise<{ id: string; title: string }> {
    const r = await this.call<{ items?: { id: string; snippet?: { title?: string } }[] }>(accessToken, 'GET', 'channels', {
      part: 'snippet',
      mine: 'true',
    });
    const ch = r.items?.[0];
    if (!ch) throw new HttpError(409, 'no_channel', 'This Google account has no YouTube channel. Create one in YouTube first.');
    return { id: ch.id, title: ch.snippet?.title ?? 'YouTube channel' };
  }

  /** Creates broadcast + stream, binds them, and stores the RTMPS ingest on the tournament. */
  async createBroadcast(t: TournamentRow, opts: { title: string; privacy: 'public' | 'unlisted' | 'private'; description?: string }) {
    this.ensureEnabled();
    const at = await this.accessToken(t.org_id);
    const start = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const broadcast = await this.call<{ id: string }>(at, 'POST', 'liveBroadcasts', { part: 'snippet,status,contentDetails' }, {
      snippet: { title: opts.title.slice(0, 100), description: (opts.description ?? '').slice(0, 5000), scheduledStartTime: start },
      status: { privacyStatus: opts.privacy, selfDeclaredMadeForKids: false },
      contentDetails: {
        enableAutoStart: true,
        enableAutoStop: true,
        enableDvr: true,
        // Lets the CoGolfers website (and the /watch page) show the live player.
        enableEmbed: true,
        latencyPreference: 'low',
        monitorStream: { enableMonitorStream: false },
      },
    });
    const stream = await this.call<{
      id: string;
      cdn?: { ingestionInfo?: { streamName?: string; ingestionAddress?: string; rtmpsIngestionAddress?: string } };
    }>(at, 'POST', 'liveStreams', { part: 'snippet,cdn,contentDetails,status' }, {
      snippet: { title: `${opts.title.slice(0, 80)} (CoGolfer Live)` },
      cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' },
      contentDetails: { isReusable: false },
    });
    await this.call(at, 'POST', 'liveBroadcasts/bind', { id: broadcast.id, part: 'id,contentDetails', streamId: stream.id });
    const info = stream.cdn?.ingestionInfo ?? {};
    const ingestUrl = info.rtmpsIngestionAddress ?? info.ingestionAddress;
    if (!ingestUrl || !info.streamName) throw new HttpError(502, 'youtube_api_error', 'YouTube did not return an ingest address.');
    await this.repo.setYoutubeBroadcast(t.id, {
      broadcastId: broadcast.id,
      streamId: stream.id,
      streamKeyEnc: this.sealer.seal(info.streamName),
      ingestUrl,
      privacy: opts.privacy,
    });
    return { broadcastId: broadcast.id, streamId: stream.id, ingestUrl, watchUrl: watchUrl(broadcast.id) };
  }

  async forgetBroadcast(t: TournamentRow) {
    await this.repo.setYoutubeBroadcast(t.id, { broadcastId: null, streamId: null, streamKeyEnc: null, ingestUrl: null, privacy: null });
  }

  /** RTMP(S) destination for OBS, if a broadcast exists. */
  ingestFor(t: TournamentRow): { server: string; key: string } | null {
    if (!t.yt_ingest_url || !t.yt_stream_key_enc) return null;
    return { server: t.yt_ingest_url, key: this.sealer.open(t.yt_stream_key_enc) };
  }

  /** The broadcast's live chat id (exists once the broadcast is created; chat must be on). */
  async liveChatId(t: TournamentRow): Promise<string | null> {
    if (!t.yt_broadcast_id) return null;
    const at = await this.accessToken(t.org_id);
    const r = await this.call<{ items?: { snippet?: { liveChatId?: string } }[] }>(at, 'GET', 'liveBroadcasts', { part: 'snippet', id: t.yt_broadcast_id });
    return r.items?.[0]?.snippet?.liveChatId ?? null;
  }

  /** One page of live chat (5 quota units). Follow `nextPageToken`; wait at least `pollingIntervalMillis`. */
  async chatPage(t: TournamentRow, liveChatId: string, pageToken?: string | null) {
    const at = await this.accessToken(t.org_id);
    return this.call<{ items?: YoutubeChatItem[]; nextPageToken?: string; pollingIntervalMillis?: number }>(at, 'GET', 'liveChat/messages', {
      liveChatId,
      part: 'snippet,authorDetails',
      maxResults: '200',
      ...(pageToken ? { pageToken } : {}),
    });
  }

  async status(t: TournamentRow): Promise<Partial<YoutubeState>> {
    if (!t.yt_broadcast_id || !t.yt_stream_id) return {};
    const at = await this.accessToken(t.org_id);
    const [b, s] = await Promise.all([
      this.call<{ items?: { status?: { lifeCycleStatus?: string } }[] }>(at, 'GET', 'liveBroadcasts', { part: 'status', id: t.yt_broadcast_id }),
      this.call<{
        items?: { status?: { streamStatus?: string; healthStatus?: { status?: string; configurationIssues?: { description?: string; severity?: string }[] } } }[];
      }>(at, 'GET', 'liveStreams', { part: 'status', id: t.yt_stream_id }),
    ]);
    const st = s.items?.[0]?.status;
    return {
      lifeCycleStatus: b.items?.[0]?.status?.lifeCycleStatus ?? null,
      streamStatus: st?.streamStatus ?? null,
      health: st?.healthStatus?.status ?? null,
      issues: (st?.healthStatus?.configurationIssues ?? [])
        .filter((i) => i.severity !== 'info')
        .map((i) => i.description ?? '')
        .filter(Boolean)
        .slice(0, 3),
    };
  }
}

export interface YoutubeChatItem {
  id: string;
  snippet?: { type?: string; displayMessage?: string; publishedAt?: string };
  authorDetails?: { displayName?: string; channelId?: string };
}

export function watchUrl(broadcastId: string | null): string | null {
  return broadcastId ? `https://www.youtube.com/watch?v=${broadcastId}` : null;
}
