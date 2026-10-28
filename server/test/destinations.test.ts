import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { addStaff, api, createTournament, engineToken, expectOk, signup, startHarness, TestSocket, type Harness } from './helpers.js';

/** Fake Google: two Google accounts (main channel and a second channel), broadcasts numbered in order. */
function fakeGoogle() {
  const calls: { method: string; path: string; auth: string | null; body: any }[] = [];
  const lifecycle = new Map<string, string>();
  const revoked: string[] = [];
  let n = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization');
    const raw = init?.body ? String(init.body) : '';
    const body = raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ method, path: url.pathname, auth, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/revoke') {
      revoked.push(body.token);
      return json(200, {});
    }
    if (url.pathname === '/token') {
      if (body.code === 'code-main') return json(200, { access_token: 'at-main', expires_in: 3600, refresh_token: 'rt-main' });
      if (body.code === 'code-second') return json(200, { access_token: 'at-second', expires_in: 3600, refresh_token: 'rt-second' });
      if (body.refresh_token === 'rt-main') return json(200, { access_token: 'at-main', expires_in: 3600 });
      if (body.refresh_token === 'rt-second') return json(200, { access_token: 'at-second', expires_in: 3600 });
      return json(400, { error: 'invalid_grant' });
    }
    if (url.pathname === '/yt/channels') {
      return auth === 'Bearer at-second'
        ? json(200, { items: [{ id: 'UC-SECOND', snippet: { title: 'Sponsor TV' } }] })
        : json(200, { items: [{ id: 'UC-MAIN', snippet: { title: 'Club TV' } }] });
    }
    if (url.pathname === '/yt/liveBroadcasts' && method === 'POST') {
      n++;
      lifecycle.set(`bc-${n}`, 'ready');
      return json(200, { id: `bc-${n}` });
    }
    if (url.pathname === '/yt/liveStreams' && method === 'POST') {
      return json(200, { id: `st-${n}`, cdn: { ingestionInfo: { streamName: `key-${n}`, rtmpsIngestionAddress: 'rtmps://a.rtmps.youtube.com/live2' } } });
    }
    if (url.pathname === '/yt/liveBroadcasts/bind') return json(200, {});
    if (url.pathname === '/yt/liveBroadcasts' && method === 'GET') {
      const id = url.searchParams.get('id')!;
      return json(200, { items: lifecycle.has(id) ? [{ id, status: { lifeCycleStatus: lifecycle.get(id) } }] : [] });
    }
    return json(404, { error: { message: `fake google: no route ${method} ${url.pathname}` } });
  }) as typeof fetch;
  return { fetchImpl, calls, lifecycle, revoked };
}

class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  constructor(public args: string[]) {
    super();
  }
  kill() {
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', null);
    return true;
  }
}

