import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { addStaff, api, createTournament, engineToken, expectOk, joinAsGuest, signup, startHarness, TestSocket, type Harness } from './helpers.js';
import { RelayManager } from '../src/relay.js';
import { joinStreamUrl } from '../src/outputs.js';
import { testConfig } from './helpers.js';

/** Fake Facebook Graph API with the endpoints the server uses; records every call. */
function fakeMeta() {
  const calls: { method: string; path: string; params: Record<string, string> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const params = method === 'GET' ? Object.fromEntries(url.searchParams) : Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    const p = url.pathname.replace(/^\/v26\.0\//, '');
    calls.push({ method, path: p, params });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (p === 'oauth/access_token') {
      if (params.code === 'fb-code' && params.client_secret === 'meta-secret') return json(200, { access_token: 'short' });
      if (params.grant_type === 'fb_exchange_token' && params.fb_exchange_token === 'short') return json(200, { access_token: 'long' });
      return json(400, { error: { message: 'Invalid verification code format.', code: 100 } });
    }
    if (p === 'me' && params.access_token === 'long') return json(200, { name: 'Club Admin' });
    if (p === 'me/accounts' && params.access_token === 'long') {
      return json(200, { data: [{ id: 'p1', name: 'DLF Golf', access_token: 'pt1' }, { id: 'p2', name: 'Other Page', access_token: 'pt2' }] });
    }
    if (p === 'p1/live_videos' && method === 'POST' && params.access_token === 'pt1' && params.status === 'LIVE_NOW') {
      return json(200, { id: 'lv1', secure_stream_url: 'rtmps://live-api-s.facebook.com:443/rtmp/FB-STREAM-KEY' });
    }
    if (p === 'lv1' && method === 'GET') return json(200, { permalink_url: '/DLFGolf/videos/lv1/' });
    if (p === 'lv1' && method === 'POST' && params.end_live_video === 'true') return json(200, { id: 'lv1' });
    return json(400, { error: { message: `fake: no route ${method} ${p}` } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Stands in for FFmpeg: records arguments, lets the test emit progress or make it exit. */
class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed: string | null = null;
  constructor(public args: string[]) {
    super();
  }
  kill(sig: string) {
    this.killed = sig;
    this.exitCode = 0;
    this.emit('exit', null);
    return true;
  }
  fail(message: string) {
    this.stderr.write(message + '\n');
    setTimeout(() => {
      this.exitCode = 1;
      this.emit('exit', 1);
    }, 10);
  }
}

describe('multistream: one OBS stream → YouTube + Facebook + Instagram; public watch page', () => {
  let h: Harness;
  let owner: { token: string; orgId: string };
  let directorToken: string;
  let tid: string;
  let hidden: string;
  const meta = fakeMeta();
  const procs: FakeProc[] = [];
  const hook = (body: object) => api(h, 'POST', '/internal/mediamtx/auth?secret=hook-secret-1234567890', body);

  before(async () => {
    h = await startHarness({
      env: {
        META_APP_ID: 'meta-app',
        META_APP_SECRET: 'meta-secret',
        META_AUTH_URL: 'https://fb.fake',
        META_GRAPH_BASE: 'https://graph.fake',
        PUBLIC_CORS_ORIGINS: 'https://cogolfers.com, https://www.cogolfers.com',
        WATCH_EMBED_ORIGINS: 'https://cogolfers.com',
        RELAY_RETRY_MAX_SEC: '1',
      },
      metaFetch: meta.fetchImpl,
      relaySpawn: ((_cmd: string, args: string[]) => {
        const p = new FakeProc(args);
        procs.push(p);
        return p as unknown as ChildProcess;
      }) as never,
    });
    owner = await signup(h, 'owner@club.test', 'DLF Golf Club');
    directorToken = await addStaff(h, owner.token, owner.orgId, 'dir@club.test', 'director');
    tid = await createTournament(h, directorToken, owner.orgId, { name: 'Monsoon Open', startsOn: '2026-10-24' });
    hidden = await createTournament(h, directorToken, owner.orgId, { name: 'Private Practice' });
    await expectOk(api(h, 'PATCH', `/api/tournaments/${hidden}`, { publicWatch: false }, directorToken));
  });
  after(() => h.close());

  it('OBS may publish the programme over SRT only, with the tournament output key', async () => {
    const t = (await h.app.repo.tournamentById(tid))!;
    const path = `prog-${tid.replace(/-/g, '')}`;
    assert.equal((await hook({ action: 'publish', path, protocol: 'srt', user: 'engine', password: t.output_key })).status, 200);
    assert.equal((await hook({ action: 'publish', path, protocol: 'srt', user: 'engine', password: 'wrong' })).status, 401);
    assert.equal((await hook({ action: 'publish', path, protocol: 'webrtc', user: 'engine', password: t.output_key })).status, 401);
    assert.equal((await hook({ action: 'publish', path: 'prog-00000000000000000000000000000000', protocol: 'srt', user: 'engine', password: t.output_key })).status, 401);
    assert.equal((await hook({ action: 'read', path, protocol: 'rtsp', user: 'cg-internal', password: 'internal-pass-1234567890' })).status, 200);
  });

  it('platform settings: Instagram key stored sealed; Facebook needs a connected Page; volunteers cannot change them', async () => {
    const r0 = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/outputs`, undefined, directorToken));
    assert.equal(r0.outputs.relay, false, 'nothing set up yet: OBS keeps its own settings');
    assert.deepEqual(
      r0.outputs.platforms.map((p: any) => [p.platform, p.configured, p.enabled]),
      [['youtube', false, true], ['facebook', false, false], ['instagram', false, false]],
    );
    const scorer = await joinAsGuest(h, directorToken, tid, 'scorer', 'scorer-device-1');
    assert.equal((await api(h, 'PATCH', `/api/tournaments/${tid}/outputs`, { facebook: { enabled: true } }, scorer)).status, 403);
    const bad = await api(h, 'PATCH', `/api/tournaments/${tid}/outputs`, { instagram: { streamUrl: 'https://instagram.com', streamKey: 'x' } }, directorToken);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'bad_stream_url');
    const fb = await api(h, 'PATCH', `/api/tournaments/${tid}/outputs`, { facebook: { enabled: true } }, directorToken);
    assert.equal(fb.body.error.code, 'facebook_not_ready');

    const r = await expectOk(
      api(h, 'PATCH', `/api/tournaments/${tid}/outputs`, { instagram: { streamUrl: 'rtmps://edgetee-upload-del1-1.xx.fbcdn.net:443/rtmp/', streamKey: 'IG-KEY-9876' } }, directorToken),
    );
    const ig = r.outputs.platforms.find((p: any) => p.platform === 'instagram');
    assert.deepEqual([ig.configured, ig.enabled, ig.hint], [true, true, '9876']);
    assert.equal(r.outputs.relay, true);
    const raw = (await h.db.query('SELECT outputs::text AS o FROM tournaments WHERE id = $1', [tid])).rows[0].o as string;
    assert.ok(!raw.includes('IG-KEY'), 'Instagram key encrypted at rest');
  });

  it('owner connects Facebook once and picks the Page; tokens are sealed', async () => {
    assert.equal((await api(h, 'POST', `/api/orgs/${owner.orgId}/facebook/connect`, undefined, directorToken)).status, 403);
    const { url } = await expectOk(api(h, 'POST', `/api/orgs/${owner.orgId}/facebook/connect`, undefined, owner.token));
    const u = new URL(url);
    assert.equal(`${u.origin}${u.pathname}`, 'https://fb.fake/v26.0/dialog/oauth');
    assert.equal(u.searchParams.get('redirect_uri'), 'https://live.example.com/api/facebook/callback');
    assert.deepEqual(u.searchParams.get('scope')!.split(','), ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_read_user_content']);
    const bad = await fetch(`${h.baseUrl}/api/facebook/callback?code=nope&state=${u.searchParams.get('state')}`);
    assert.equal(bad.status, 502);
    const ok = await fetch(`${h.baseUrl}/api/facebook/callback?code=fb-code&state=${u.searchParams.get('state')}`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /Club Admin with 2 Pages/);

    const s1 = await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/facebook`, undefined, directorToken));
    assert.deepEqual([s1.connected, s1.pages.length, s1.pageId], [true, 2, null]);
    assert.equal((await api(h, 'PUT', `/api/orgs/${owner.orgId}/facebook/page`, { pageId: 'nope' }, owner.token)).status, 404);
    const s2 = await expectOk(api(h, 'PUT', `/api/orgs/${owner.orgId}/facebook/page`, { pageId: 'p1' }, owner.token));
    assert.equal(s2.pageName, 'DLF Golf');
    const stored = (await h.db.query('SELECT pages::text AS p FROM org_facebook WHERE org_id = $1', [owner.orgId])).rows[0].p as string;
    assert.ok(!stored.includes('pt1'), 'Page tokens encrypted at rest');
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/outputs`, { facebook: { enabled: true } }, directorToken));
  });

  it('Go live: OBS streams once to the server; three relays start, report live, retry alone, stop on End', async () => {
    const t = (await h.app.repo.tournamentById(tid))!;
    await h.app.repo.setYoutubeBroadcast(tid, {
      broadcastId: 'bcast-77',
      streamId: 'st-77',
      streamKeyEnc: h.app.sealer.seal('yt-key-77'),
      ingestUrl: 'rtmps://a.rtmps.youtube.com/live2',
      privacy: 'public',
    });
    const engine = await TestSocket.open(h.wsUrl, await engineToken(h, tid));
    engine.send({ type: 'engine.hello' });
    const cfg = await engine.type('engine.config');
    assert.equal(cfg.output.server, `srt://live.example.com:8890?streamid=publish:prog-${tid.replace(/-/g, '')}:engine:${t.output_key}&latency=600000&pkt_size=1316`);
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true } });

    const director = await TestSocket.open(h.wsUrl, directorToken);
    director.send({ type: 'subscribe', tournamentId: tid });
    const snap = await director.type('snapshot');
    assert.deepEqual(snap.outputs.platforms.map((p: any) => [p.platform, p.configured && p.enabled, p.state]), [
      ['youtube', true, 'off'],
      ['facebook', true, 'off'],
      ['instagram', true, 'off'],
    ]);

    director.send({ type: 'command', action: 'stream.start', requestId: 'go' });
    const cmd = await engine.next((m) => m.type === 'command' && m.action === 'stream.start');
    assert.ok(meta.calls.some((c) => c.method === 'POST' && c.path === 'p1/live_videos'), 'Facebook live video created before OBS starts');
    engine.send({ type: 'command.result', id: cmd.id, ok: true });
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, streaming: { active: true, reconnecting: false } } });

    const live = await director.next((m) => m.type === 'outputs' && m.outputs.platforms.every((p: any) => p.state === 'connecting'));
    assert.equal(live.outputs.platforms.find((p: any) => p.platform === 'facebook').link, 'https://www.facebook.com/DLFGolf/videos/lv1/');
    assert.equal(procs.length, 3);
    const byUrl = (s: string) => procs.find((p) => p.args.at(-1)!.startsWith(s))!;
    const yt = byUrl('rtmps://a.rtmps.youtube.com');
    const fb = byUrl('rtmps://live-api-s.facebook.com');
    const ig = byUrl('rtmps://edgetee-upload');
    assert.equal(yt.args.at(-1), 'rtmps://a.rtmps.youtube.com/live2/yt-key-77');
    assert.equal(fb.args.at(-1), 'rtmps://live-api-s.facebook.com:443/rtmp/FB-STREAM-KEY');
    assert.equal(ig.args.at(-1), 'rtmps://edgetee-upload-del1-1.xx.fbcdn.net:443/rtmp/IG-KEY-9876');
    for (const p of procs) assert.ok(p.args.includes(`rtsp://cg-internal:internal-pass-1234567890@mediamtx:8554/prog-${tid.replace(/-/g, '')}`));
    assert.ok(yt.args.includes('copy') && fb.args.includes('copy'), 'YouTube and Facebook get the programme untouched');
    assert.ok(ig.args.join(' ').includes('scale=720:1280') && ig.args.includes('3500k'), 'Instagram gets a 720x1280 re-encode');

    yt.stdout.write('frame=60\nout_time_us=2000000\nprogress=continue\n');
    await director.next((m) => m.type === 'outputs' && m.outputs.platforms.find((p: any) => p.platform === 'youtube').state === 'live');

    fb.fail('rtmps://live-api-s.facebook.com:443/rtmp/FB-STREAM-KEY: Connection reset by peer');
    const retry = await director.next((m) => m.type === 'outputs' && m.outputs.platforms.find((p: any) => p.platform === 'facebook').state === 'retrying');
    const fbState = retry.outputs.platforms.find((p: any) => p.platform === 'facebook');
    assert.match(fbState.error, /closed the connection/);
    assert.ok(!fbState.error.includes('FB-STREAM-KEY'), 'stream keys never shown');
    assert.equal(retry.outputs.platforms.find((p: any) => p.platform === 'youtube').state, 'live', 'other platforms unaffected');
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(procs.length, 4, 'Facebook relay restarted on its own');

    director.drain();
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, streaming: { active: false, reconnecting: false } } });
    await director.next((m) => m.type === 'outputs' && m.outputs.platforms.every((p: any) => p.state === 'off'));
    assert.ok([yt, ig, procs[3]].every((p) => p.killed), 'all relays stopped');
    for (let i = 0; i < 50 && (await h.app.repo.tournamentById(tid))!.fb_live_video_id; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(meta.calls.some((c) => c.method === 'POST' && c.path === 'lv1' && c.params.end_live_video === 'true'), 'Facebook live video ended');
    assert.equal((await h.app.repo.tournamentById(tid))!.fb_live_video_id, null);
    engine.close();
    director.close();
  });

  it('public API for the CoGolfers website: CORS, live list, leaderboard, public clips only', async () => {
    await expectOk(api(h, 'PUT', `/api/tournaments/${tid}/holes`, { preset: 'par72' }, directorToken));
    const pl = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/players`, { csv: 'Aman Sharma, DLF, Open\nBina Rao, KGA, Ladies' }, directorToken));
    await expectOk(api(h, 'PUT', `/api/tournaments/${tid}/scores`, { playerId: pl.players[0].id, hole: 1, strokes: 3 }, directorToken));
    await h.db.query(
      `INSERT INTO clips (tournament_id, camera_name, hole, title, start_at, duration_sec, status, public)
       VALUES ($1, 'Hole 7 Green', 7, 'Birdie on 7!', now(), 30, 'ready', true), ($1, 'Hole 2 Tee', 2, 'Hidden one', now(), 30, 'ready', false)`,
      [tid],
    );

    const okOrigin = await fetch(`${h.baseUrl}/api/public/live`, { headers: { origin: 'https://cogolfers.com' } });
    assert.equal(okOrigin.headers.get('access-control-allow-origin'), 'https://cogolfers.com');
    const list = await okOrigin.json();
    assert.deepEqual(list.tournaments.map((t: any) => t.name), ['Monsoon Open'], 'hidden tournaments are not listed');
    const t = list.tournaments[0];
    assert.equal(t.youtube.videoId, 'bcast-77');
    assert.equal(t.youtube.embedUrl, 'https://www.youtube.com/embed/bcast-77?autoplay=1&mute=1&playsinline=1');
    assert.equal(t.watchPage, `https://live.example.com/watch/${tid}`);
    assert.equal(t.startsOn, '2026-10-24', 'dates stay plain YYYY-MM-DD');
    const evil = await fetch(`${h.baseUrl}/api/public/live`, { headers: { origin: 'https://evil.example' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);

    const d = await expectOk(api(h, 'GET', `/api/public/tournaments/${tid}`));
    assert.deepEqual(d.leaderboard, [{ position: '1', name: 'Aman Sharma', club: 'DLF', category: 'Open', toPar: '-1', thru: '1' }]);
    assert.deepEqual(d.clips.map((c: any) => c.title), ['Birdie on 7!']);
    assert.match(d.clips[0].thumbUrl, /^https:\/\/live\.example\.com\/api\/clips\/[0-9a-f-]{36}\/thumb\.jpg\?sig=/);
    assert.equal((await api(h, 'GET', `/api/public/tournaments/${hidden}`)).status, 404);
    assert.equal((await api(h, 'GET', '/api/public/tournaments/not-a-uuid')).status, 404);

    const page = await fetch(`${h.baseUrl}/watch/${tid}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'self' https:\/\/cogolfers\.com/);
    assert.match(await page.text(), /api\/public\/tournaments/);
  });

  it('YouTube broadcasts are created embeddable', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../src/youtube.ts', import.meta.url), 'utf8');
    assert.match(src, /enableEmbed: true/);
  });
});

describe('relay helpers', () => {
  const config = testConfig();
  it('copy for 16:9 platforms, 9:16 re-encode for Instagram', () => {
    const copy = RelayManager.args(config, 'rtsp://in', { id: 'youtube', platform: 'youtube', url: 'rtmps://yt/live2/k', vertical: false });
    assert.deepEqual(copy.slice(copy.indexOf('-map')), ['-map', '0:v', '-map', '0:a?', '-c', 'copy', '-f', 'flv', '-flvflags', 'no_duration_filesize', 'rtmps://yt/live2/k']);
    const ig = RelayManager.args(config, 'rtsp://in', { id: 'instagram', platform: 'instagram', url: 'rtmps://ig/rtmp/k', vertical: true });
    assert.ok(ig.includes('libx264') && ig.join(' ').includes('720:1280') && ig.includes('-g'));
  });
  it('joins platform URL and key', () => {
    assert.equal(joinStreamUrl('rtmps://host:443/rtmp/', 'KEY'), 'rtmps://host:443/rtmp/KEY');
    assert.equal(joinStreamUrl('rtmps://host/live2', 'KEY'), 'rtmps://host/live2/KEY');
    assert.equal(joinStreamUrl('rtmps://host/rtmp/KEY', ''), 'rtmps://host/rtmp/KEY');
    assert.throws(() => joinStreamUrl('ftp://x', 'k'));
  });
});
