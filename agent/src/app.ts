import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { AgentConfig } from './config.js';
import { closeObs, enableWs, findObs, launchObs, OBS_DOWNLOAD, obsConfigDir, obsRunning, openUrl, readWsSettings } from './obs-setup.js';

/**
 * The Go Live agent app (Windows / Mac): double-click, and it
 *  1. finds OBS and turns its remote control on (asks once), opening OBS for you;
 *  2. shows a 6-digit code to type on the event page (first time only);
 *  3. runs whichever event the club picks for this laptop, switching on its own.
 * No .env, no passwords, no commands.
 */

export const AGENT_VERSION = '1.0.0';
const DEFAULT_SERVER = process.env.GOLIVE_DEFAULT_SERVER || 'https://gogetslive.com';

interface Saved {
  serverUrl: string;
  laptopId?: string;
  laptopToken?: string;
  obsConsent?: boolean;
}

const c = {
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  d: (s: string) => `\x1b[2m${s}\x1b[0m`,
};
const say = (s = '') => console.log(s);
const ok = (s: string) => say(`  ${c.g('✓')} ${s}`);
const warn = (s: string) => say(`  ${c.y('!')} ${s}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function appDataDir(): string {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'GoLive');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'GoLive');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'golive');
}
const savedFile = () => path.join(appDataDir(), 'agent.json');

function load(): Saved {
  try {
    return JSON.parse(fs.readFileSync(savedFile(), 'utf8')) as Saved;
  } catch {
    return { serverUrl: DEFAULT_SERVER };
  }
}
function save(s: Saved): void {
  fs.mkdirSync(appDataDir(), { recursive: true });
  fs.writeFileSync(savedFile(), JSON.stringify(s, null, 2), { mode: 0o600 });
}

function ask(question: string, defYes = true): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(defYes);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(`  ${question} ${c.d(defYes ? '[Y/n]' : '[y/N]')} `, (a) => {
      rl.close();
      const t = a.trim().toLowerCase();
      resolve(t ? t.startsWith('y') : defYes);
    }),
  );
}
function pressEnter(question: string): Promise<void> {
  if (!process.stdin.isTTY) return sleep(5000);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<void>((resolve) =>
    rl.question(`  ${question} `, () => {
      rl.close();
      resolve();
    }),
  );
}

async function post<T>(server: string, url: string, body: unknown): Promise<{ status: number; body: T & { error?: { code?: string; message?: string } } }> {
  const res = await fetch(server + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T & { error?: { code?: string; message?: string } } };
}

const osName = () => (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux');
const laptopName = () => os.hostname().replace(/\.local$/, '').slice(0, 60) || 'Laptop';

// ------------------------------------------------------------------ 1. OBS
/** Makes sure OBS is installed, its remote control is on, and it is open. Returns how to reach it. */
export async function prepareObs(saved: Saved): Promise<{ url: string; password?: string }> {
  say(c.b('Step 1 of 3 · OBS Studio'));
  let exe = await findObs();
  while (!exe) {
    warn('OBS Studio is not installed on this computer. Opening the download page…');
    openUrl(OBS_DOWNLOAD);
    await pressEnter('Install OBS Studio (free), then press Enter here.');
    exe = await findObs();
  }
  ok('OBS Studio found');
  const dir = obsConfigDir();
  if (!dir) throw new Error('Could not find the OBS settings folder.');
  let ws = readWsSettings(dir);
  const usable = ws && ws.enabled && (!ws.authRequired || ws.password);
  if (!usable) {
    if (!saved.obsConsent) {
      say();
      say('  Go Live needs to switch on OBS remote control, and sets OBS to 1920x1080 at 30 fps');
      say('  with Simple output (what Go Live streams best). Your own scenes are not touched.');
      if (!(await ask('Set OBS up for Go Live now?'))) {
        say('  OK. Turn it on yourself in OBS: Tools > WebSocket Server Settings > Enable, then start this app again.');
        await pressEnter('Press Enter to close.');
        process.exit(0);
      }
      saved.obsConsent = true;
      save(saved);
    }
    if (await obsRunning()) {
      say('  Closing OBS for a moment to change its settings…');
      if (!(await closeObs())) {
        warn('OBS did not close. Close OBS yourself (File > Exit).');
        await pressEnter('Then press Enter here.');
        while (await obsRunning()) await sleep(1000);
      }
    }
    ws = enableWs(dir);
    ok('OBS remote control switched on');
  } else ok('OBS remote control is on');
  if (!(await obsRunning())) {
    say('  Opening OBS…');
    launchObs(exe);
  }
  return { url: `ws://127.0.0.1:${ws!.port}`, password: ws!.authRequired ? ws!.password : undefined };
}

