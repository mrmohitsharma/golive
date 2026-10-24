import jwt from 'jsonwebtoken';
import type { Config } from './config.js';
import { metaEnabled } from './config.js';
import type { Repo, TournamentRow } from './repo.js';
import type { Sealer } from './crypto.js';
import { HttpError } from './errors.js';

/** Page live needs a Page token with these (developers.facebook.com/docs/live-video-api). */
// pages_read_user_content: read viewers' comments on the Page's live videos.
export const FACEBOOK_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_read_user_content'];

export interface FacebookOrgState {
  enabled: boolean;
  connected: boolean;
  userName: string | null;
  pages: { id: string; name: string }[];
  pageId: string | null;
  pageName: string | null;
}

/**
 * Facebook Page live video for the organisation's Page:
 *  1. "Connect Facebook" once (Facebook Login) → long-lived user token → Page tokens, stored sealed.
 *  2. At "Go live" the server creates a LIVE_NOW live video on the Page and relays the programme
 *     to its RTMPS URL; at "End" it ends the live video (saved on the Page as a video).
 * Eligibility (Meta): Page/profile ≥ 60 days old and ≥ 100 followers.
 */
export class FacebookService {
  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
    private readonly sealer: Sealer,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return metaEnabled(this.config);
  }

  get redirectUri(): string {
    return `${this.config.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/facebook/callback`;
  }

  private graph(path: string): string {
    return `${this.config.META_GRAPH_BASE.replace(/\/$/, '')}/${this.config.META_GRAPH_VERSION}/${path.replace(/^\//, '')}`;
  }

  private ensureEnabled() {
    if (!this.enabled) throw new HttpError(501, 'facebook_not_configured', 'Facebook is not configured on this server (META_APP_ID / META_APP_SECRET).');
  }

  authUrl(orgId: string, userId: string): string {
    this.ensureEnabled();
    const state = jwt.sign({ o: orgId, u: userId, p: 'fb' }, this.config.JWT_SECRET, { expiresIn: '15m', issuer: 'cogolfer-live' });
    const q = new URLSearchParams({
      client_id: this.config.META_APP_ID!,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: FACEBOOK_SCOPES.join(','),
      state,
    });
    return `${this.config.META_AUTH_URL.replace(/\/$/, '')}/${this.config.META_GRAPH_VERSION}/dialog/oauth?${q}`;
  }

  private verifyState(state: string): { orgId: string; userId: string } {
    try {
      const c = jwt.verify(state, this.config.JWT_SECRET, { issuer: 'cogolfer-live' }) as { o: string; u: string; p: string };
      if (c.p !== 'fb') throw new Error('wrong purpose');
      return { orgId: c.o, userId: c.u };
    } catch {
      throw new HttpError(400, 'bad_state', 'This Facebook sign-in link expired. Start again from the app.');
    }
  }

  private async call<T>(method: 'GET' | 'POST', path: string, params: Record<string, string>): Promise<T> {
    const body = new URLSearchParams(params);
    const res =
      method === 'GET'
        ? await this.fetchImpl(`${this.graph(path)}?${body}`)
        : await this.fetchImpl(this.graph(path), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
    if (!res.ok || json.error) {
      const m = json.error?.message ?? `HTTP ${res.status}`;
      const hint = /permission|eligib|follower/i.test(m) ? ' The Page must be at least 60 days old with 100+ followers, and you must be its admin.' : '';
      throw new HttpError(502, 'facebook_api_error', `Facebook: ${m}${hint}`);
    }
    return json as T;
  }

  /** OAuth callback: code → long-lived user token → the Pages this person manages. */
  async completeConnect(code: string, state: string): Promise<{ orgId: string; userName: string; pages: number }> {
    this.ensureEnabled();
    const { orgId, userId } = this.verifyState(state);
    const app = { client_id: this.config.META_APP_ID!, client_secret: this.config.META_APP_SECRET! };
    const short = await this.call<{ access_token?: string }>('GET', 'oauth/access_token', { ...app, redirect_uri: this.redirectUri, code });
    if (!short.access_token) throw new HttpError(502, 'facebook_token_error', 'Facebook did not return an access token.');
    const long = await this.call<{ access_token?: string }>('GET', 'oauth/access_token', {
      ...app,
      grant_type: 'fb_exchange_token',
      fb_exchange_token: short.access_token,
    });
    const userToken = long.access_token ?? short.access_token;
    const me = await this.call<{ name?: string }>('GET', 'me', { fields: 'name', access_token: userToken });
    const acc = await this.call<{ data?: { id: string; name: string; access_token?: string }[] }>('GET', 'me/accounts', {
      fields: 'id,name,access_token',
      limit: '100',
      access_token: userToken,
    });
    const pages = (acc.data ?? []).filter((p) => p.access_token).map((p) => ({ id: p.id, name: p.name, tokenEnc: this.sealer.seal(p.access_token!) }));
    if (!pages.length) {
      throw new HttpError(409, 'no_pages', 'This Facebook account manages no Pages (or did not allow access to them). Use the Page admin’s account.');
    }
    const prev = await this.repo.orgFacebook(orgId);
    const keep = prev?.page_id && pages.some((p) => p.id === prev.page_id) ? prev.page_id : null;
    await this.repo.saveOrgFacebook(orgId, { userName: me.name ?? 'Facebook user', pages, pageId: keep ?? (pages.length === 1 ? pages[0].id : null), userId });
    return { orgId, userName: me.name ?? 'Facebook user', pages: pages.length };
  }

  async orgState(orgId: string): Promise<FacebookOrgState> {
    const row = this.enabled ? await this.repo.orgFacebook(orgId) : null;
    const page = row?.pages.find((p) => p.id === row.page_id) ?? null;
    return {
      enabled: this.enabled,
      connected: Boolean(row),
      userName: row?.user_name ?? null,
      pages: (row?.pages ?? []).map((p) => ({ id: p.id, name: p.name })),
      pageId: page?.id ?? null,
      pageName: page?.name ?? null,
    };
  }

  async selectPage(orgId: string, pageId: string): Promise<FacebookOrgState> {
    const row = await this.repo.orgFacebook(orgId);
    if (!row) throw new HttpError(409, 'facebook_not_connected', 'Connect Facebook first.');
    if (!row.pages.some((p) => p.id === pageId)) throw new HttpError(404, 'page_not_found', 'That Page is not one this account manages.');
    await this.repo.setOrgFacebookPage(orgId, pageId);
    return this.orgState(orgId);
  }

  async disconnect(orgId: string): Promise<void> {
    await this.repo.deleteOrgFacebook(orgId);
  }

  private async pageToken(orgId: string): Promise<{ pageId: string; token: string }> {
    const row = await this.repo.orgFacebook(orgId);
    const page = row?.pages.find((p) => p.id === row.page_id);
    if (!row) throw new HttpError(409, 'facebook_not_connected', 'Connect a Facebook Page for this organisation first.');
    if (!page) throw new HttpError(409, 'facebook_no_page', 'Choose which Facebook Page to stream to (Organisation > Facebook).');
    return { pageId: page.id, token: this.sealer.open(page.tokenEnc) };
  }

  /** Creates the live video that goes public as soon as the relay starts sending. */
  async createLive(t: TournamentRow, opts: { title: string; description: string }): Promise<{ id: string; streamUrl: string; permalink: string | null }> {
    this.ensureEnabled();
    const { pageId, token } = await this.pageToken(t.org_id);
    const live = await this.call<{ id: string; secure_stream_url?: string; stream_url?: string }>('POST', `${pageId}/live_videos`, {
      status: 'LIVE_NOW',
      title: opts.title.slice(0, 250),
      description: opts.description.slice(0, 5000),
      access_token: token,
    });
    const streamUrl = live.secure_stream_url ?? live.stream_url;
    if (!live.id || !streamUrl) throw new HttpError(502, 'facebook_api_error', 'Facebook did not return a stream URL.');
    let permalink: string | null = null;
    try {
      const v = await this.call<{ permalink_url?: string }>('GET', live.id, { fields: 'permalink_url', access_token: token });
      if (v.permalink_url) permalink = v.permalink_url.startsWith('http') ? v.permalink_url : `https://www.facebook.com${v.permalink_url}`;
    } catch {
      // the link is a convenience; streaming works without it
    }
    await this.repo.setFacebookLive(t.id, { liveVideoId: live.id, streamUrlEnc: this.sealer.seal(streamUrl), permalink });
    return { id: live.id, streamUrl, permalink };
  }

  /** Newest comments on the live video first (Page token; needs pages_read_user_content). */
  async liveComments(t: TournamentRow): Promise<{ id: string; message?: string; created_time?: string; from?: { id?: string; name?: string } }[]> {
    if (!t.fb_live_video_id) return [];
    const { token } = await this.pageToken(t.org_id);
    const r = await this.call<{ data?: { id: string; message?: string; created_time?: string; from?: { id?: string; name?: string } }[] }>(
      'GET',
      `${t.fb_live_video_id}/comments`,
      { fields: 'id,message,created_time,from{id,name}', order: 'reverse_chronological', live_filter: 'no_filter', filter: 'stream', limit: '50', access_token: token },
    );
    return r.data ?? [];
  }

  streamUrlFor(t: TournamentRow): string | null {
    return t.fb_stream_url_enc ? this.sealer.open(t.fb_stream_url_enc) : null;
  }

  /** Ends the live video (Facebook keeps it on the Page as a video). Safe to call twice. */
  async endLive(t: TournamentRow): Promise<void> {
    if (!t.fb_live_video_id) return;
    try {
      const { token } = await this.pageToken(t.org_id);
      await this.call('POST', t.fb_live_video_id, { end_live_video: 'true', access_token: token });
    } finally {
      await this.repo.setFacebookLive(t.id, { liveVideoId: null, streamUrlEnc: null, permalink: t.fb_permalink });
    }
  }
}
