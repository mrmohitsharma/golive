import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Sets OBS up for Go Live on the operator's laptop, so nobody has to find
 * Tools > WebSocket Server Settings: turns OBS's remote control (obs-websocket, built into
 * OBS 28+) on with a password we generate, and reads the port and password back from OBS's own
 * settings file. OBS rewrites that file when it closes, so changes are made while OBS is closed.
 */

export interface WsSettings {
  enabled: boolean;
  port: number;
  authRequired: boolean;
  password: string;
}

const platform = process.platform;

/** OBS's settings folder for this user (Windows, Mac, Linux incl. Flatpak). */
export function obsConfigDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | null {
  const candidates =
    platform === 'win32'
      ? [path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'obs-studio')]
      : platform === 'darwin'
        ? [path.join(home, 'Library', 'Application Support', 'obs-studio')]
        : [path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'obs-studio'), path.join(home, '.var', 'app', 'com.obsproject.Studio', 'config', 'obs-studio')];
  return candidates.find((d) => fs.existsSync(d)) ?? candidates[0] ?? null;
}

export const wsConfigFile = (dir: string) => path.join(dir, 'plugin_config', 'obs-websocket', 'config.json');

export function readWsSettings(dir: string): WsSettings | null {
  try {
    const j = JSON.parse(fs.readFileSync(wsConfigFile(dir), 'utf8')) as Record<string, unknown>;
    return {
      enabled: j.server_enabled === true,
      port: Number(j.server_port) || 4455,
      authRequired: j.auth_required !== false,
      password: typeof j.server_password === 'string' ? j.server_password : '',
    };
  } catch {
    return null;
  }
}

/** Turns the WebSocket server on (OBS must be closed). Keeps an existing password; makes one otherwise. */
export function enableWs(dir: string): WsSettings {
  const file = wsConfigFile(dir);
  let j: Record<string, unknown> = {};
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* new file */
  }
  const password = typeof j.server_password === 'string' && j.server_password.length >= 6 ? j.server_password : crypto.randomBytes(12).toString('base64url');
  const next = { ...j, server_enabled: true, server_port: Number(j.server_port) || 4455, auth_required: true, server_password: password, first_load: false, alerts_enabled: j.alerts_enabled ?? false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 4));
  return { enabled: true, port: next.server_port, authRequired: true, password };
}

/**
 * V9: the scene collection OBS opens (basic/scenes/<name>.json, named in user.ini or global.ini).
 * Switches in Go Live use OBS's Fade or Slide transition; OBS has Fade built in, Slide is added
 * here once (OBS must be closed: it rewrites this file when it quits).
 */
export function sceneCollectionPath(dir: string): string | null {
  let name = 'Untitled';
  for (const ini of ['user.ini', 'global.ini']) {
    try {
      const text = fs.readFileSync(path.join(dir, ini), 'utf8');
      const basic = /^\[Basic\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] ?? '';
      const m = /^SceneCollectionFile=(.+)$/m.exec(basic);
      if (m) {
        name = m[1].trim();
        break;
      }
    } catch {
      /* no such ini */
    }
  }
  const file = path.join(dir, 'basic', 'scenes', `${name}.json`);
  return fs.existsSync(file) ? file : null;
}

export function hasSlideTransition(file: string): boolean {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { transitions?: { id?: string; name?: string }[] };
    return (j.transitions ?? []).some((t) => t.name === 'Slide');
  } catch {
    return false;
  }
}

/** Adds a "Slide" transition (from the left) to the scene collection. Keeps a .bak copy. */
export function addSlideTransition(file: string): boolean {
  const text = fs.readFileSync(file, 'utf8');
  const j = JSON.parse(text) as { transitions?: unknown[] };
  if (hasSlideTransition(file)) return false;
  fs.writeFileSync(file + '.golive.bak', text);
  j.transitions = [...(Array.isArray(j.transitions) ? j.transitions : []), { name: 'Slide', id: 'slide_transition', settings: { direction: 'left' } }];
  fs.writeFileSync(file, JSON.stringify(j, null, 4));
  return true;
}

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 10_000 }, (err, out) => resolve(err ? '' : String(out))));

export async function obsRunning(): Promise<boolean> {
  if (platform === 'win32') return /obs64\.exe|obs32\.exe/i.test(await run('tasklist', ['/FI', 'IMAGENAME eq obs64.exe', '/NH']));
  if (platform === 'darwin') return (await run('pgrep', ['-x', 'OBS'])).trim().length > 0;
  return (await run('pgrep', ['-x', 'obs'])).trim().length > 0;
}

/** Where OBS is installed, or null. */
export async function findObs(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, 'C:\\Program Files'].filter(Boolean) as string[];
    const found = [...new Set(roots)].map((r) => path.join(r, 'obs-studio', 'bin', '64bit', 'obs64.exe')).find((p) => fs.existsSync(p));
    if (found) return found;
    // Installed somewhere else (or by Steam): the installer records its folder in the registry.
    const reg = await run('reg', ['query', 'HKLM\\SOFTWARE\\OBS Studio', '/ve']);
    const m = /REG_SZ\s+(.+)/.exec(reg);
    if (m) {
      const p = path.join(m[1].trim(), 'bin', '64bit', 'obs64.exe');
      if (fs.existsSync(p)) return p;
    }
    const steam = path.join(roots[1] ?? 'C:\\Program Files (x86)', 'Steam', 'steamapps', 'common', 'OBS Studio', 'bin', '64bit', 'obs64.exe');
    return fs.existsSync(steam) ? steam : null;
  }
  if (platform === 'darwin') {
    for (const p of ['/Applications/OBS.app', path.join(os.homedir(), 'Applications', 'OBS.app')]) if (fs.existsSync(p)) return p;
    return null;
  }
  for (const p of ['/usr/bin/obs', '/usr/local/bin/obs', '/snap/bin/obs-studio']) if (fs.existsSync(p)) return p;
  return null;
}

/** Opens OBS (it must be started from its own folder on Windows to find its files). */
export function launchObs(exe: string): void {
  if (platform === 'darwin') {
    spawn('open', ['-a', exe], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn(exe, ['--disable-shutdown-check'], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

/** Asks OBS to close normally (it saves its settings), waiting up to 20 s. */
export async function closeObs(): Promise<boolean> {
  if (platform === 'win32') await run('taskkill', ['/IM', 'obs64.exe']);
  else if (platform === 'darwin') await run('osascript', ['-e', 'quit app "OBS"']);
  else await run('pkill', ['-x', 'obs']);
  for (let i = 0; i < 40; i++) {
    if (!(await obsRunning())) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export function openUrl(url: string): void {
  try {
    if (platform === 'win32') spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
    else spawn(platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* no browser: the code is on screen anyway */
  }
}

export const OBS_DOWNLOAD = 'https://obsproject.com/download';
