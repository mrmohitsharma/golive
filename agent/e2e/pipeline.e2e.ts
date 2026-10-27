/**
 * End-to-end test of the whole system on one machine, with REAL OBS Studio in cloud mode:
 *
 *   ffmpeg "phones" --SRT--> MediaMTX (real) <--auth/playback--> server (real)
 *   server --process driver--> cloud engine (real headless OBS + real agent)
 *   OBS --SRT--> MediaMTX programme path --server relays--> "fake YouTube / Facebook / Instagram"
 *     (a second MediaMTX receiving RTMP) <-- we pull frames/audio from each and check them
 *   fake Google OAuth/YouTube API, a real WebRTC client (WHIP commentary, WHEP preview)
 *
 * The camera feeds are solid colours, so the colour of OBS's actual output proves which
 * camera is on air: switching, replay and fallback are checked on real video.
 *
 * Run: MEDIAMTX_BIN=... DATABASE_URL=postgres://.../cg_live_e2e npm run e2e
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startFakeGoogle } from './fake-google.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const MEDIAMTX_BIN = process.env.MEDIAMTX_BIN ?? 'mediamtx';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://cg:cg@127.0.0.1:5432/cg_live_e2e';
const P = { http: 18080, srt: 18890, api: 19997, rtsp: 18554, webrtc: 18889, webrtcUdp: 18189, playback: 19996, ytRtmp: 19350, ytApi: 19998, google: 18099 };
const SERVER = `http://127.0.0.1:${P.http}`;
const procs: ChildProcess[] = [];
const results: { step: string; ok: boolean; detail?: string; ms: number }[] = [];
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-e2e2-'));
const shots = process.env.E2E_SHOTS_DIR ?? path.join(work, 'shots');
fs.mkdirSync(shots, { recursive: true });

const COLORS = { cam1: [200, 30, 30], cam2: [30, 190, 40], cam3: [40, 60, 210] } as const;

function start(name: string, cmd: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: name === 'server' });
  const log = fs.createWriteStream(path.join(work, `${name}.log`));
  p.stdout?.pipe(log);
  p.stderr?.pipe(log);
  procs.push(p);
  return p;
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await fn();
    results.push({ step: name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✔ ${name} (${Date.now() - t0} ms)`);
    return r;
  } catch (err) {
    results.push({ step: name, ok: false, detail: (err as Error).message, ms: Date.now() - t0 });
    console.log(`  ✖ ${name}: ${(err as Error).message}`);
    throw err;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const note = (s: string) => console.log(`      ${s}`);

async function waitUntil<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (err) {
      last = err;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ''}`);
}

async function api(method: string, url: string, body?: unknown, token?: string) {
  const res = await fetch(SERVER + url, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.arrayBuffer(), headers: res.headers } as { status: number; body: any; headers: Headers };
}

async function ok(method: string, url: string, body?: unknown, token?: string) {
  const r = await api(method, url, body, token);
  if (r.status >= 300) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** A phone: solid-colour 640x360 H.264 + 440 Hz AAC over SRT, like RootEncoder/HaishinKit. */
function publish(name: string, srtUrl: string, rgb: readonly number[]): ChildProcess {
  const url = srtUrl.replace(/latency=(\d+)/, (_, ms) => `latency=${Number(ms) * 1000}`) + '&pkt_size=1316';
  const hex = rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  return start(`pub-${name}`, 'ffmpeg', [
    '-hide_banner', '-loglevel', 'warning', '-re',
    '-f', 'lavfi', '-i', `color=c=0x${hex}:s=640x360:r=15`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-g', '15', '-b:v', '400k',
    '-c:a', 'aac', '-b:a', '64k', '-f', 'mpegts', url,
  ]);
}

/** Average colour of one frame of a stream. */
function frameColor(url: string): [number, number, number] | null {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rw_timeout', '8000000', '-i', url, '-frames:v', '1', '-vf', 'scale=32:18', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
    timeout: 15000,
    maxBuffer: 1 << 20,
  });
  const b = r.stdout;
  if (!b || b.length < 32 * 18 * 3) return null;
  let rr = 0, gg = 0, bb = 0;
  const n = b.length / 3;
  for (let i = 0; i < b.length; i += 3) {
    rr += b[i];
    gg += b[i + 1];
    bb += b[i + 2];
  }
  return [Math.round(rr / n), Math.round(gg / n), Math.round(bb / n)];
}

function dominant(c: [number, number, number] | null): 'red' | 'green' | 'blue' | 'dark' | 'none' {
  if (!c) return 'none';
  const [r, g, b] = c;
  if (Math.max(r, g, b) < 70) return 'dark';
  if (r > g + 60 && r > b + 60) return 'red';
  if (g > r + 60 && g > b + 60) return 'green';
  if (b > r + 60 && b > g + 60) return 'blue';
  return 'dark';
}

/** Mean audio level (dB) of a few seconds of a stream. */
function meanVolume(url: string, seconds = 3): number | null {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-rw_timeout', '8000000', '-i', url, '-t', String(seconds), '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 20000 });
  const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr?.toString() ?? '');
  if (!m) return null;
  return m[1] === '-inf' ? -120 : Number(m[1]);
}

class Client {
  ws: WebSocket;
  msgs: any[] = [];
  constructor(token: string) {
    this.ws = new WebSocket(`${SERVER.replace('http', 'ws')}/ws`, { headers: { Authorization: `Bearer ${token}` } });
    this.ws.on('message', (raw) => this.msgs.push(JSON.parse(raw.toString())));
  }
  open() {
    return new Promise<void>((r, j) => {
      this.ws.once('open', () => r());
      this.ws.once('error', j);
    });
  }
  send(m: object) {
    this.ws.send(JSON.stringify(m));
  }
  latest(type: string) {
    return [...this.msgs].reverse().find((m) => m.type === type);
  }
  find(pred: (m: any) => boolean) {
    return this.msgs.find(pred);
  }
}

