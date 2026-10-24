import fs from 'node:fs';
import path from 'node:path';

export interface AgentConfig {
  serverUrl: string;
  tournamentId: string;
  /** Per-tournament engine key (Director app > Tournament > Engine setup). */
  engineKey: string;
  obsUrl: string;
  obsPassword?: string;
  /** Optional: stream to YouTube with this key when the organisation has not connected YouTube in the app. */
  youtubeStreamKey?: string;
  youtubeServer: string;
  fallbackText: string;
  stateIntervalMs: number;
}

/** Minimal .env reader so the agent runs with `node dist/index.js` and a .env next to it. */
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`Missing ${k}. Copy the .env from the Director app (Tournament > Engine setup).`);
    return v;
  };
  return {
    serverUrl: need('SERVER_URL').replace(/\/$/, ''),
    tournamentId: need('TOURNAMENT_ID'),
    engineKey: need('ENGINE_KEY'),
    obsUrl: env.OBS_URL || 'ws://127.0.0.1:4455',
    obsPassword: env.OBS_PASSWORD || undefined,
    youtubeStreamKey: env.YOUTUBE_STREAM_KEY || undefined,
    youtubeServer: env.YOUTUBE_SERVER || 'rtmps://a.rtmps.youtube.com:443/live2',
    fallbackText: env.FALLBACK_TEXT || "We'll be right back",
    stateIntervalMs: Number(env.STATE_INTERVAL_MS || 2000),
  };
}
