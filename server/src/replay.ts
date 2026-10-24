import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { engineMediaBase } from './config.js';
import type { Db } from './db.js';
import type { Sealer } from './crypto.js';
import { HttpError } from './errors.js';

export interface ClipRow {
  id: string;
  tournament_id: string;
  camera_id: string | null;
  camera_name: string;
  hole: number | null;
  title: string | null;
  start_at: Date;
  duration_sec: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  error: string | null;
  size_bytes: string | null;
  created_by: string | null;
  created_at: Date;
  ready_at: Date | null;
  /** Shown on the public watch page. */
  public: boolean;
}

export const CLIP_FILES = ['landscape.mp4', 'vertical.mp4', 'thumb.jpg'] as const;
export type ClipFile = (typeof CLIP_FILES)[number];

interface Log {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
}

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d.toString()).slice(-1500)));
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} failed (${code}): ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

/**
 * Instant replay and highlight clips, cut from MediaMTX's per-camera recording.
 * MediaMTX records every camera in 1-second fMP4 parts; its playback API returns any
 * time range as an MP4. Replays are short-lived files OBS plays from a signed URL;
 * clips are re-encoded for sharing in 16:9 and 9:16 (with a blurred background fill).
 */
export class MediaService {
  private queue: string[] = [];
  private working = false;
  readonly replayDir: string;
  readonly clipDir: string;
  private cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly sealer: Sealer,
    private readonly log: Log,
    private readonly onClip: (clip: ClipRow) => void,
  ) {
    this.replayDir = path.join(config.MEDIA_DIR, 'replays');
    this.clipDir = path.join(config.MEDIA_DIR, 'clips');
    fs.mkdirSync(this.replayDir, { recursive: true });
    fs.mkdirSync(this.clipDir, { recursive: true });
    this.cleanupTimer = setInterval(() => this.cleanupReplays(), 10 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  close() {
    clearInterval(this.cleanupTimer);
  }

  /** Downloads [start, start+duration) of a camera's recording as MP4. */
  async fetchRecording(streamPath: string, start: Date, durationSec: number, outFile: string): Promise<number> {
    const q = new URLSearchParams({ path: streamPath, start: start.toISOString(), duration: String(durationSec), format: 'mp4' });
    const auth = Buffer.from(`${this.config.INTERNAL_MEDIA_USER}:${this.config.INTERNAL_MEDIA_PASS}`).toString('base64');
    const res = await fetch(`${this.config.MEDIAMTX_PLAYBACK_URL}/get?${q}`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 404) throw new HttpError(404, 'no_recording', 'No recording for that moment yet. Is the camera live and recording?');
    if (!res.ok) throw new HttpError(502, 'recording_error', `Recording server replied ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw new HttpError(404, 'no_recording', 'The recording for that moment is empty.');
    fs.writeFileSync(outFile, buf);
    return buf.length;
  }

  /**
   * Start time "N seconds ago", allowing for MediaMTX's part flush delay. A clip may run past
   * now (e.g. 10 s back, 30 s long): rendering then waits until the recording has caught up.
   */
  startForLast(seconds: number): Date {
    return new Date(Date.now() - this.config.RECORDING_LAG_MS - seconds * 1000);
  }

  // ---------------------------------------------------------------- replay
  async makeReplay(
    streamPath: string,
    secondsBack: number,
    slowmo: boolean,
    mode: 'laptop' | 'cloud',
  ): Promise<{ url: string; durationSec: number; file: string }> {
    const id = crypto.randomUUID();
    const raw = path.join(this.replayDir, `${id}.raw.mp4`);
    const out = path.join(this.replayDir, `${id}.mp4`);
    await this.fetchRecording(streamPath, this.startForLast(secondsBack), secondsBack, raw);
    try {
      if (slowmo) {
        // Half speed; audio dropped (slowed audio sounds wrong on air).
        await run(this.config.FFMPEG_PATH, [
          '-hide_banner', '-loglevel', 'error', '-y', '-i', raw,
          '-filter:v', 'setpts=2.0*PTS', '-an',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart', out,
        ]);
      } else {
        await run(this.config.FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-c', 'copy', '-movflags', '+faststart', out]);
      }
    } finally {
      fs.rmSync(raw, { force: true });
    }
    const name = `${id}.mp4`;
    const sig = this.sealer.sign(`replays/${name}`, Math.floor(Date.now() / 1000) + 2 * 3600);
    return {
      url: `${engineMediaBase(this.config, mode)}/media/replays/${name}?sig=${encodeURIComponent(sig)}`,
      durationSec: slowmo ? secondsBack * 2 : secondsBack,
      file: out,
    };
  }

  replayFile(name: string, sig: string | undefined): string {
    if (!/^[0-9a-f-]{36}\.mp4$/.test(name) || !this.sealer.verify(`replays/${name}`, sig)) {
      throw new HttpError(403, 'bad_signature', 'This replay link is invalid or expired.');
    }
    const f = path.join(this.replayDir, name);
    if (!fs.existsSync(f)) throw new HttpError(404, 'not_found', 'Replay not found.');
    return f;
  }

  private cleanupReplays() {
    const cutoff = Date.now() - 3 * 3600 * 1000;
    for (const f of fs.readdirSync(this.replayDir)) {
      const p = path.join(this.replayDir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  // ---------------------------------------------------------------- clips
  async createClip(input: {
    tournamentId: string;
    cameraId: string;
    cameraName: string;
    hole: number | null;
    streamPath: string;
    secondsBack: number;
    durationSec: number;
    title: string | null;
    createdBy: string;
    subtitle: string;
  }): Promise<ClipRow> {
    const start = this.startForLast(input.secondsBack);
    const row = (
      await this.db.query<ClipRow>(
        `INSERT INTO clips (tournament_id, camera_id, camera_name, hole, title, start_at, duration_sec, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [input.tournamentId, input.cameraId, input.cameraName, input.hole, input.title, start, input.durationSec, input.createdBy],
      )
    ).rows[0];
    this.jobs.set(row.id, { streamPath: input.streamPath, subtitle: input.subtitle });
    this.queue.push(row.id);
    void this.work();
    return row;
  }

  private jobs = new Map<string, { streamPath: string; subtitle: string }>();

  private async setStatus(id: string, status: ClipRow['status'], extra: { error?: string; size?: number } = {}): Promise<ClipRow> {
    const row = (
      await this.db.query<ClipRow>(
        `UPDATE clips SET status = $2, error = $3, size_bytes = COALESCE($4, size_bytes),
           ready_at = CASE WHEN $2 = 'ready' THEN now() ELSE ready_at END
         WHERE id = $1 RETURNING *`,
        [id, status, extra.error ?? null, extra.size ?? null],
      )
    ).rows[0];
    if (row) this.onClip(row);
    return row;
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        const job = this.jobs.get(id);
        this.jobs.delete(id);
        const clip = (await this.db.query<ClipRow>('SELECT * FROM clips WHERE id = $1', [id])).rows[0];
        if (!clip || !job) continue;
        await this.setStatus(id, 'processing');
        try {
          const size = await this.render(clip, job.streamPath, job.subtitle);
          await this.setStatus(id, 'ready', { size });
          this.log.info({ clip: id }, 'clip ready');
        } catch (err) {
          this.log.warn({ clip: id, err: (err as Error).message }, 'clip failed');
          await this.setStatus(id, 'failed', { error: (err as Error).message.slice(0, 300) });
        }
      }
    } finally {
      this.working = false;
    }
  }

  /** Waits until the recording covers the clip's end, then renders the three files. */
  private async render(clip: ClipRow, streamPath: string, subtitle: string): Promise<number> {
    const end = clip.start_at.getTime() + Number(clip.duration_sec) * 1000 + this.config.RECORDING_LAG_MS;
    if (end > Date.now()) await new Promise((r) => setTimeout(r, end - Date.now()));
    const dir = path.join(this.clipDir, clip.id);
    fs.mkdirSync(dir, { recursive: true });
    const raw = path.join(dir, 'raw.mp4');
    await this.fetchRecording(streamPath, clip.start_at, Number(clip.duration_sec), raw);

    const font = fs.existsSync(this.config.CLIP_FONT) ? this.config.CLIP_FONT : null;
    const titleFile = path.join(dir, 'title.txt');
    const subFile = path.join(dir, 'subtitle.txt');
    fs.writeFileSync(titleFile, (clip.title || clip.camera_name).slice(0, 40));
    fs.writeFileSync(subFile, subtitle.slice(0, 60));
    const esc = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const text = (file: string, size: number, y: string) =>
      font
        ? `drawtext=fontfile='${esc(font)}':textfile='${esc(file)}':fontsize=${size}:fontcolor=white:x=(w-text_w)/2:y=${y}:box=1:boxcolor=0x1D3B2A@0.82:boxborderw=22`
        : 'null';

    // 16:9, up to 1080p, title strip at the bottom.
    await run(this.config.FFMPEG_PATH, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', raw,
      '-vf', `scale='min(1920,iw)':-2,${font && clip.title ? text(titleFile, 44, 'h-th-60') : 'null'}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', path.join(dir, 'landscape.mp4'),
    ], 300_000);

    // 9:16 1080x1920 for Reels/Shorts: full frame in the middle over a blurred, darkened fill.
    const vf = [
      '[0:v]split=2[bg][fg]',
      '[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2,eq=brightness=-0.18[bgb]',
      '[fg]scale=1080:-2[fgs]',
      '[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1' + (font ? `,${text(titleFile, 68, 'h*0.16')},${text(subFile, 40, 'h*0.80')}` : '') + '[v]',
    ].join(';');
    await run(this.config.FFMPEG_PATH, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', raw,
      '-filter_complex', vf, '-map', '[v]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', path.join(dir, 'vertical.mp4'),
    ], 300_000);

    await run(this.config.FFMPEG_PATH, [
      '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.min(1, Number(clip.duration_sec) / 2)), '-i', raw,
      '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', path.join(dir, 'thumb.jpg'),
    ]);
    fs.rmSync(raw, { force: true });
    fs.rmSync(titleFile, { force: true });
    fs.rmSync(subFile, { force: true });
    return CLIP_FILES.reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0);
  }

  clipFile(clipId: string, file: string): string {
    if (!(CLIP_FILES as readonly string[]).includes(file)) throw new HttpError(404, 'not_found', 'Unknown clip file.');
    const p = path.join(this.clipDir, clipId, file);
    if (!fs.existsSync(p)) throw new HttpError(404, 'not_found', 'Clip file not ready.');
    return p;
  }

  shareLinks(clipId: string, days = 7) {
    const exp = Math.floor(Date.now() / 1000) + days * 86400;
    const base = this.config.PUBLIC_BASE_URL.replace(/\/$/, '');
    const link = (f: ClipFile) => `${base}/api/clips/${clipId}/${f}?sig=${encodeURIComponent(this.sealer.sign(`clips/${clipId}/${f}`, exp))}`;
    return { landscapeUrl: link('landscape.mp4'), verticalUrl: link('vertical.mp4'), thumbUrl: link('thumb.jpg'), expiresAt: new Date(exp * 1000).toISOString() };
  }

  verifyShare(clipId: string, file: string, sig: string | undefined): boolean {
    return this.sealer.verify(`clips/${clipId}/${file}`, sig);
  }

  async listClips(tournamentId: string): Promise<ClipRow[]> {
    return (await this.db.query<ClipRow>('SELECT * FROM clips WHERE tournament_id = $1 ORDER BY created_at DESC LIMIT 200', [tournamentId])).rows;
  }

  /** Ready clips a director has not hidden, newest first (public watch page). */
  async publicClips(tournamentId: string, limit = 12): Promise<ClipRow[]> {
    return (
      await this.db.query<ClipRow>(
        `SELECT * FROM clips WHERE tournament_id = $1 AND status = 'ready' AND public ORDER BY created_at DESC LIMIT $2`,
        [tournamentId, limit],
      )
    ).rows;
  }

  async setClipPublic(id: string, isPublic: boolean): Promise<ClipRow | null> {
    return (await this.db.query<ClipRow>('UPDATE clips SET public = $2 WHERE id = $1 RETURNING *', [id, isPublic])).rows[0] ?? null;
  }

  async clip(id: string): Promise<ClipRow | null> {
    return (await this.db.query<ClipRow>('SELECT * FROM clips WHERE id = $1', [id])).rows[0] ?? null;
  }

  async deleteClip(id: string): Promise<void> {
    await this.db.query('DELETE FROM clips WHERE id = $1', [id]);
    fs.rmSync(path.join(this.clipDir, id), { recursive: true, force: true });
  }
}

export function clipDto(c: ClipRow) {
  return {
    id: c.id,
    tournamentId: c.tournament_id,
    cameraId: c.camera_id,
    cameraName: c.camera_name,
    hole: c.hole,
    title: c.title,
    startAt: c.start_at,
    durationSec: Number(c.duration_sec),
    status: c.status,
    error: c.error,
    sizeBytes: c.size_bytes ? Number(c.size_bytes) : null,
    createdAt: c.created_at,
    readyAt: c.ready_at,
    public: c.public !== false,
    files:
      c.status === 'ready'
        ? { landscape: `/api/clips/${c.id}/landscape.mp4`, vertical: `/api/clips/${c.id}/vertical.mp4`, thumb: `/api/clips/${c.id}/thumb.jpg` }
        : null,
  };
}