async function main() {
  console.log(`Go Live Director v2 end-to-end test (real OBS, cloud mode)\n  logs: ${work}\n`);
  const engineLog = path.join(work, 'engine-home');

  await step('reset e2e database', async () => {
    const { default: pg } = await import(path.join(root, 'server/node_modules/pg/lib/index.js'));
    const admin = new pg.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') });
    await admin.connect();
    const dbName = DATABASE_URL.split('/').pop()!;
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
  });

  // ---------------------------------------------------------------- infrastructure
  const ytConf = path.join(work, 'yt-mediamtx.yml');
  fs.writeFileSync(
    ytConf,
    [
      'logLevel: warn', `rtmpAddress: :${P.ytRtmp}`, 'rtsp: no', 'hls: no', 'webrtc: no', 'srt: no',
      `api: no`, 'paths:', '  all_others:',
    ].join('\n'),
  );
  start('fake-youtube', MEDIAMTX_BIN, [ytConf]);
  const google = startFakeGoogle(P.google, { server: `rtmp://127.0.0.1:${P.ytRtmp}/live2`, key: 'yt-e2e-key' }, `rtmp://127.0.0.1:${P.ytRtmp}/rtmp/fb-e2e-key`);
  await google.listen();
  const ytOut = `rtmp://127.0.0.1:${P.ytRtmp}/live2/yt-e2e-key`;
  const fbOut = `rtmp://127.0.0.1:${P.ytRtmp}/rtmp/fb-e2e-key`;
  const igOut = `rtmp://127.0.0.1:${P.ytRtmp}/igrtmp/ig-e2e-key`;

  const secrets = { JWT_SECRET: 'e2e-jwt-secret-e2e-jwt-secret-e2e-jwt', MEDIAMTX_HOOK_SECRET: 'e2e-hook-secret-123456', INTERNAL_MEDIA_PASS: 'e2e-internal-pass-123456' };
  start('server', 'node', [path.join(root, 'server/dist/index.js')], {
    PORT: String(P.http),
    HOST: '127.0.0.1',
    DATABASE_URL,
    ...secrets,
    DATA_KEY: 'b'.repeat(64),
    PUBLIC_BASE_URL: SERVER,
    MEDIAMTX_API_URL: `http://127.0.0.1:${P.api}`,
    MEDIAMTX_RTSP_URL: `rtsp://127.0.0.1:${P.rtsp}`,
    MEDIAMTX_PLAYBACK_URL: `http://127.0.0.1:${P.playback}`,
    PUBLIC_SRT_HOST: '127.0.0.1',
    PUBLIC_SRT_PORT: String(P.srt),
    PUBLIC_WEBRTC_BASE: `http://127.0.0.1:${P.webrtc}`,
    THUMBNAIL_DIR: path.join(work, 'thumbs'),
    THUMBNAIL_INTERVAL_SEC: '2',
    THUMBNAILS_ENABLED: process.env.E2E_THUMBNAILS ?? 'false',
    MEDIA_DIR: path.join(work, 'media'),
    HEALTH_POLL_MS: '1000',
    AUTO_FALLBACK_GRACE_MS: '2000',
    GOOGLE_CLIENT_ID: 'e2e-client',
    GOOGLE_CLIENT_SECRET: 'e2e-secret',
    GOOGLE_AUTH_URL: `http://127.0.0.1:${P.google}/auth`,
    GOOGLE_TOKEN_URL: `http://127.0.0.1:${P.google}/token`,
    YOUTUBE_API_BASE: `http://127.0.0.1:${P.google}/yt`,
    YOUTUBE_POLL_MS: '3000',
    META_APP_ID: 'e2e-meta-app',
    META_APP_SECRET: 'e2e-meta-secret',
    META_AUTH_URL: `http://127.0.0.1:${P.google}/fb`,
    META_GRAPH_BASE: `http://127.0.0.1:${P.google}/graph`,
    RELAY_RETRY_MAX_SEC: '4',
    PUBLIC_CORS_ORIGINS: 'https://cogolfers.com',
    WATCH_EMBED_ORIGINS: 'https://cogolfers.com',
    CLOUD_ENGINE_DRIVER: 'process',
    CLOUD_ENGINE_PROCESS_CMD: `bash ${path.join(root, 'infra/cloud-engine/entrypoint.sh')}`,
    CLOUD_ENGINE_SERVER_URL: SERVER,
    CLOUD_ENGINE_MEDIA_BASE_URL: SERVER,
    CLOUD_ENGINE_WIDTH: '640',
    CLOUD_ENGINE_HEIGHT: '360',
    CLOUD_ENGINE_FPS: '15',
    CLOUD_ENGINE_VIDEO_KBPS: '900',
    AGENT_CMD: `node ${path.join(root, 'agent/dist/index.js')}`,
    CANVAS: '640x360',
    STATE_INTERVAL_MS: '1000',
    BOOTSTRAP_ADMIN_EMAIL: 'admin@cogolfers.test',
    BOOTSTRAP_ADMIN_PASSWORD: 'admin-password-123',
    BILLING_TICK_MS: '1000',
    YOUTUBE_CHAT_POLL_SEC: '2',
    FACEBOOK_COMMENTS_POLL_SEC: '2',
    LOG_LEVEL: 'info',
  });
  await step('server starts and migrates', () => waitUntil(async () => (await fetch(`${SERVER}/healthz`)).ok, 15000, 'server /healthz'));
  start('mediamtx', MEDIAMTX_BIN, [path.join(root, 'infra/mediamtx.yml')], {
    MTX_AUTHHTTPADDRESS: `http://127.0.0.1:${P.http}/internal/mediamtx/auth?secret=${secrets.MEDIAMTX_HOOK_SECRET}`,
    MTX_APIADDRESS: `127.0.0.1:${P.api}`,
    MTX_PLAYBACKADDRESS: `127.0.0.1:${P.playback}`,
    MTX_RTSPADDRESS: `127.0.0.1:${P.rtsp}`,
    MTX_SRTADDRESS: `:${P.srt}`,
    MTX_WEBRTCADDRESS: `127.0.0.1:${P.webrtc}`,
    MTX_WEBRTCLOCALUDPADDRESS: `127.0.0.1:${P.webrtcUdp}`,
    MTX_WEBRTCADDITIONALHOSTS: '127.0.0.1',
    MTX_PATHDEFAULTS_RECORDPATH: path.join(work, 'recordings/%path/%Y-%m-%d_%H-%M-%S-%f'),
  });
  await step('MediaMTX (ingest, recording, playback) is up and reachable by the server', () =>
    waitUntil(async () => (await (await fetch(`${SERVER}/healthz`)).json()).mediaServer.reachable, 15000, 'mediaServer.reachable'),
  );

  // ---------------------------------------------------------------- self-serve setup
  const owner = await step('an organiser signs up: account + club in one step', async () => {
    const r = await ok('POST', '/api/auth/signup', { name: 'Mohit', email: 'mohit@club.test', password: 'password-123', orgName: 'Gurgaon Golf Club' });
    return { token: r.token as string, orgId: r.orgs[0].id as string };
  });
  const directorToken = await step('owner adds a director by email', async () => {
    await ok('POST', `/api/orgs/${owner.orgId}/members`, { email: 'dir@club.test', role: 'director', name: 'Director', password: 'password-123' }, owner.token);
    return (await ok('POST', '/api/auth/login', { email: 'dir@club.test', password: 'password-123' })).token as string;
  });
  const tid = await step('director creates a cloud-production tournament with course and players', async () => {
    const t = await ok('POST', `/api/orgs/${owner.orgId}/tournaments`, { name: 'E2E Open', venue: 'Test Course', mode: 'cloud' }, directorToken);
    await ok('PUT', `/api/tournaments/${t.tournament.id}/holes`, { preset: 'par72' }, directorToken);
    await ok('POST', `/api/tournaments/${t.tournament.id}/players`, { csv: 'Aman Sharma,DLF,Open,1\nBina Rao,Classic,Ladies,1\nChirag Jain,KGA,Open,2\nDia Kapoor,DLF,Ladies,2' }, directorToken);
    return t.tournament.id as string;
  });
  const adminToken = await step('CoGolfers admin (/admin) sets pricing and gives the club credits', async () => {
    const token = (await ok('POST', '/api/auth/login', { email: 'admin@cogolfers.test', password: 'admin-password-123' })).token as string;
    if ((await api('GET', '/api/admin/overview', undefined, owner.token)).status !== 403) throw new Error('club owner reached the admin API');
    // No free minutes here so the live meter is visible within the test: 1 credit per minute.
    await ok('PUT', '/api/admin/settings', { pricing: { freeCameras: 2, freeMinutes: 0, cameraPrice: 50, minutePrice: 1, graceMinutes: 5 } }, token);
    const r = await ok('POST', `/api/admin/orgs/${owner.orgId}/credits`, { credits: 100, note: 'Welcome credits' }, token);
    if (r.balance !== 100) throw new Error(`balance ${r.balance}`);
    const page = await fetch(`${SERVER}/admin`);
    if (!(await page.text()).includes('Go Live Admin')) throw new Error('admin page missing');
    return token;
  });
  const codes = await step('QR join codes for camera, scorer and commentator volunteers', async () => {
    const mk = async (role: string) => (await ok('POST', `/api/tournaments/${tid}/join-codes`, { role }, directorToken)).code;
    const c = { camera: await mk('camera'), scorer: await mk('scorer'), commentator: await mk('commentator') };
    const qr = await api('GET', c.camera.qrUrl, undefined, directorToken);
    if (qr.status !== 200 || !String(qr.headers.get('content-type')).includes('png')) throw new Error('QR PNG missing');
    fs.writeFileSync(path.join(shots, 'join-qr-camera.png'), Buffer.from(qr.body));
    return c;
  });
  const join = async (code: string, deviceId: string, name: string) => (await ok('POST', '/api/join', { code, deviceId, name })).token as string;

  const cams = await step('three volunteers join by code and register cameras: 2 free, the 3rd after buying an extra camera', async () => {
    const reg = async (name: string, hole: number, device: string) => {
      const token = await join(codes.camera.code, device, name);
      const body = { name, hole, position: 'Tee', platform: hole === 1 ? 'android' : 'ios', deviceId: device };
      let r = await api('POST', `/api/tournaments/${tid}/cameras/register`, body, token);
      if (r.status === 402 && r.body.error.code === 'camera_limit') {
        note(`3rd camera refused: "${r.body.error.message.slice(0, 60)}…"; director buys one`);
        const b = await ok('POST', `/api/tournaments/${tid}/billing/cameras`, { count: 1 }, directorToken);
        if (b.billing.cameras.limit !== 3 || b.billing.balance !== 50) throw new Error(`after purchase ${JSON.stringify(b.billing.cameras)} balance ${b.billing.balance}`);
        r = await api('POST', `/api/tournaments/${tid}/cameras/register`, body, token);
      }
      if (r.status >= 300) throw new Error(`register ${name}: ${r.status} ${JSON.stringify(r.body)}`);
      return { id: r.body.camera.id as string, path: r.body.camera.streamPath as string, url: r.body.publish.srtUrl as string, name, token };
    };
    const list = [await reg('Hole 1 Tee', 1, 'e2e-dev-0001'), await reg('Hole 7 Green', 7, 'e2e-dev-0002'), await reg('Hole 18 Green', 18, 'e2e-dev-0003')];
    const t = await ok('GET', `/api/tournaments/${tid}/billing`, undefined, directorToken);
    if (t.billing.cameras.used !== 3 || t.billing.cameras.extra !== 1) throw new Error(JSON.stringify(t.billing.cameras));
    return list;
  });

  const pubs = new Map<string, ChildProcess>();
  pubs.set(cams[0].id, publish('cam1', cams[0].url, COLORS.cam1));
  pubs.set(cams[1].id, publish('cam2', cams[1].url, COLORS.cam2));
  pubs.set(cams[2].id, publish('cam3', cams[2].url, COLORS.cam3));

  const director = new Client(directorToken);
  await director.open();
  director.send({ type: 'subscribe', tournamentId: tid });
  await step('all three feeds go live in the control room', () =>
    waitUntil(() => director.latest('cameras')?.cameras.every((c: any) => c.status === 'live') && true, 25000, 'cameras live'),
  );

  // ---------------------------------------------------------------- YouTube connect
  await step('owner connects YouTube once (OAuth); director creates the broadcast', async () => {
    const { url } = await ok('POST', `/api/orgs/${owner.orgId}/youtube/connect`, undefined, owner.token);
    const consent = await fetch(url, { redirect: 'manual' });
    const callback = consent.headers.get('location')!;
    const page = await fetch(callback);
    if (page.status !== 200) throw new Error(`callback ${page.status}`);
    const r = await ok('POST', `/api/tournaments/${tid}/youtube/broadcast`, { privacy: 'unlisted' }, directorToken);
    note(`broadcast ${r.broadcast.broadcastId}, ingest ${r.broadcast.ingestUrl}`);
  });

  await step('owner connects the club’s Facebook Page; director turns on Facebook and pastes the Instagram key', async () => {
    const { url } = await ok('POST', `/api/orgs/${owner.orgId}/facebook/connect`, undefined, owner.token);
    const consent = await fetch(url, { redirect: 'manual' });
    const page = await fetch(consent.headers.get('location')!);
    if (page.status !== 200) throw new Error(`facebook callback ${page.status}: ${await page.text()}`);
    const fb = await ok('GET', `/api/orgs/${owner.orgId}/facebook`, undefined, directorToken);
    if (fb.pageName !== 'Gurgaon Golf Club') throw new Error(`page not selected: ${JSON.stringify(fb)}`);
    const r = await ok('PATCH', `/api/tournaments/${tid}/outputs`, {
      facebook: { enabled: true },
      instagram: { streamUrl: `rtmp://127.0.0.1:${P.ytRtmp}/igrtmp/`, streamKey: 'ig-e2e-key' },
    }, directorToken);
    note(r.outputs.platforms.map((p: any) => `${p.platform}: ${p.configured && p.enabled ? 'on' : 'off'}`).join(' · '));
    if (!r.outputs.platforms.every((p: any) => p.configured && p.enabled)) throw new Error('not all platforms ready');
  });

  // ---------------------------------------------------------------- cloud engine (real OBS)
  await step('director starts the cloud engine: real OBS boots headless and the agent connects', async () => {
    await ok('POST', `/api/tournaments/${tid}/cloud-engine/start`, undefined, directorToken);
    await waitUntil(() => director.find((m) => m.type === 'production' && m.production.cloud.status === 'running'), 90000, 'cloud engine running');
    const e = await waitUntil(() => director.find((m) => m.type === 'engine' && m.engine.obsConnected), 30000, 'OBS connected');
    note(`OBS ${e.engine.obsVersion}${e.engine.warnings?.length ? ` · warning: ${e.engine.warnings[0]}` : ''}`);
  });

  const command = async (action: string, extra: Record<string, unknown>, requestId: string, timeout = 15000) => {
    const t0 = Date.now();
    director.send({ type: 'command', action, requestId, ...extra });
    const res = await waitUntil(() => director.find((m) => m.type === 'command.result' && m.requestId === requestId), timeout, `${action} result`);
    if (!res.ok) throw new Error(`${action} failed: ${res.error}`);
    return Date.now() - t0;
  };
  const programme = (id: string | null) => waitUntil(() => director.latest('engine')?.engine.programmeCameraId === id, 15000, `programme = ${id}`);

  await step('preview Hole 7, TAKE: OBS confirms the programme', async () => {
    await command('preview', { cameraId: cams[1].id }, 'p1');
    const ms = await command('take', {}, 't1');
    await programme(cams[1].id);
    note(`take round trip ${ms} ms (real OBS)`);
  });

  await step('Go live: OBS sends ONE stream (SRT) to the server, which relays it to YouTube, Facebook and Instagram', async () => {
    await command('stream.start', {}, 's1');
    await waitUntil(() => director.latest('engine')?.engine.streaming.active, 20000, 'streaming active');
    if (google.facebook.created !== 1) throw new Error('Facebook live video not created');
    const t0 = Date.now();
    const o = await waitUntil(() => {
      const m = director.latest('outputs');
      return m && m.outputs.platforms.every((p: any) => p.state === 'live') ? m : null;
    }, 45000, 'all three platforms live');
    note(`all platforms live ${((Date.now() - t0) / 1000).toFixed(1)} s after OBS started; Facebook link ${o.outputs.platforms[1].link}`);
  });

  await step('live minutes are charged from the club wallet while on air (1 credit/min)', async () => {
    const b = await waitUntil(() => {
      const m = director.latest('billing');
      return m && m.billing.balance <= 49 ? m.billing : null;
    }, 15000, 'first live minute charged');
    const w = await ok('GET', `/api/orgs/${owner.orgId}/billing`, undefined, owner.token);
    const line = w.transactions.find((t: any) => t.kind === 'minutes');
    if (!line || line.tournamentName !== 'E2E Open') throw new Error('no live-minutes line');
    note(`balance ${b.balance} credits, about ${b.minutes.remainingSeconds / 60} min left; live line ${line.quantity} min`);
  });

  const graphicsKey = async () => {
    const { default: pg } = await import(path.join(root, 'server/node_modules/pg/lib/index.js'));
    const db = new pg.Client({ connectionString: DATABASE_URL });
    await db.connect();
    try {
      return (await db.query('SELECT graphics_key FROM tournaments WHERE id = $1', [tid])).rows[0].graphics_key as string;
    } finally {
      await db.end();
    }
  };
  await step('viewer comments: watch page, YouTube and Facebook in one feed; director puts a question on air', async () => {
    const pubChat = `/api/public/tournaments/${tid}/chat`;
    const name = await ok('POST', `${pubChat}/name`, { name: 'Rahul (watch page)' });
    const posted = await api('POST', pubChat, { text: 'Which club did he hit into 7?' }, name.token);
    if (posted.status !== 201) throw new Error(`watch post ${posted.status} ${JSON.stringify(posted.body)}`);
    google.chat.youtube.push({ id: 'yt-1', snippet: { type: 'textMessageEvent', displayMessage: 'Great shot! Watching from Mumbai', publishedAt: new Date().toISOString() }, authorDetails: { displayName: 'Arjun (YouTube)', channelId: 'UC-arjun' } });
    google.chat.facebook.push({ id: 'fbc-1', message: 'Is the 18th reachable in two today?', created_time: new Date().toISOString(), from: { id: 'f-priya', name: 'Priya (Facebook)' } });
    const feed = await waitUntil(async () => {
      const f = await ok('GET', `/api/tournaments/${tid}/chat`, undefined, directorToken);
      return f.messages && ['watch', 'youtube', 'facebook'].every((s) => f.messages.some((m: any) => m.source === s)) ? f : null;
    }, 15000, 'all three sources in the feed');
    if (feed.sources.youtube.state !== 'reading' || feed.sources.facebook.state !== 'reading') throw new Error(JSON.stringify(feed.sources));
    const pub = await ok('GET', pubChat);
    if (pub.messages.length !== 3) throw new Error(`watch page shows ${pub.messages.length} messages`);
    const q = feed.messages.find((m: any) => m.source === 'facebook');
    if (!q.question) throw new Error('question not detected');
    const g = await ok('POST', `/api/chat/${q.id}/on-air`, {}, directorToken);
    if (!g.graphics.question.visible) throw new Error('question not on air');
    const st = await ok('GET', `/api/graphics/${tid}/state?k=${(await graphicsKey())}`);
    if (st.question?.author !== 'Priya (Facebook)') throw new Error(`overlay: ${JSON.stringify(st.question)}`);
    await ok('POST', `/api/chat/${q.id}/on-air`, { visible: false }, directorToken);
    note(`YouTube read ${google.chat.ytReads}×, Facebook ${google.chat.fbReads}×; question on air and off`);
  });

  const outputColor = async (want: string, what: string, ms = 25000) =>
    waitUntil(() => {
      const c = frameColor(ytOut);
      return dominant(c) === want ? c : null;
    }, ms, what);

  await step('YouTube output shows Hole 7 (green) — the real programme', async () => {
    const c = await outputColor('green', 'green output');
    note(`output frame RGB ${c.join(',')}`);
  });

  await step('one-tap CUT to Hole 1: YouTube output turns red', async () => {
    const ms = await command('cut', { cameraId: cams[0].id }, 'c1');
    await programme(cams[0].id);
    const c = await outputColor('red', 'red output');
    note(`cut round trip ${ms} ms; output RGB ${c.join(',')}`);
  });

  await step('Facebook and Instagram carry the same programme (red); Instagram is 9:16 720x1280; programme not recorded', async () => {
    const fbc = await waitUntil(() => (dominant(frameColor(fbOut)) === 'red' ? frameColor(fbOut) : null), 20000, 'red on Facebook');
    const size = spawnSync('ffprobe', ['-v', 'error', '-rw_timeout', '8000000', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', igOut], { timeout: 15000 }).stdout.toString().trim();
    if (size !== '720,1280') throw new Error(`Instagram output is ${size}`);
    const igFrame = path.join(shots, 'instagram-output.png');
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-rw_timeout', '8000000', '-i', igOut, '-frames:v', '1', '-vf', 'scale=360:640', igFrame], { timeout: 15000 });
    const centre = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', igFrame, '-vf', 'crop=120:60:120:290,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']).stdout;
    const top = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', igFrame, '-vf', 'crop=120:60:120:40,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']).stdout;
    const c = [...centre], tp = [...top];
    if (dominant(c as [number, number, number]) !== 'red') throw new Error(`Instagram centre is ${c}`);
    if (!(tp[0] < c[0])) throw new Error(`Instagram fill is not the darker blurred picture (${tp} vs ${c})`);
    const rec = path.join(work, 'recordings');
    const progRecorded = fs.existsSync(rec) && fs.readdirSync(rec).some((d) => d.startsWith('prog-'));
    if (progRecorded) throw new Error('programme path was recorded');
    note(`Facebook RGB ${fbc.join(',')} · Instagram 720x1280, centre ${c.join(',')}, blurred fill ${tp.join(',')}`);
  });

  // ---------------------------------------------------------------- scoring + graphics
  await step('a volunteer scorer enters scores; leaderboard and graphics feed update', async () => {
    const scorer = await join(codes.scorer.code, 'e2e-scorer-01', 'Scorer');
    const players = (await ok('GET', `/api/tournaments/${tid}/players`, undefined, scorer)).players;
    const s = async (i: number, hole: number, strokes: number) => ok('PUT', `/api/tournaments/${tid}/scores`, { playerId: players[i].id, hole, strokes }, scorer);
    await s(0, 1, 3); await s(0, 2, 4); await s(0, 3, 2);
    await s(1, 1, 4); await s(1, 2, 3);
    await s(2, 1, 5);
    await s(3, 1, 4); await s(3, 2, 4); await s(3, 3, 3);
    const lb = await ok('GET', `/api/tournaments/${tid}/leaderboard`, undefined, scorer);
    note(lb.rows.map((r: any) => `${r.position} ${r.name} ${r.toParText} (${r.thru})`).join(' | '));
    await ok('PATCH', `/api/tournaments/${tid}/graphics`, { leaderboard: { visible: true }, lowerThird: { visible: false } }, directorToken);
  });

  await step('graphics overlay renders (Chromium, 1920x1080) over the live programme', async () => {
    const { default: pg } = await import(path.join(root, 'server/node_modules/pg/lib/index.js'));
    const db = new pg.Client({ connectionString: DATABASE_URL });
    await db.connect();
    const gk = (await db.query('SELECT graphics_key FROM tournaments WHERE id = $1', [tid])).rows[0].graphics_key;
    await db.end();
    const players = (await ok('GET', `/api/tournaments/${tid}/players`, undefined, directorToken)).players;
    const frame = path.join(work, 'programme.png');
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', ytOut, '-frames:v', '1', '-vf', 'scale=1920:1080', frame], { timeout: 15000 });
    const render = (name: string) =>
      spawnSync('python3', [path.join(here, 'render-graphics.py'), `${SERVER}/graphics/${tid}?k=${gk}`, path.join(work, `${name}.overlay.png`)], { timeout: 30000 });
    const compose = (name: string) =>
      spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', frame, '-i', path.join(work, `${name}.overlay.png`), '-filter_complex', 'overlay', path.join(shots, `${name}.png`)]);
    const r1 = render('graphics-leaderboard');
    if (r1.status !== 0) throw new Error(`render failed: ${r1.stderr?.toString().slice(-300)}`);
    compose('graphics-leaderboard');
    await ok('PATCH', `/api/tournaments/${tid}/graphics`, { leaderboard: { visible: false }, lowerThird: { visible: true, playerId: players[0].id }, holeCard: { visible: true, hole: 3 } }, directorToken);
    await sleep(500);
    render('graphics-lowerthird');
    compose('graphics-lowerthird');
    await ok('PATCH', `/api/tournaments/${tid}/graphics`, { lowerThird: { visible: false }, holeCard: { visible: false } }, directorToken);
    if (!fs.existsSync(path.join(shots, 'graphics-leaderboard.png'))) throw new Error('no composite');
    note(`screenshots: ${shots}`);
  });

  // ---------------------------------------------------------------- replay
  await step('instant replay of Hole 18: OBS plays it (blue), then returns to Hole 1 (red)', async () => {
    await sleep(3000);
    await command('replay', { cameraId: cams[2].id, seconds: 6 }, 'rp1', 30000);
    await waitUntil(() => director.latest('engine')?.engine.replayActive, 10000, 'replayActive');
    const g = await waitUntil(() => director.find((m) => m.type === 'graphics' && m.graphics.replay), 5000, 'REPLAY graphic on');
    void g;
    const blue = await outputColor('blue', 'replay (blue) on output', 20000);
    note(`replay frame RGB ${blue.join(',')}`);
    await waitUntil(() => director.latest('engine')?.engine.replayActive === false, 30000, 'replay finished');
    await programme(cams[0].id);
    await outputColor('red', 'back to red after replay', 20000);
  });

  // ---------------------------------------------------------------- clips
  await step('one-tap highlight clip: 16:9 and 9:16 (1080x1920) MP4s and a share link', async () => {
    const r = await ok('POST', `/api/tournaments/${tid}/clips`, { cameraId: cams[1].id, secondsBack: 6, durationSec: 5, title: 'Birdie on 7!' }, directorToken);
    const ready = await waitUntil(() => director.find((m) => m.type === 'clip' && m.clip.id === r.clip.id && (m.clip.status === 'ready' || m.clip.status === 'failed')), 120000, 'clip ready');
    if (ready.clip.status !== 'ready') throw new Error(`clip failed: ${ready.clip.error}`);
    const share = await ok('POST', `/api/clips/${r.clip.id}/share`, undefined, directorToken);
    const vert = await fetch(share.verticalUrl);
    const vfile = path.join(shots, 'clip-vertical.mp4');
    fs.writeFileSync(vfile, Buffer.from(await vert.arrayBuffer()));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'csv=p=0', vfile]).stdout.toString().trim();
    if (!probe.includes('1080,1920')) throw new Error(`vertical clip is ${probe}`);
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '2', '-i', vfile, '-frames:v', '1', '-vf', 'scale=540:960', path.join(shots, 'clip-vertical-frame.png')]);
    const land = await fetch(share.landscapeUrl, { headers: { range: 'bytes=0-99' } });
    if (land.status !== 206) throw new Error(`range request got ${land.status}`);
    note(`vertical ${probe.replace('\n', ' · ')}s, ${(ready.clip.sizeBytes / 1024).toFixed(0)} KB total`);
  });

  // ---------------------------------------------------------------- commentary + audio
  await step('a volunteer commentator joins and sends their mic over WebRTC (WHIP)', async () => {
    const token = await join(codes.commentator.code, 'e2e-com-001', 'Vikram');
    const r = await ok('POST', `/api/tournaments/${tid}/commentators/register`, { name: 'Vikram', deviceId: 'e2e-com-001' }, token);
    const { RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack } = await import('werift');
    const track = new MediaStreamTrack({ kind: 'audio' });
    const pc = new RTCPeerConnection({ codecs: { audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2 })], video: [] } });
    pc.addTransceiver(track, { direction: 'sendonly' });
    await pc.setLocalDescription(await pc.createOffer());
    await waitUntil(() => pc.iceGatheringState === 'complete', 5000, 'ICE');
    const res = await fetch(r.publish.whipUrl, { method: 'POST', headers: { 'content-type': 'application/sdp', authorization: `Bearer ${r.publish.bearer}` }, body: pc.localDescription!.sdp });
    if (res.status !== 201) throw new Error(`WHIP ${res.status}: ${await res.text()}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    // A "voice": 1 kHz tone encoded to Opus RTP by ffmpeg, forwarded into the WebRTC track.
    const sock = dgram.createSocket('udp4');
    await new Promise<void>((r2) => sock.bind(0, '127.0.0.1', () => r2()));
    sock.on('message', (m) => track.writeRtp(m));
    start('commentator-mic', 'ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-re', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-c:a', 'libopus', '-b:a', '48k', '-f', 'rtp', `rtp://127.0.0.1:${sock.address().port}`]);
    await waitUntil(() => director.latest('cameras')?.commentators?.some((c: any) => c.online), 20000, 'commentator online');
    (globalThis as any).__pc = pc;
  });

  await step('audio mixer on real OBS: course muted → only commentary on air; both muted → silence', async () => {
    // Look inside the cloud OBS (its websocket password is in the engine's own config).
    const ini = fs.readFileSync(path.join(os.tmpdir(), `cg-engine-${tid.slice(0, 8)}`, '.config/obs-studio/global.ini'), 'utf8');
    const port = /ServerPort=(\d+)/.exec(ini)![1];
    const pass = /ServerPassword=(\S+)/.exec(ini)![1];
    const { OBSWebSocket } = await import('obs-websocket-js');
    const obs = new OBSWebSocket();
    await obs.connect(`ws://127.0.0.1:${port}`, pass, { rpcVersion: 1 });
    const comInput = (await obs.call('GetInputList')).inputs.map((i: any) => String(i.inputName)).find((n: string) => n.startsWith('CG Commentary '))!;
    const inspect = async () => {
      const [m, v, st] = await Promise.all([
        obs.call('GetInputMute', { inputName: comInput }),
        obs.call('GetInputVolume', { inputName: comInput }),
        obs.call('GetMediaInputStatus', { inputName: comInput }),
      ]);
      return `muted=${m.inputMuted} vol=${v.inputVolumeDb.toFixed(1)}dB state=${st.mediaState}`;
    };
    await waitUntil(async () => (await obs.call('GetMediaInputStatus', { inputName: comInput })).mediaState === 'OBS_MEDIA_STATE_PLAYING', 20000, 'commentary playing in OBS');
    note(`OBS commentary source: ${await inspect()} · load average ${os.loadavg()[0].toFixed(2)} on ${os.cpus().length} CPUs`);
    await sleep(3000);
    const both = meanVolume(ytOut);
    await ok('PATCH', `/api/tournaments/${tid}/audio`, { courseMuted: true, ducking: false }, directorToken);
    await sleep(2500);
    const commentaryOnly = meanVolume(ytOut);
    await ok('PATCH', `/api/tournaments/${tid}/audio`, { commentaryMuted: true }, directorToken);
    await sleep(2500);
    const silent = meanVolume(ytOut);
    note(`mean volume: course+commentary ${both} dB, commentary only ${commentaryOnly} dB, both muted ${silent} dB`);
    note(`OBS commentary source after mutes: ${await inspect()}`);
    await obs.disconnect();
    if (commentaryOnly === null || commentaryOnly < -45) throw new Error(`commentary not on air (${commentaryOnly} dB)`);
    if (silent === null || silent > -70) throw new Error(`output not silent with everything muted (${silent} dB)`);
    await ok('PATCH', `/api/tournaments/${tid}/audio`, { courseMuted: false, commentaryMuted: false, ducking: true }, directorToken);
  });

  // ---------------------------------------------------------------- failures
  await step('Hole 1 phone drops on air → automatic fallback scene on the YouTube output', async () => {
    pubs.get(cams[0].id)!.kill('SIGKILL');
    await waitUntil(() => director.latest('engine')?.engine.fallbackActive, 20000, 'fallbackActive');
    const c = await outputColor('dark', 'fallback (dark green) on output', 20000);
    note(`fallback frame RGB ${c.join(',')}`);
    await waitUntil(() => director.find((m) => m.type === 'alert' && /fallback/i.test(m.message)), 5000, 'alert');
  });

  await step('the phone reconnects; director cuts back to it', async () => {
    pubs.set(cams[0].id, publish('cam1-again', cams[0].url, COLORS.cam1));
    await waitUntil(() => director.latest('cameras')?.cameras.find((c: any) => c.id === cams[0].id)?.status === 'live', 20000, 'cam1 live');
    await command('cut', { cameraId: cams[0].id }, 'c2');
    await outputColor('red', 'red again', 20000);
  });

  await step('YouTube status reaches the director', async () => {
    const y = await waitUntil(() => director.find((m) => m.type === 'youtube' && m.youtube.streamStatus === 'active'), 15000, 'youtube status');
    note(`YouTube: ${y.youtube.lifeCycleStatus}, stream ${y.youtube.streamStatus}, health ${y.youtube.health}, ${y.youtube.watchUrl}`);
  });

  await step('public watch page for the CoGolfers website: API (CORS), live status, leaderboard, clips, embeddable page', async () => {
    const res = await fetch(`${SERVER}/api/public/live`, { headers: { origin: 'https://cogolfers.com' } });
    if (res.headers.get('access-control-allow-origin') !== 'https://cogolfers.com') throw new Error('CORS header missing');
    const live = (await res.json()).tournaments.find((t: any) => t.id === tid);
    if (!live?.live || live.youtube?.videoId !== 'e2e-broadcast') throw new Error(`live list wrong: ${JSON.stringify(live)}`);
    const d = await (await fetch(`${SERVER}/api/public/tournaments/${tid}`)).json();
    if (d.leaderboard.length !== 4 || !d.clips.length) throw new Error(`watch data: ${d.leaderboard.length} rows, ${d.clips.length} clips`);
    const page = await fetch(`${SERVER}/watch/${tid}`);
    if (!/frame-ancestors 'self' https:\/\/cogolfers\.com/.test(page.headers.get('content-security-policy') ?? '')) throw new Error('embed policy missing');
    const shot = spawnSync('python3', [path.join(here, 'render-page.py'), `${SERVER}/watch/${tid}`, path.join(shots, 'watch-page.png')], { timeout: 40000 });
    spawnSync('python3', [path.join(here, 'render-page.py'), `${SERVER}/watch/${tid}?tab=chat`, path.join(shots, 'watch-page-chat.png')], { timeout: 40000 });
    if (shot.status !== 0) throw new Error(`watch page render failed: ${shot.stderr?.toString().slice(-300)}`);
    note(`leader ${d.leaderboard[0].name} ${d.leaderboard[0].toPar} · ${d.clips.length} clip(s) · on camera hole ${d.onAir?.hole ?? '–'}`);
  });

  await step('end the stream: relays stop, Facebook live video ended; cloud engine stops (OBS exits)', async () => {
    await command('stream.stop', {}, 's2');
    await waitUntil(() => director.latest('engine')?.engine.streaming.active === false, 15000, 'stream stopped');
    await waitUntil(() => director.latest('outputs')?.outputs.platforms.every((p: any) => p.state === 'off'), 10000, 'relays off');
    await waitUntil(() => google.facebook.ended === 1, 10000, 'Facebook live video ended');
    await ok('POST', `/api/tournaments/${tid}/cloud-engine/stop`, undefined, directorToken);
    await waitUntil(() => director.find((m) => m.type === 'production' && m.production.cloud.status === 'stopped'), 15000, 'stopped');
    await waitUntil(() => spawnSync('pgrep', ['-f', 'obs --multi']).status !== 0, 15000, 'OBS process gone');
  });

  await step('billing after the show: charging stopped; admin sees the club, its minutes and camera purchase', async () => {
    const before = (await ok('GET', `/api/orgs/${owner.orgId}/billing`, undefined, owner.token)).balance;
    await new Promise((r) => setTimeout(r, 2500));
    const w = await ok('GET', `/api/orgs/${owner.orgId}/billing`, undefined, owner.token);
    if (w.balance !== before) throw new Error('still charging after the stream ended');
    const minutes = w.transactions.filter((t: any) => t.kind === 'minutes').reduce((a: number, t: any) => a + t.quantity, 0);
    const d = await ok('GET', `/api/admin/orgs/${owner.orgId}`, undefined, adminToken);
    const t = d.tournaments.find((x: any) => x.id === tid);
    if (t.extraCameras !== 1 || t.paidMinutes !== minutes || d.balance !== w.balance) throw new Error(JSON.stringify({ t, minutes, b: d.balance }));
    if (!d.transactions.some((x: any) => x.kind === 'cameras' && x.credits === -50)) throw new Error('camera purchase missing');
    const live = await ok('GET', '/api/admin/live', undefined, adminToken);
    if (live.live.length !== 0) throw new Error('admin still shows a live broadcast');
    note(`${minutes} paid live minutes over ${t.liveMinutes} min on air · balance ${w.balance} of 100 credits`);
  });

  await step('switch log records every action with who did it', async () => {
    const log = (await ok('GET', `/api/tournaments/${tid}/switch-log`, undefined, directorToken)).entries;
    for (const a of ['preview', 'take', 'cut', 'replay', 'stream.start', 'fallback', 'stream.stop']) {
      if (!log.some((e: any) => e.action === a && e.ok)) throw new Error(`missing ${a}`);
    }
  });

  director.ws.close();
  google.close();
  void engineLog;
}

main()
  .catch(() => {})
  .finally(async () => {
    try {
      (globalThis as any).__pc?.close();
    } catch {
      /* ignore */
    }
    for (const p of procs) {
      try {
        if (p.pid) process.kill(-p.pid, 'SIGTERM');
      } catch {
        p.kill('SIGTERM');
      }
    }
    await sleep(1500);
    for (const p of procs) p.kill('SIGKILL');
    spawnSync('pkill', ['-f', 'obs --multi']);
    spawnSync('pkill', ['-f', 'Xvfb :1[1-5][0-9] ']);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
    fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify(results, null, 2));
    process.exit(failed.length ? 1 : 0);
  });
