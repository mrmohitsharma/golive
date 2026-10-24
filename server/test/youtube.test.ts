import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addStaff, api, createTournament, engineToken, expectOk, signup, startHarness, TestSocket, type Harness } from './helpers.js';

/**
 * Fake Google OAuth + YouTube Data API v3. Implements the exact endpoints and fields the
 * server uses (token, channels, liveBroadcasts insert/bind/list, liveStreams insert/list)
 * and records every call so the test can check request shapes.
 */
function fakeGoogle() {
  const calls: { method: string; url: URL; body: any; auth: string | null }[] = [];
  let refreshCount = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization');
    const raw = init?.body ? String(init.body) : '';
    const body = raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ method, url, body, auth });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    if (url.pathname === '/token') {
      if (body.grant_type === 'authorization_code') {
        if (body.code !== 'good-code') return json(400, { error: 'invalid_grant', error_description: 'Bad code' });
        return json(200, { access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-secret', scope: 'https://www.googleapis.com/auth/youtube', token_type: 'Bearer' });
      }
      if (body.grant_type === 'refresh_token' && body.refresh_token === 'rt-secret') {
        refreshCount++;
        return json(200, { access_token: `at-refreshed-${refreshCount}`, expires_in: 3600, token_type: 'Bearer' });
      }
      return json(400, { error: 'invalid_grant' });
    }
    if (!auth?.startsWith('Bearer at-')) return json(401, { error: { message: 'Invalid Credentials' } });
    if (url.pathname === '/yt/channels') return json(200, { items: [{ id: 'UC123', snippet: { title: 'CoGolfers TV' } }] });
    if (url.pathname === '/yt/liveBroadcasts' && method === 'POST') return json(200, { id: 'bcast-1', ...body });
    if (url.pathname === '/yt/liveStreams' && method === 'POST') {
      return json(200, {
        id: 'stream-1',
        cdn: { ...body.cdn, ingestionInfo: { streamName: 'abcd-efgh-ijkl', ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', rtmpsIngestionAddress: 'rtmps://a.rtmps.youtube.com/live2' } },
      });
    }
    if (url.pathname === '/yt/liveBroadcasts/bind') return json(200, { id: url.searchParams.get('id'), contentDetails: { boundStreamId: url.searchParams.get('streamId') } });
    if (url.pathname === '/yt/liveBroadcasts' && method === 'GET') return json(200, { items: [{ id: 'bcast-1', status: { lifeCycleStatus: 'live' } }] });
    if (url.pathname === '/yt/liveStreams' && method === 'GET') {
      return json(200, {
        items: [{ id: 'stream-1', status: { streamStatus: 'active', healthStatus: { status: 'ok', configurationIssues: [{ severity: 'warning', description: 'Bitrate lower than recommended' }, { severity: 'info', description: 'ignored' }] } } }],
      });
    }
    return json(404, { error: { message: `fake: no route ${method} ${url.pathname}` } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('YouTube: connect once, broadcasts created automatically', () => {
  let h: Harness;
  let owner: { token: string; orgId: string };
  let directorToken: string;
  let tournamentId: string;
  const google = fakeGoogle();

  before(async () => {
    h = await startHarness({
      googleFetch: google.fetchImpl,
      env: {
        GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'secret-xyz',
        GOOGLE_AUTH_URL: 'https://fake-google/auth',
        GOOGLE_TOKEN_URL: 'https://fake-google/token',
        YOUTUBE_API_BASE: 'https://fake-google/yt',
      },
    });
    owner = await signup(h, 'owner@club.test');
    directorToken = await addStaff(h, owner.token, owner.orgId, 'd@club.test', 'director');
    tournamentId = await createTournament(h, owner.token, owner.orgId, { name: 'NCR Open 2026', venue: 'DLF Golf' });
  });
  after(async () => h.close());

  it('only owners can start the connection; the consent URL asks for offline YouTube access', async () => {
    assert.equal((await api(h, 'POST', `/api/orgs/${owner.orgId}/youtube/connect`, undefined, directorToken)).status, 403);
    const r = await expectOk(api(h, 'POST', `/api/orgs/${owner.orgId}/youtube/connect`, undefined, owner.token));
    const u = new URL(r.url);
    assert.equal(u.origin + u.pathname, 'https://fake-google/auth');
    assert.equal(u.searchParams.get('client_id'), 'client-123.apps.googleusercontent.com');
    assert.equal(u.searchParams.get('redirect_uri'), 'https://live.example.com/api/youtube/callback');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube');
    assert.equal(u.searchParams.get('access_type'), 'offline');
    assert.equal(u.searchParams.get('prompt'), 'consent');
    // Google redirects the browser back: bad code, forged state, then the real one.
    const state = u.searchParams.get('state')!;
    const bad = await fetch(`${h.baseUrl}/api/youtube/callback?code=nope&state=${state}`);
    assert.equal(bad.status, 502);
    const forged = await fetch(`${h.baseUrl}/api/youtube/callback?code=good-code&state=forged`);
    assert.equal(forged.status, 400);
    const ok = await fetch(`${h.baseUrl}/api/youtube/callback?code=good-code&state=${state}`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /CoGolfers TV/);
    const status = await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/youtube`, undefined, directorToken));
    assert.deepEqual({ connected: status.connected, title: status.channelTitle }, { connected: true, title: 'CoGolfers TV' });
    const row = await h.app.repo.orgYoutube(owner.orgId);
    assert.ok(!row!.refresh_token_enc.includes('rt-secret'), 'refresh token is encrypted at rest');
  });

  it('a director creates the broadcast: broadcast + RTMPS stream are created and bound', async () => {
    const r = await expectOk(api(h, 'POST', `/api/tournaments/${tournamentId}/youtube/broadcast`, { privacy: 'unlisted' }, directorToken), 201);
    assert.equal(r.broadcast.watchUrl, 'https://www.youtube.com/watch?v=bcast-1');
    assert.equal(r.broadcast.ingestUrl, 'rtmps://a.rtmps.youtube.com/live2');
    const insert = google.calls.find((c) => c.url.pathname === '/yt/liveBroadcasts' && c.method === 'POST')!;
    assert.equal(insert.url.searchParams.get('part'), 'snippet,status,contentDetails');
    assert.equal(insert.body.snippet.title, 'NCR Open 2026 · DLF Golf');
    assert.ok(Date.parse(insert.body.snippet.scheduledStartTime) > Date.now(), 'scheduled start must be in the future');
    assert.equal(insert.body.status.privacyStatus, 'unlisted');
    assert.equal(insert.body.contentDetails.enableAutoStart, true);
    assert.equal(insert.body.contentDetails.enableAutoStop, true);
    const stream = google.calls.find((c) => c.url.pathname === '/yt/liveStreams' && c.method === 'POST')!;
    assert.deepEqual(stream.body.cdn, { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' });
    const bind = google.calls.find((c) => c.url.pathname === '/yt/liveBroadcasts/bind')!;
    assert.equal(bind.url.searchParams.get('id'), 'bcast-1');
    assert.equal(bind.url.searchParams.get('streamId'), 'stream-1');
    assert.ok(google.calls.some((c) => c.body?.grant_type === 'refresh_token') || google.calls.some((c) => c.auth === 'Bearer at-1'));
    const t = await h.app.repo.tournamentById(tournamentId);
    assert.ok(t!.yt_stream_key_enc && !t!.yt_stream_key_enc.includes('abcd-efgh'), 'stream key encrypted at rest');
  });

  it('with a broadcast, OBS streams once to the server (which restreams); directors see broadcast health', async () => {
    const engine = await TestSocket.open(h.wsUrl, await engineToken(h, tournamentId));
    engine.send({ type: 'engine.hello' });
    const cfg = await engine.type('engine.config');
    assert.equal(cfg.youtube, undefined, 'the YouTube key never goes to OBS any more');
    assert.match(cfg.output.server, new RegExp(`^srt://[^?]+\\?streamid=publish:prog-${tournamentId.replace(/-/g, '')}:engine:[0-9a-f]{32}&latency=\\d+&pkt_size=1316$`));
    assert.equal(cfg.output.key, '');

    const director = await TestSocket.open(h.wsUrl, directorToken);
    director.send({ type: 'subscribe', tournamentId });
    const snap = await director.type('snapshot');
    assert.equal(snap.youtube.connected, true);
    assert.equal(snap.youtube.watchUrl, 'https://www.youtube.com/watch?v=bcast-1');
    await h.app.hub.pollYoutubeNow();
    const yt = await director.type('youtube');
    assert.deepEqual(
      { life: yt.youtube.lifeCycleStatus, stream: yt.youtube.streamStatus, health: yt.youtube.health, issues: yt.youtube.issues },
      { life: 'live', stream: 'active', health: 'ok', issues: ['Bitrate lower than recommended'] },
    );
    engine.close();
    director.close();
  });

  it('server without Google credentials says so clearly', async () => {
    const plain = await startHarness();
    try {
      const o = await signup(plain, 'x@club.test');
      const r = await api(plain, 'POST', `/api/orgs/${o.orgId}/youtube/connect`, undefined, o.token);
      assert.equal(r.status, 501);
      assert.equal(r.body.error.code, 'youtube_not_configured');
    } finally {
      await plain.close();
    }
  });
});
