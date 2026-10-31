import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';

export type Platform = 'youtube' | 'facebook' | 'instagram';
export const PLATFORMS: Platform[] = ['youtube', 'facebook', 'instagram'];

export type RelayState = 'connecting' | 'live' | 'retrying';

export interface RelayTarget {
  /** 'youtube' | 'facebook' | 'instagram' for the main platforms, 'd:<uuid>' for extra destinations. */
  id: string;
  /** For logs: the platform name or 'other'. */
  platform: string;
  /** Full RTMP(S) URL including the stream key. */
  url: string;
  /** Re-encode to 720x1280 (Instagram); otherwise the programme is copied untouched. */
  vertical: boolean;
  /** Our watch player: HLS files in several qualities under `dir`, a new session folder per start. */
  hls?: HlsSpec;
}

export interface HlsSpec {
  dir: string;
  renditions: { height: number; kbps: number }[];
  preset: string;
  segmentSec: number;
}

export interface RelayHooks {
  /** An HLS session folder was created and FFmpeg started writing to it. */
  hlsStart?: (tournamentId: string, dir: string, session: string) => void;
  /** That FFmpeg stopped (for good or before a retry): the session can be closed. */
  hlsEnd?: (tournamentId: string, dir: string, session: string) => void;
}

export interface RelayStatus {
  id: string;
  platform: string;
  state: RelayState;
  since: string;
  restarts: number;
  error: string | null;
}

type SpawnFn = (cmd: string, args: string[]) => ChildProcess;

interface Running {
  target: RelayTarget;
  proc: ChildProcess | null;
  status: RelayStatus;
  timer: NodeJS.Timeout | null;
  lastOutUs: number;
  wanted: boolean;
  stderr: string;
  session: string | null;
}

/**
 * Forwards a tournament's programme (read from MediaMTX) to each platform with its own
 * FFmpeg process, so one platform failing or reconnecting never affects the others.
 * YouTube and Facebook get the programme copied (no quality loss, almost no CPU);
 * Instagram gets a 9:16 version: the full picture centred on a blurred, darkened fill.
 */
export class RelayManager {
  private byTournament = new Map<string, Map<string, Running>>();
  hooks: RelayHooks = {};

  constructor(
    private readonly config: Config,
    private readonly log: FastifyBaseLogger,
    private readonly onChange: (tournamentId: string) => void,
    private readonly spawn: SpawnFn = (cmd, args) => nodeSpawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
  ) {}

  static args(config: Config, input: string, t: RelayTarget): string[] {
    const head = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-rtsp_transport', 'tcp', '-i', input];
    const tail = ['-f', 'flv', '-flvflags', 'no_duration_filesize', t.url];
    if (!t.vertical) return [...head, '-map', '0:v', '-map', '0:a?', '-c', 'copy', ...tail];
    const k = config.INSTAGRAM_VIDEO_KBPS;
    const vf = [
      '[0:v]split=2[bg][fg]',
      // Blur at 1/4 size then scale up: same look, a fraction of the CPU.
      '[bg]scale=180:320:force_original_aspect_ratio=increase,crop=180:320,boxblur=8:2,scale=720:1280,eq=brightness=-0.15[bgb]',
      '[fg]scale=720:-2[fgs]',
      '[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30[v]',
    ].join(';');
    return [
      ...head,
      '-filter_complex', vf, '-map', '[v]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
      '-b:v', `${k}k`, '-maxrate', `${k}k`, '-bufsize', `${k * 2}k`, '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
      ...tail,
    ];
  }

  /** HLS for our watch player: every rendition encoded with keyframes on segment boundaries. */
  static hlsArgs(input: string, spec: HlsSpec, out: string): string[] {
    const n = spec.renditions.length;
    const split = `[0:v]split=${n}${spec.renditions.map((_, i) => `[s${i}]`).join('')}`;
    const scales = spec.renditions.map((r, i) => `[s${i}]scale=-2:${r.height},setsar=1[o${i}]`);
    const maps = spec.renditions.flatMap((_, i) => ['-map', `[o${i}]`, '-map', '0:a:0']);
    const rates = spec.renditions.flatMap((r, i) => [
      `-b:v:${i}`, `${r.kbps}k`, `-maxrate:v:${i}`, `${Math.round(r.kbps * 1.07)}k`, `-bufsize:v:${i}`, `${Math.round(r.kbps * 1.5)}k`,
      `-b:a:${i}`, r.height >= 720 ? '128k' : '96k',
    ]);
    const seg = spec.segmentSec;
    return [
      '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-rtsp_transport', 'tcp', '-i', input,
      '-filter_complex', [split, ...scales].join(';'),
      ...maps,
      '-c:v', 'libx264', '-preset', spec.preset, '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-r', '30',
      '-force_key_frames', `expr:gte(t,n_forced*${seg})`, '-sc_threshold', '0',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      ...rates,
      '-f', 'hls', '-hls_time', String(seg), '-hls_list_size', '8',
      '-hls_flags', 'independent_segments+temp_file',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(out, 'v%v', 's%05d.ts'),
      '-master_pl_name', 'master.m3u8',
      '-var_stream_map', spec.renditions.map((r, i) => `v:${i},a:${i},name:${r.height}p`).join(' '),
      path.join(out, 'v%v', 'live.m3u8'),
    ];
  }