// ------------------------------------------------------------------ 2. pairing
async function pair(saved: Saved): Promise<void> {
  say();
  say(c.b('Step 2 of 3 · Link this laptop to your club'));
  let opened = false;
  for (;;) {
    let r: Awaited<ReturnType<typeof post<{ pairId: string; code: string; secret: string; expiresAt: string; pairUrl: string }>>>;
    try {
      r = await post(saved.serverUrl, '/api/agent/pair', { name: laptopName(), os: osName(), version: AGENT_VERSION });
    } catch {
      warn(`Cannot reach ${saved.serverUrl}. Check this laptop's internet connection. Trying again…`);
      await sleep(5000);
      continue;
    }
    if (r.status !== 200) {
      warn(r.body.error?.message ?? `${saved.serverUrl} answered ${r.status}. Trying again…`);
      await sleep(10_000);
      continue;
    }
    const code = `${r.body.code.slice(0, 3)} ${r.body.code.slice(3)}`;
    say();
    say('  On the Go Live website, open your event > Laptop OBS, and type this code:');
    say();
    say(`        ${c.b(c.g(code))}`);
    say();
    say(c.d(`  (or open ${r.body.pairUrl})  The code changes every 10 minutes.`));
    if (!opened) {
      openUrl(r.body.pairUrl);
      opened = true;
    }
    const until = new Date(r.body.expiresAt).getTime();
    while (Date.now() < until) {
      await sleep(2000);
      const res = await fetch(`${saved.serverUrl}/api/agent/pair/${r.body.pairId}`, { headers: { 'x-pair-secret': r.body.secret } }).catch(() => null);
      const b = res ? ((await res.json().catch(() => ({}))) as { status?: string; laptopId?: string; laptopToken?: string }) : {};
      if (b.status === 'paired' && b.laptopId && b.laptopToken) {
        saved.laptopId = b.laptopId;
        saved.laptopToken = b.laptopToken;
        save(saved);
        ok('Laptop linked to your club');
        return;
      }
      if (b.status === 'expired' || res?.status === 404) break;
    }
    say(c.d('  Code expired, here is a new one.'));
  }
}

// ------------------------------------------------------------------ 3. run events
export interface Session {
  laptop: { id: string; name: string };
  club: string | null;
  event: { id: string; name: string; mode: string } | null;
  engineToken: string | null;
}

export interface AppAgent {
  linkServer(): void;
  unlinkServer(): void;
  onReassigned: (() => void) | null;
}

export async function runApp(start: (cfg: AgentConfig) => AppAgent): Promise<void> {
  process.title = 'Go Live agent';
  say();
  say(c.b('  GO LIVE · laptop agent ') + c.d(`v${AGENT_VERSION}`));
  say(c.d('  Keep this window open during your show. Close it to stop.'));
  say();
  const saved = load();
  if (process.env.SERVER_URL) saved.serverUrl = process.env.SERVER_URL.replace(/\/$/, '');
  if (!saved.serverUrl) saved.serverUrl = DEFAULT_SERVER;
  if (process.argv.includes('--pair')) {
    delete saved.laptopId;
    delete saved.laptopToken;
  }
  const obs = await prepareObs(saved);
  if (!saved.laptopId || !saved.laptopToken) await pair(saved);
  else {
    say();
    say(c.b('Step 2 of 3 · Link this laptop to your club'));
    ok('Already linked');
  }

  let session: Session | null = null;
  const getSession = async (): Promise<Session> => {
    const r = await post<Session>(saved.serverUrl, '/api/agent/session', { laptopId: saved.laptopId, laptopToken: saved.laptopToken, version: AGENT_VERSION, os: osName() });
    if (r.status === 401) {
      const e = new Error(r.body.error?.message ?? 'This laptop is not paired.') as Error & { unpaired?: boolean };
      e.unpaired = true;
      throw e;
    }
    if (r.status !== 200) throw new Error(r.body.error?.message ?? `server answered ${r.status}`);
    return r.body;
  };

  const config: AgentConfig = {
    serverUrl: saved.serverUrl,
    tournamentId: '',
    engineKey: '',
    obsUrl: obs.url,
    obsPassword: obs.password,
    youtubeServer: 'rtmps://a.rtmps.youtube.com:443/live2',
    fallbackText: "We'll be right back",
    stateIntervalMs: 2000,
    laptopDefaults: Boolean(saved.obsConsent),
    tokenSource: async () => {
      session = await getSession();
      if (!session.engineToken) throw new Error('this laptop has no event yet');
      return session.engineToken;
    },
  };
  say();
  say(c.b('Step 3 of 3 · Your event'));
  const agent = start(config);

  let current: string | null | undefined; // undefined = not checked yet
  const check = async () => {
    try {
      const s = await getSession();
      session = s;
      const id = s.event?.id ?? null;
      if (id === current) return;
      current = id;
      if (s.event) {
        ok(`Running ${c.b(s.event.name)}${s.club ? ` for ${s.club}` : ''}${s.event.mode === 'cloud' ? c.y(' (the event is set to Cloud OBS: switch it to Laptop OBS in its Settings)') : ''}`);
        agent.linkServer();
      } else {
        warn(`Linked to ${s.club ?? 'your club'}. On the website, open an event > Laptop OBS and pick "${s.laptop.name}".`);
        agent.unlinkServer();
      }
    } catch (err) {
      const e = err as Error & { unpaired?: boolean };
      if (e.unpaired) {
        warn(e.message);
        delete saved.laptopId;
        delete saved.laptopToken;
        save(saved);
        agent.unlinkServer();
        current = undefined;
        await pair(saved);
        return;
      }
      if (current !== undefined) warn(`cannot reach ${saved.serverUrl}: ${e.message}. Retrying…`);
    }
  };
  agent.onReassigned = () => void check();
  await check();
  for (;;) {
    await sleep(10_000);
    await check();
  }
}
