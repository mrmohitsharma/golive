import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, createTournament, engineToken, expectOk, signup, startHarness, testConfig, TestSocket, type Harness } from './helpers.js';
import { RelayManager } from '../src/relay.js';
import { finalize, HlsService } from '../src/hls.js';

/** Stands in for FFmpeg. For an HLS run it writes what FFmpeg would: master, playlists, segments. */
class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed: string | null = null;
  constructor(public args: string[]) {
    super();
    if (args.includes('hls')) {
      const out = path.dirname(path.dirname(args.at(-1)!));
      fs.writeFileSync(path.join(out, 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH=2890800,RESOLUTION=1280x720\nv720p/live.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1205600,RESOLUTION=854x480\nv480p/live.m3u8\n');
      for (const v of ['v720p', 'v480p']) {
        const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0'];
        for (let i = 0; i < 5; i++) {
          const f = `s0000${i}.ts`;
          fs.writeFileSync(path.join(out, v, f), Buffer.alloc(1000, i));
          lines.push(`#EXTINF:${i === 4 ? '1.500000' : '2.000000'},`, f);
        }
        fs.writeFileSync(path.join(out, v, 'live.m3u8'), lines.join('\n') + '\n');
      }
    }
  }
  kill(sig: string) {
    this.killed = sig;
    this.exitCode = 0;
    this.emit('exit', null);
    return true;
  }
}

describe('V7 watch player: our own HLS through a CDN (Bunny), replays, embed, admin setup', () => {
  let h: Harness;
  let admin: { token: string; userId: string; orgId: string };
  let owner: { token: string; orgId: string };
  let tid: string;
  let session = '';
  const procs: FakeProc[] = [];
  const hlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-hls-'));
  const cdnCalls: string[] = [];
  let pullZoneStatus = 200;
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  before(async () => {
    h = await startHarness({
      env: { HLS_ENABLED: 'true', HLS_DIR: hlsDir, RELAY_RETRY_MAX_SEC: '1' },
      relaySpawn: (_cmd, args) => {
        const p = new FakeProc(args);
        procs.push(p);
        return p as never;
      },
      // Fake Bunny: the API, and the CDN edge, which forwards to our origin with the edge-rule header.
      cdnFetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        cdnCalls.push(url.pathname);
        if (url.hostname === 'api.bunny.net') {
          if ((init?.headers as Record<string, string>).AccessKey !== 'bunny-key-1234') return json(401, { Message: 'Unauthorized' });
          if (url.pathname === '/pullzone/4242') return pullZoneStatus === 200 ? json(200, { Name: 'gogetslive', OriginUrl: 'https://live.example.com', Type: 1, Hostnames: [{ Value: 'gogetslive.b-cdn.net' }] }) : json(pullZoneStatus, {});
          if (url.pathname === '/statistics') return json(200, { TotalBandwidthUsed: 1.1e12, TotalRequestsServed: 500000, CacheHitRate: 98.66, BandwidthUsedChart: { '2026-10-30T00:00:00Z': 1.1e12 } });
          return json(404, {});
        }
        if (url.hostname === 'gogetslive.b-cdn.net') {
          const s = h.app.hls.settings;
          return fetch(`${h.baseUrl}${url.pathname}`, { headers: s.lockOrigin ? { 'x-origin-secret': s.originSecret } : {} });
        }
        throw new Error('fake cdn: unexpected ' + url);
      }) as typeof fetch,
    });
    admin = await signup(h, 'boss@golive.test', 'Go Live HQ');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [admin.userId]);
    owner = await signup(h, 'rahul@dlf.test', 'DLF Golf Club');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'Monsoon Open' });
  });
  after(async () => {
    await h.close();
    fs.rmSync(hlsDir, { recursive: true, force: true });
  });

  it('.env can give the starting CDN values; the panel wins once saved', async () => {
    let saved: any = null;
    const secrets = { get: async () => saved, set: async (_k: string, v: object) => { saved = v; } } as any;
    const cfg = testConfig({ HLS_ENABLED: 'true', CDN_HOST: 'https://GoGetsLive.b-cdn.net/', BUNNY_PULL_ZONE_ID: '6902506', BUNNY_API_KEY: 'env-key-9999' });
    const svc = new HlsService(cfg, {} as any, secrets, h.app.fastify.log);
    await svc.reload();
    assert.deepEqual([svc.settings.host, svc.settings.pullZoneId, svc.settings.apiKey], ['gogetslive.b-cdn.net', 6902506, 'env-key-9999']);
    await svc.save({ host: 'cdn.gogetslive.com' }, null);
    assert.deepEqual([svc.settings.host, svc.settings.apiKey], ['cdn.gogetslive.com', 'env-key-9999']);
    saved = { ...saved, apiKey: '' };
    await svc.reload();
    assert.equal(svc.settings.apiKey, 'env-key-9999', 'an empty saved key falls back to .env');
  });

  it('the admin sets up Bunny: hostname, pull zone, key (masked), test and bandwidth bill', async () => {
    assert.equal((await api(h, 'GET', '/api/admin/streaming', undefined, owner.token)).status, 403);
    const s0 = await expectOk(api(h, 'GET', '/api/admin/streaming', undefined, admin.token));
    assert.deepEqual([s0.settings.available, s0.settings.playerEnabled, s0.settings.host, s0.settings.costPerGbUsd], [true, true, null, 0.005]);
    assert.equal((await api(h, 'PUT', '/api/admin/streaming', { playerEnabled: true, host: 'not a host', costPerGbUsd: 0.005, lockOrigin: false }, admin.token)).status, 400);
    const s1 = await expectOk(api(h, 'PUT', '/api/admin/streaming', { playerEnabled: true, host: 'https://GoGetsLive.b-cdn.net/', pullZoneId: 4242, apiKey: 'wrong-key', costPerGbUsd: 0.005, lockOrigin: false }, admin.token));
    assert.deepEqual([s1.settings.host, s1.settings.hasApiKey, s1.settings.apiKeyHint, s1.settings.originUrl], ['gogetslive.b-cdn.net', true, '-key', 'https://live.example.com']);
    assert.ok(!JSON.stringify(s1).includes('wrong-key'), 'key never sent back');
    let t = await expectOk(api(h, 'POST', '/api/admin/streaming/test', {}, admin.token));
    assert.match(t.checks.find((c: any) => c.name === 'Pull zone').detail, /rejected the API key/);
    assert.equal((await api(h, 'GET', '/api/admin/streaming/stats', undefined, admin.token)).body.error.code, 'cdn_error');
    await expectOk(api(h, 'PUT', '/api/admin/streaming', { playerEnabled: true, host: 'gogetslive.b-cdn.net', pullZoneId: 4242, apiKey: 'bunny-key-1234', costPerGbUsd: 0.005, lockOrigin: false }, admin.token));
    t = await expectOk(api(h, 'POST', '/api/admin/streaming/test', {}, admin.token));
    assert.deepEqual(t.checks.map((c: any) => [c.name, c.ok]), [['Player', true], ['Pull zone', true], ['Origin', true], ['Through the CDN', true]]);
    assert.match(t.checks[1].detail, /Volume network/);
    const st = await expectOk(api(h, 'GET', '/api/admin/streaming/stats?days=30', undefined, admin.token));
    assert.deepEqual([st.stats.bandwidthGb, st.stats.costUsd, st.stats.costInr, st.stats.cacheHitRate], [1100, 5.5, 484, 98.7], '1,100 GB at $0.005 = $5.50 = ₹484 at ₹88');
    // A pull zone pointing elsewhere is caught.
    pullZoneStatus = 404;
    t = await expectOk(api(h, 'POST', '/api/admin/streaming/test', {}, admin.token));
    assert.match(t.checks.find((c: any) => c.name === 'Pull zone').detail, /no pull zone/);
    pullZoneStatus = 200;
  });

  it('going live sends the programme to the server even with no other destination, and encodes HLS', async () => {
    const engine = await TestSocket.open(h.wsUrl, await engineToken(h, tid));
    engine.send({ type: 'engine.hello' });
    const cfg = await engine.type('engine.config');
    assert.match(cfg.output.server, /streamid=publish:prog-/, 'OBS streams to the server for the watch player');
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, streaming: { active: true, reconnecting: false } } });
    for (let i = 0; i < 100 && !procs.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(procs.length, 1);
    const a = procs[0].args;
    assert.equal(a[a.indexOf('-var_stream_map') + 1], 'v:0,a:0,name:720p v:1,a:1,name:480p');
    assert.ok(a.includes('2500k') && a.includes('1000k') && a.includes('expr:gte(t,n_forced*2)'));
    session = path.basename(path.dirname(path.dirname(a.at(-1)!)));
    assert.match(session, /^s[0-9a-z]+$/);
    for (let i = 0; i < 50 && !(await h.db.query('SELECT 1 FROM watch_sessions WHERE name = $1', [session])).rowCount; i++) await new Promise((r) => setTimeout(r, 20));

    // Not playable until FFmpeg reports progress.
    const w0 = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/watch`, undefined, owner.token));
    assert.deepEqual([w0.available, w0.enabled, w0.watch.live], [true, true, null]);
    procs[0].stdout.write('frame=60\nout_time_us=2000000\nprogress=continue\n');
    await new Promise((r) => setTimeout(r, 50));
    const pub = await expectOk(api(h, 'GET', `/api/public/tournaments/${tid}`));
    assert.equal(pub.watch.live, `https://gogetslive.b-cdn.net/hls/${tid}/${session}/master.m3u8`);
    assert.equal(pub.watch.embedUrl, `https://live.example.com/embed/${tid}`);
    const d = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/destinations`, undefined, owner.token));
    assert.deepEqual([d.outputs.watch.enabled, d.outputs.watch.state], [true, 'live']);
    engine.close();
  });

  it('the origin serves playlists and segments with CDN-friendly caching, and nothing else', async () => {
    const base = `${h.baseUrl}/hls/${tid}/${session}`;
    let r = await fetch(`${base}/master.m3u8`);
    assert.deepEqual([r.status, r.headers.get('content-type'), r.headers.get('cache-control'), r.headers.get('access-control-allow-origin')], [200, 'application/vnd.apple.mpegurl', 'public, max-age=10', '*']);
    r = await fetch(`${base}/v720p/live.m3u8`);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=1');
    r = await fetch(`${base}/v480p/s00003.ts`);
    assert.deepEqual([r.status, r.headers.get('content-type'), r.headers.get('cache-control'), (await r.arrayBuffer()).byteLength], [200, 'video/mp2t', 'public, max-age=31536000, immutable', 1000]);
    for (const bad of [`${base}/v720p/s00099.ts`, `${base}/secret.txt`, `${base}/..%2f..%2fpasswd`, `${h.baseUrl}/hls/${tid}/notasession/master.m3u8`, `${base}/x/live.m3u8`]) {
      assert.equal((await fetch(bad)).status, 404, bad);
    }
    const e = await fetch(`${h.baseUrl}/embed/${tid}`);
    assert.equal(e.status, 200);
    assert.equal(e.headers.get('content-security-policy'), null, 'the embed page can go on any website');
    assert.match(await e.text(), /GoLivePlayer\.mount/);
    assert.equal((await fetch(`${h.baseUrl}/site/hls-1.5.20.light.min.js`)).status, 200);
    assert.match(await fetch(`${h.baseUrl}/watch/${tid}`).then((x) => x.text()), /\/site\/player\.js/);
  });

  it('locking the origin: only requests carrying the edge-rule secret get the stream', async () => {
    const s = await expectOk(api(h, 'PUT', '/api/admin/streaming', { playerEnabled: true, host: 'gogetslive.b-cdn.net', pullZoneId: 4242, costPerGbUsd: 0.005, lockOrigin: true }, admin.token));
    assert.ok(s.settings.originSecret.length >= 20);
    const url = `${h.baseUrl}/hls/${tid}/${session}/master.m3u8`;
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await fetch(url, { headers: { 'x-origin-secret': s.settings.originSecret } })).status, 200);
    const t = await expectOk(api(h, 'POST', '/api/admin/streaming/test', {}, admin.token));
    assert.ok(t.checks.find((c: any) => c.name === 'Through the CDN').ok, 'the CDN (with the edge rule) still gets through');
    await expectOk(api(h, 'PUT', '/api/admin/streaming', { playerEnabled: true, host: 'gogetslive.b-cdn.net', pullZoneId: 4242, costPerGbUsd: 0.005, lockOrigin: false }, admin.token));
  });

  it('ending the show turns the recording into a replay; switching it off per event; old ones deleted', async () => {
    const engine = await TestSocket.open(h.wsUrl, await engineToken(h, tid));
    engine.send({ type: 'engine.hello' });
    await engine.type('engine.config');
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, streaming: { active: false, reconnecting: false } } });
    for (let i = 0; i < 100 && !procs[0].killed; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(procs[0].killed, 'FFmpeg stopped');
    let row: any;
    for (let i = 0; i < 100; i++) {
      row = (await h.db.query('SELECT * FROM watch_sessions WHERE name = $1', [session])).rows[0];
      if (row.ended_at) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual([row.duration_sec, Number(row.bytes)], [10, 10000], '4 × 2 s + 1.5 s, 10 segments of 1 kB');
    const vod = fs.readFileSync(path.join(hlsDir, tid, session, 'v720p', 'vod.m3u8'), 'utf8');
    assert.match(vod, /#EXT-X-PLAYLIST-TYPE:VOD[\s\S]*#EXTINF:1\.500000,\ns00004\.ts\n#EXT-X-ENDLIST/);
    assert.match(fs.readFileSync(path.join(hlsDir, tid, session, 'replay.m3u8'), 'utf8'), /v720p\/vod\.m3u8[\s\S]*v480p\/vod\.m3u8/);
    const w = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/watch`, undefined, owner.token));
    assert.equal(w.watch.live, null);
    assert.deepEqual(w.watch.replays.map((r: any) => [r.url, r.durationSec]), [[`https://gogetslive.b-cdn.net/hls/${tid}/${session}/replay.m3u8`, 10]]);
    const list = await expectOk(api(h, 'GET', '/api/admin/streaming', undefined, admin.token));
    assert.deepEqual([list.sessions[0].event, list.sessions[0].club, list.sessions[0].durationSec], ['Monsoon Open', 'DLF Golf Club', 10]);

    // A club can keep an event off our player (and with no destination, OBS then streams nowhere).
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/outputs`, { watch: { enabled: false } }, owner.token));
    const t = (await h.app.repo.tournamentById(tid))!;
    assert.equal(await h.app.outputs.engineOutput(t), null);
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/outputs`, { watch: { enabled: true } }, owner.token));

    // Retention: after HLS_RETENTION_DAYS the files and the replay go.
    assert.equal(await h.app.hls.cleanup(Date.now() + 15 * 86_400_000), 1);
    assert.ok(!fs.existsSync(path.join(hlsDir, tid)));
    assert.equal((await expectOk(api(h, 'GET', `/api/tournaments/${tid}/watch`, undefined, owner.token))).watch.replays.length, 0);
    engine.close();
  });

  it('after a server restart, sessions left open are closed into replays', async () => {
    const dir = path.join(hlsDir, tid, 'sabc1234');
    fs.mkdirSync(path.join(dir, 'v720p'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'master.m3u8'), '#EXTM3U\nv720p/live.m3u8\n');
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(dir, 'v720p', `s${String(i).padStart(5, '0')}.ts`), 'x');
    await h.db.query("INSERT INTO watch_sessions (tournament_id, name) VALUES ($1, 'sabc1234')", [tid]);
    await h.app.hls.recover(() => false);
    const r = (await h.db.query("SELECT duration_sec FROM watch_sessions WHERE name = 'sabc1234'")).rows[0];
    assert.equal(r.duration_sec, 60, 'segments without a playlist entry count as 2 s');
  });

  it('real FFmpeg: two qualities with aligned 2 s segments, then a playable replay', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-ff-'));
    const src = path.join(dir, 'src.mp4');
    spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', src]);
    const out = path.join(dir, 's0real01');
    for (const v of ['v720p', 'v480p']) fs.mkdirSync(path.join(out, v), { recursive: true });
    const args = RelayManager.hlsArgs(src, { dir, renditions: [{ height: 720, kbps: 2500 }, { height: 480, kbps: 1000 }], preset: 'ultrafast', segmentSec: 2 }, out).filter(
      (a, i, all) => a !== '-rtsp_transport' && all[i - 1] !== '-rtsp_transport',
    );
    const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const master = fs.readFileSync(path.join(out, 'master.m3u8'), 'utf8');
    assert.match(master, /RESOLUTION=1280x720[\s\S]*v720p\/live\.m3u8[\s\S]*RESOLUTION=854x480[\s\S]*v480p\/live\.m3u8/);
    assert.deepEqual(fs.readdirSync(path.join(out, 'v720p')).filter((f) => f.endsWith('.ts')), fs.readdirSync(path.join(out, 'v480p')).filter((f) => f.endsWith('.ts')));
    const fin = finalize(out, 2);
    assert.ok(Math.abs(fin.durationSec - 5) < 0.2, String(fin.durationSec));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(out, 'replay.m3u8')], { encoding: 'utf8' });
    assert.ok(Math.abs(Number(probe.stdout.trim()) - 5) < 0.3, probe.stdout + probe.stderr);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