describe('one show to several YouTube channels and stream keys; 1 destination free, extras paid', () => {
  let h: Harness;
  let owner: { token: string; orgId: string; userId: string };
  let director: string;
  let tid: string;
  let channelDest: string;
  let igDest: string;
  const google = fakeGoogle();
  const procs: FakeProc[] = [];
  const balance = async () => (await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/billing`, undefined, owner.token))).balance as number;

  before(async () => {
    h = await startHarness({
      googleFetch: google.fetchImpl,
      env: {
        BILLING_ENABLED: 'true',
        GOOGLE_CLIENT_ID: 'g-client',
        GOOGLE_CLIENT_SECRET: 'g-secret',
        GOOGLE_AUTH_URL: 'https://google.fake/auth',
        GOOGLE_TOKEN_URL: 'https://google.fake/token',
        GOOGLE_REVOKE_URL: 'https://google.fake/revoke',
        YOUTUBE_API_BASE: 'https://google.fake/yt',
      },
      relaySpawn: ((_cmd: string, args: string[]) => {
        const p = new FakeProc(args);
        procs.push(p);
        return p as unknown as ChildProcess;
      }) as never,
    });
    owner = await signup(h, 'owner@club.test', 'Club');
    director = await addStaff(h, owner.token, owner.orgId, 'dir@club.test', 'director');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'Final', venue: 'Main Ground' });
    await h.app.billing.adminAdjust(owner.orgId, 1000, 'test credits', 'test');
  });
  after(() => h.close());

  const connect = async (path: string, code: string) => {
    const { url } = await expectOk(api(h, 'POST', path, undefined, owner.token));
    const state = new URL(url).searchParams.get('state')!;
    const res = await fetch(`${h.baseUrl}/api/youtube/callback?code=${code}&state=${encodeURIComponent(state)}`);
    return { status: res.status, text: await res.text() };
  };

  it('an organisation connects a main channel and then more channels', async () => {
    assert.equal((await api(h, 'POST', `/api/orgs/${owner.orgId}/youtube/channels/connect`, undefined, director)).status, 403, 'only owners and admins');
    assert.equal((await connect(`/api/orgs/${owner.orgId}/youtube/connect`, 'code-main')).status, 200);
    const second = await connect(`/api/orgs/${owner.orgId}/youtube/channels/connect`, 'code-second');
    assert.equal(second.status, 200);
    assert.match(second.text, /Sponsor TV.*extra channel/);
    const r = await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/youtube/channels`, undefined, director));
    assert.deepEqual(r.channels.map((c: any) => [c.title, c.main]), [['Club TV', true], ['Sponsor TV', false]]);
    const stored = (await h.db.query('SELECT refresh_token_enc FROM youtube_channels')).rows[0].refresh_token_enc as string;
    assert.ok(!stored.includes('rt-second'), 'refresh token encrypted at rest');
    // Connecting the main channel again through "another channel" renews it instead of duplicating it.
    await connect(`/api/orgs/${owner.orgId}/youtube/channels/connect`, 'code-main');
    assert.equal((await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/youtube/channels`, undefined, director))).channels.length, 2);
  });

  it('the first destination is free; adding another asks for an extra destination', async () => {
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/youtube/broadcast`, { privacy: 'public' }, director));
    const s = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/destinations`, undefined, director));
    assert.deepEqual(s.billing.destinations, { free: 1, extra: 0, limit: 1, used: 1, price: 50 });
    const channels = (await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/youtube/channels`, undefined, director))).channels;
    const second = channels.find((c: any) => !c.main).id;
    const refused = await api(h, 'POST', `/api/tournaments/${tid}/destinations`, { kind: 'channel', channelId: second }, director);
    assert.equal(refused.status, 402);
    assert.equal(refused.body.error.code, 'destination_limit');
    assert.match(refused.body.error.message, /includes 1 destination\. Add another for 50 credits/);

    const before = await balance();
    const bought = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/billing/destinations`, { count: 1 }, owner.token));
    assert.equal(bought.billing.destinations.limit, 2);
    assert.equal(await balance(), before - 50);

    const calls = google.calls.length;
    const added = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/destinations`, { kind: 'channel', channelId: second, privacy: 'unlisted' }, director));
    channelDest = added.destinationId;
    const made = google.calls.slice(calls).filter((c) => c.path === '/yt/liveBroadcasts' && c.method === 'POST');
    assert.equal(made.length, 1, 'broadcast made on the second channel straight away');
    assert.equal(made[0].auth, 'Bearer at-second', 'with the second channel’s own sign-in');
    assert.equal(made[0].body.status.privacyStatus, 'unlisted');
    const d = added.outputs.destinations[0];
    assert.deepEqual([d.kind, d.platform, d.label, d.enabled, d.ready], ['channel', 'youtube', 'Sponsor TV', true, true]);
    assert.equal(d.link, 'https://www.youtube.com/watch?v=bc-2');
    const again = await api(h, 'POST', `/api/tournaments/${tid}/destinations`, { kind: 'channel', channelId: second }, owner.token);
    assert.equal(again.body.error.code, 'channel_already_added', 'a channel is added once per event');
  });

  it('stream keys for Instagram, Facebook or any service; keys stored sealed; limits on enable', async () => {
    const ig = { kind: 'key', platform: 'instagram', streamUrl: 'rtmps://edgetee-upload.fbcdn.net:443/rtmp/', streamKey: 'IG-SECRET-1234', label: 'Sponsor Instagram' };
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/destinations`, ig, director)).status, 402);
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/billing/destinations`, { count: 1 }, owner.token));
    const r = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/destinations`, ig, director));
    igDest = r.destinationId;
    const d = r.outputs.destinations.find((x: any) => x.id === igDest);
    assert.deepEqual([d.platform, d.vertical, d.hint, d.label], ['instagram', true, '1234', 'Sponsor Instagram']);
    const raw = (await h.db.query('SELECT url_enc FROM event_destinations WHERE id = $1', [igDest])).rows[0].url_enc as string;
    assert.ok(!raw.includes('IG-SECRET'), 'stream key encrypted at rest');
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/destinations`, { kind: 'key', platform: 'other', streamKey: 'x' }, director)).body.error.code, 'stream_url_required');
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/destinations`, { kind: 'key', platform: 'other', streamUrl: 'https://x', streamKey: 'x' }, director)).body.error.code, 'bad_stream_url');

    // Switching off is always allowed; switching back on needs room.
    const off = await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/destinations/${igDest}`, { enabled: false }, director));
    assert.equal(off.billing.destinations.used, 2);
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/destinations/${igDest}`, { enabled: true }, director));
    // A pasted key alone works for YouTube (the usual ingest address is filled in) but no room is left.
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/destinations`, { kind: 'key', platform: 'youtube', streamKey: 'yt-other' }, director)).status, 402);
  });

  it('Go live sends one copy of the show to every destination; a second show gets fresh broadcasts', async () => {
    const engine = await TestSocket.open(h.wsUrl, await engineToken(h, tid));
    engine.send({ type: 'engine.hello' });
    await engine.type('engine.config');
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true } });
    const ws = await TestSocket.open(h.wsUrl, director);
    ws.send({ type: 'subscribe', tournamentId: tid });
    await ws.type('snapshot');

    const goLive = async () => {
      ws.send({ type: 'command', action: 'stream.start', requestId: `go-${Date.now()}` });
      const cmd = await engine.next((m) => m.type === 'command' && m.action === 'stream.start');
      engine.send({ type: 'command.result', id: cmd.id, ok: true });
      engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, streaming: { active: true, reconnecting: false } } });
      return ws.next((m) => m.type === 'outputs' && m.outputs.destinations.length === 2 && m.outputs.destinations.every((d: any) => d.state === 'connecting'));
    };
    const stop = async () => {
      ws.drain();
      engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, streaming: { active: false, reconnecting: false } } });
      await ws.next((m) => m.type === 'outputs' && m.outputs.destinations.every((d: any) => d.state === 'off'));
    };

    await goLive();
    const urls = procs.map((p) => p.args.at(-1)).sort();
    assert.deepEqual(urls, [
      'rtmps://a.rtmps.youtube.com/live2/key-1', // main channel
      'rtmps://a.rtmps.youtube.com/live2/key-2', // second channel
      'rtmps://edgetee-upload.fbcdn.net:443/rtmp/IG-SECRET-1234', // Instagram key
    ]);
    const igProc = procs.find((p) => p.args.at(-1)!.includes('IG-SECRET'))!;
    assert.ok(igProc.args.join(' ').includes('scale=720:1280'), 'Instagram destination gets the 9:16 version');
    await stop();
    assert.ok(procs.every((p) => p.killed));

    // YouTube ended the second channel's broadcast with the stream; the next show needs a new one.
    google.lifecycle.set('bc-2', 'complete');
    ws.drain();
    const first = procs.length;
    await goLive();
    const next = procs.slice(first).map((p) => p.args.at(-1));
    assert.ok(next.includes('rtmps://a.rtmps.youtube.com/live2/key-3'), 'fresh broadcast on the second channel');
    assert.ok(!next.includes('rtmps://a.rtmps.youtube.com/live2/key-2'));
    await stop();
    engine.close();
    ws.close();
  });

  it('Go live is refused when more destinations are on than the event includes', async () => {
    await h.app.billing.updateOrgBilling(owner.orgId, { overrides: { freeDestinations: 0 } });
    const t = (await h.app.repo.tournamentById(tid))!;
    const r = await h.app.billing.checkGoLive(t);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /streams to 3 destinations and includes 2\. Add 1 more \(50 credits each\) or switch one off/);
    await h.app.billing.updateOrgBilling(owner.orgId, { overrides: { freeCameras: 5 } });
    assert.equal((await h.app.billing.pricingFor(owner.orgId)).freeDestinations, 1, 'a club override of other prices keeps the platform destination price');
    assert.equal((await h.app.billing.checkGoLive(t)).ok, true);
  });

  it('wallet shows extra destinations; removing a channel revokes it and its destinations go', async () => {
    const tx = (await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/billing`, undefined, owner.token))).transactions;
    assert.ok(tx.some((x: any) => x.kind === 'destinations' && x.credits === -50));
    const second = (await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/youtube/channels`, undefined, owner.token))).channels.find((c: any) => !c.main).id;
    assert.equal((await api(h, 'DELETE', `/api/orgs/${owner.orgId}/youtube/channels/${second}`, undefined, director)).status, 403);
    assert.equal((await api(h, 'DELETE', `/api/orgs/${owner.orgId}/youtube/channels/${second}`, undefined, owner.token)).status, 204);
    assert.deepEqual(google.revoked, ['rt-second']);
    const s = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/destinations`, undefined, director));
    assert.deepEqual(s.outputs.destinations.map((d: any) => d.id), [igDest], 'the channel destination went with the channel');
    assert.ok(channelDest);
    await expectOk(api(h, 'DELETE', `/api/tournaments/${tid}/destinations/${igDest}`, undefined, director));
    assert.equal((await expectOk(api(h, 'GET', `/api/tournaments/${tid}/destinations`, undefined, director))).outputs.destinations.length, 0);
  });
});
