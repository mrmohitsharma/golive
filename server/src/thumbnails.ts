import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';

/**
 * Keeps one lightweight FFmpeg per online camera that writes a small JPEG every few
 * seconds. The Director multiview shows these, so 9+ cameras cost a few KB/s each
 * instead of a full video stream per tile. Only keyframes are decoded.
 */
export class Thumbnailer {
  private procs = new Map<string, { proc: ChildProcess; startedAt: number }>();
  private backoff = new Map<string, number>();
  private stopped = false;

  constructor(
    private readonly config: Config,
    private readonly log: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void },
  ) {
    fs.mkdirSync(config.THUMBNAIL_DIR, { recursive: true });
  }

  fileFor(streamPath: string): string {
    return path.join(this.config.THUMBNAIL_DIR, `${streamPath.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg`);
  }

  /** Reconcile running FFmpeg processes with the set of online paths. */
  sync(onlinePaths: Set<string>): void {
    if (this.stopped || !this.config.THUMBNAILS_ENABLED) return;
    for (const [p, { proc }] of this.procs) {
      if (!onlinePaths.has(p)) {
        proc.kill('SIGTERM');
        this.procs.delete(p);
      }
    }
    const now = Date.now();
    for (const p of onlinePaths) {
      if (this.procs.has(p)) continue;
      if ((this.backoff.get(p) ?? 0) > now) continue;
      this.start(p);
    }
  }

  private start(streamPath: string): void {
    const u = encodeURIComponent(this.config.INTERNAL_MEDIA_USER);
    const pw = encodeURIComponent(this.config.INTERNAL_MEDIA_PASS);
    const base = this.config.MEDIAMTX_RTSP_URL.replace('rtsp://', '');
    const input = `rtsp://${u}:${pw}@${base}/${streamPath}`;
    const out = this.fileFor(streamPath);
    const args = [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-skip_frame', 'nokey',
      '-i', input,
      '-an', '-sn',
      '-vf', `fps=1/${this.config.THUMBNAIL_INTERVAL_SEC},scale=${this.config.THUMBNAIL_WIDTH}:-2`,
      '-q:v', '6',
      '-update', '1',
      '-atomic_writing', '1',
      '-y', out,
    ];
    const proc = spawn(this.config.FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    proc.on('exit', (code) => {
      const cur = this.procs.get(streamPath);
      if (cur?.proc === proc) this.procs.delete(streamPath);
      if (!this.stopped && code !== 0 && code !== null) {
        this.backoff.set(streamPath, Date.now() + 5000);
        this.log.warn({ streamPath, code, stderr: stderr.trim().slice(-400) }, 'thumbnail ffmpeg exited');
      }
    });
    proc.on('error', (err) => {
      this.procs.delete(streamPath);
      this.backoff.set(streamPath, Date.now() + 30000);
      this.log.warn({ err: err.message }, 'could not start ffmpeg for thumbnails');
    });
    this.procs.set(streamPath, { proc, startedAt: Date.now() });
  }

  stop(): void {
    this.stopped = true;
    for (const { proc } of this.procs.values()) proc.kill('SIGTERM');
    this.procs.clear();
  }

  running(): string[] {
    return [...this.procs.keys()];
  }
}