  /** Makes the running relays for a tournament match `targets` (start new, stop removed, restart changed). */
  setTargets(tournamentId: string, input: string, targets: RelayTarget[]): void {
    const map = this.byTournament.get(tournamentId) ?? new Map<string, Running>();
    this.byTournament.set(tournamentId, map);
    for (const [id, r] of map) {
      const next = targets.find((t) => t.id === id);
      if (!next || next.url !== r.target.url || next.vertical !== r.target.vertical) {
        this.kill(r, tournamentId);
        map.delete(id);
      }
    }
    for (const t of targets) {
      if (map.has(t.id)) continue;
      const r: Running = {
        target: t,
        proc: null,
        status: { id: t.id, platform: t.platform, state: 'connecting', since: new Date().toISOString(), restarts: 0, error: null },
        timer: null,
        lastOutUs: 0,
        wanted: true,
        stderr: '',
        session: null,
      };
      map.set(t.id, r);
      this.run(tournamentId, input, r);
    }
    if (!map.size) this.byTournament.delete(tournamentId);
    this.onChange(tournamentId);
  }

  stop(tournamentId: string): void {
    const map = this.byTournament.get(tournamentId);
    if (!map) return;
    for (const r of map.values()) this.kill(r, tournamentId);
    this.byTournament.delete(tournamentId);
    this.onChange(tournamentId);
  }

  stopAll(): void {
    for (const tid of [...this.byTournament.keys()]) this.stop(tid);
  }

  status(tournamentId: string): RelayStatus[] {
    return [...(this.byTournament.get(tournamentId)?.values() ?? [])].map((r) => ({ ...r.status }));
  }

  isRunning(tournamentId: string): boolean {
    return this.byTournament.has(tournamentId);
  }

  private set(tournamentId: string, r: Running, state: RelayState, error: string | null = r.status.error): void {
    if (r.status.state === state && r.status.error === error) return;
    r.status = { ...r.status, state, error, since: r.status.state === state ? r.status.since : new Date().toISOString() };
    this.onChange(tournamentId);
  }

  private run(tournamentId: string, input: string, r: Running): void {
    if (!r.wanted) return;
    r.lastOutUs = 0;
    r.stderr = '';
    let args: string[];
    const hls = r.target.hls;
    if (hls) {
      // A fresh folder each start: segment names restart at 0, and a CDN keeps old ones cached.
      const session = 's' + Date.now().toString(36);
      const out = path.join(hls.dir, session);
      for (const x of hls.renditions) fs.mkdirSync(path.join(out, `v${x.height}p`), { recursive: true });
      r.session = session;
      args = RelayManager.hlsArgs(input, hls, out);
      try {
        this.hooks.hlsStart?.(tournamentId, hls.dir, session);
      } catch {}
    } else args = RelayManager.args(this.config, input, r.target);
    const proc = this.spawn(this.config.FFMPEG_PATH, args);
    r.proc = proc;
    let buf = '';
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) {
          const us = Number(m[1]);
          // Media time moving forward = frames are reaching the platform.
          if (us > r.lastOutUs && us > 500_000) this.set(tournamentId, r, 'live', null);
          r.lastOutUs = Math.max(r.lastOutUs, us);
        }
      }
    });
    proc.stderr?.on('data', (d: Buffer) => {
      r.stderr = (r.stderr + d.toString()).slice(-2000);
    });
    proc.on('error', (err) => {
      r.stderr = err.message;
    });
    proc.on('exit', (code) => {
      if (r.proc !== proc) return;
      r.proc = null;
      this.endSession(tournamentId, r);
      if (!r.wanted) return;
      const wasLive = r.status.state === 'live';
      if (wasLive) r.status.restarts = 0;
      r.status.restarts++;
      const err = lastLine(r.stderr) ?? `stopped (exit ${code ?? 'signal'})`;
      this.log.warn({ tournamentId, destination: r.target.id, platform: r.target.platform, err }, 'relay stopped, retrying');
      this.set(tournamentId, r, 'retrying', friendly(err));
      const delay = Math.min(this.config.RELAY_RETRY_MAX_SEC, 2 ** Math.min(r.status.restarts, 5)) * 1000;
      r.timer = setTimeout(() => {
        r.timer = null;
        this.run(tournamentId, input, r);
      }, delay);
    });
  }

  private endSession(tournamentId: string, r: Running): void {
    if (!r.session || !r.target.hls) return;
    const s = r.session;
    r.session = null;
    try {
      this.hooks.hlsEnd?.(tournamentId, r.target.hls.dir, s);
    } catch {}
  }

  private kill(r: Running, tournamentId?: string): void {
    r.wanted = false;
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    const p = r.proc;
    r.proc = null;
    const end = () => tournamentId && this.endSession(tournamentId, r);
    if (p && p.exitCode === null) {
      // The HLS session is closed once FFmpeg has written its last segment.
      if (r.session) p.once('exit', end);
      p.kill('SIGTERM');
      setTimeout(() => p.exitCode === null && p.kill('SIGKILL'), 3000).unref();
    } else end();
  }
}

function lastLine(s: string): string | null {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? null;
}

/** FFmpeg's words, made readable for a director. Stream keys never appear in them. */
function friendly(err: string): string {
  const e = err.replace(/rtmps?:\/\/\S+/g, '<platform>');
  if (/404|not found|DESCRIBE/i.test(e)) return 'Waiting for the programme from OBS';
  if (/Connection refused|timed out|Network is unreachable|Input\/output error/i.test(e)) return 'Cannot reach the platform; retrying';
  if (/Broken pipe|Connection reset|End of file/i.test(e)) return 'The platform closed the connection (check the stream key / broadcast); retrying';
  return e.slice(0, 200);
}
