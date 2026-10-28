import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, expectOk, signup, startHarness, type Harness } from './helpers.js';

/** Fake Google: the platform channel signs in with code "platform-code", an organiser's with "org-code". */
function fakeGoogle() {
  const calls: { method: string; path: string; auth: string | null; body: any }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization');
    const raw = init?.body ? String(init.body) : '';
    const body = raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ method, path: url.pathname, auth, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/token') {
      if (body.code === 'platform-code') return json(200, { access_token: 'at-platform', expires_in: 3600, refresh_token: 'rt-platform' });
      if (body.code === 'org-code') return json(200, { access_token: 'at-org', expires_in: 3600, refresh_token: 'rt-org' });
      if (body.refresh_token === 'rt-platform') return json(200, { access_token: 'at-platform', expires_in: 3600 });
      if (body.refresh_token === 'rt-org') return json(200, { access_token: 'at-org', expires_in: 3600 });
      return json(400, { error: 'invalid_grant' });
    }
    if (url.pathname === '/revoke') return json(200, {});
    if (url.pathname === '/yt/channels') {
      return json(200, { items: [auth === 'Bearer at-platform' ? { id: 'UCGOLIVE', snippet: { title: 'Go Live TV' } } : { id: 'UCORG', snippet: { title: 'Club TV' } }] });
    }
    if (url.pathname === '/yt/liveBroadcasts' && method === 'POST') return json(200, { id: 'bc-1' });
    if (url.pathname === '/yt/liveStreams' && method === 'POST') return json(200, { id: 'st-1', cdn: { ingestionInfo: { streamName: 'key-1', rtmpsIngestionAddress: 'rtmps://a.rtmps.youtube.com/live2' } } });
    if (url.pathname === '/yt/liveBroadcasts/bind') return json(200, {});
    return json(404, { error: { message: `fake: ${method} ${url.pathname}` } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('the Go Live channel (no YouTube of your own needed)', () => {
  let h: Harness;
  let adminToken: string;
  const google = fakeGoogle();

  const connect = async (url: string, code: string) => {
    const state = new URL(url).searchParams.get('state')!;
    const r = await fetch(`${h.baseUrl}/api/youtube/callback?code=${code}&state=${encodeURIComponent(state)}`);
    return { status: r.status, text: await r.text() };
  };

  before(async () => {
    h = await startHarness({
      googleFetch: google.fetchImpl,
      env: {
        GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'secret-xyz',
        GOOGLE_AUTH_URL: 'https://fake-google/auth',
        GOOGLE_TOKEN_URL: 'https://fake-google/token',
        GOOGLE_REVOKE_URL: 'https://fake-google/revoke',
        YOUTUBE_API_BASE: 'https://fake-google/yt',
      },
    });
    const a = await signup(h, 'admin@golive.test', 'Go Live HQ');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [a.userId]);
    adminToken = a.token;
  });
  after(async () => h.close());

  it('an administrator connects the channel from /admin', async () => {
    const before0 = await expectOk(api(h, 'GET', '/api/admin/golive-channel', undefined, adminToken));
    assert.deepEqual(before0, { youtubeConfigured: true, channel: null });
    const { url } = await expectOk(api(h, 'POST', '/api/admin/golive-channel/connect', undefined, adminToken));
    const cb = await connect(url, 'platform-code');
    assert.equal(cb.status, 200);
    assert.match(cb.text, /Go Live channel connected/);
    const after0 = await expectOk(api(h, 'GET', '/api/admin/golive-channel', undefined, adminToken));
    assert.equal(after0.channel.channelTitle, 'Go Live TV');
    assert.equal(after0.channel.enabled, true);
    const other = await signup(h, 'nobody@club.test', 'Nobody');
    assert.equal((await api(h, 'GET', '/api/admin/golive-channel', undefined, other.token)).status, 403);
  });

  it('a brand-new organiser with no YouTube goes live on it: unlisted, titled with their name', async () => {
    const o = await signup(h, 'new@club.test', 'Riverside School');
    const r = await expectOk(api(h, 'POST', `/api/orgs/${o.orgId}/tournaments`, { name: 'Sports Day' }, o.token));
    const tid = r.tournament.id;
    const st = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/state`, undefined, o.token));
    assert.deepEqual([st.youtube.source, st.youtube.connected, st.youtube.channelTitle, st.youtube.goliveAvailable], ['golive', true, 'Go Live TV', true]);
    google.calls.length = 0;
    const b = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/youtube/broadcast`, {}, o.token));
    assert.equal(b.broadcast.watchUrl, 'https://www.youtube.com/watch?v=bc-1');
    const insert = google.calls.find((c) => c.path === '/yt/liveBroadcasts' && c.method === 'POST')!;
    assert.equal(insert.auth, 'Bearer at-platform');
    assert.equal(insert.body.snippet.title, 'Sports Day by Riverside School');
    assert.equal(insert.body.status.privacyStatus, 'unlisted');
  });

  it('an organiser with their own channel starts on it, and can switch either way', async () => {
    const o = await signup(h, 'club@club.test', 'Club');
    const { url } = await expectOk(api(h, 'POST', `/api/orgs/${o.orgId}/youtube/connect`, undefined, o.token));
    await connect(url, 'org-code');
    const r = await expectOk(api(h, 'POST', `/api/orgs/${o.orgId}/tournaments`, { name: 'Club Cup' }, o.token));
    const tid = r.tournament.id;
    let st = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/state`, undefined, o.token));
    assert.deepEqual([st.youtube.source, st.youtube.channelTitle], ['org', 'Club TV']);
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/youtube/broadcast`, {}, o.token));
    const sw = await expectOk(api(h, 'PUT', `/api/tournaments/${tid}/youtube/source`, { source: 'golive' }, o.token));
    assert.deepEqual([sw.youtube.source, sw.youtube.broadcastId], ['golive', null], 'the other channel’s broadcast is dropped');
    st = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/state`, undefined, o.token));
    assert.equal(st.youtube.channelTitle, 'Go Live TV');
  });

  it('switched off in /admin: no new events on it, and choosing it is refused', async () => {
    await expectOk(api(h, 'PATCH', '/api/admin/golive-channel', { enabled: false }, adminToken));
    const o = await signup(h, 'late@club.test', 'Late');
    const r = await expectOk(api(h, 'POST', `/api/orgs/${o.orgId}/tournaments`, { name: 'Late Cup' }, o.token));
    const st = await expectOk(api(h, 'GET', `/api/tournaments/${r.tournament.id}/state`, undefined, o.token));
    assert.deepEqual([st.youtube.source, st.youtube.goliveAvailable], ['org', false]);
    const sw = await api(h, 'PUT', `/api/tournaments/${r.tournament.id}/youtube/source`, { source: 'golive' }, o.token);
    assert.equal(sw.body.error.code, 'golive_channel_off');
    await expectOk(api(h, 'DELETE', '/api/admin/golive-channel', undefined, adminToken));
    assert.ok(google.calls.some((c) => c.path === '/revoke' && c.body.token === 'rt-platform'));
  });
});
