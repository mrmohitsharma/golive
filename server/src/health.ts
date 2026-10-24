import type { Config } from './config.js';
import type { CameraHealth } from './protocol.js';

interface RawPath {
  name: string;
  ready?: boolean;
  readyTime?: string | null;
  online?: boolean;
  onlineTime?: string | null;
  available?: boolean;
  inboundBytes?: number;
  bytesReceived?: number;
  readers?: unknown[];
  tracks?: string[];
  tracks2?: { codec?: string }[];
}

export interface HealthSnapshot {
  reachable: boolean;
  error: string | null;
  paths: Map<string, CameraHealth>;
}

/**
 * Polls MediaMTX's control API for every path and turns it into per-path health:
 * whether a publisher is online, inbound bitrate measured server-side, readers.
 */
export class HealthPoller {
  private timer: NodeJS.Timeout | null = null;
  private prev = new Map<string, { bytes: number; at: number }>();
  private running = false;
  public last: HealthSnapshot = { reachable: false, error: 'not polled yet', paths: new Map() };

  constructor(
    private readonly config: Config,
    private readonly onTick: (snap: HealthSnapshot) => void,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  start(): void {
    if (this.timer) return;
    const loop = async () => {
      await this.pollOnce();
      this.timer = setTimeout(loop, this.config.HEALTH_POLL_MS);
    };
    this.timer = setTimeout(loop, 0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<HealthSnapshot> {
    if (this.running) return this.last;
    this.running = true;
    try {
      const auth = Buffer.from(`${this.config.INTERNAL_MEDIA_USER}:${this.config.INTERNAL_MEDIA_PASS}`).toString('base64');
      const res = await this.fetchImpl(`${this.config.MEDIAMTX_API_URL}/v3/paths/list?itemsPerPage=1000`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(Math.max(1000, this.config.HEALTH_POLL_MS)),
      });
      if (!res.ok) throw new Error(`MediaMTX API replied ${res.status}`);
      const body = (await res.json()) as { items?: RawPath[] };
      const now = Date.now();
      const paths = new Map<string, CameraHealth>();
      for (const p of body.items ?? []) {
        const online = Boolean(p.online ?? p.available ?? p.ready);
        const bytes = Number(p.inboundBytes ?? p.bytesReceived ?? 0);
        const prev = this.prev.get(p.name);
        let kbps = 0;
        if (prev && online && bytes >= prev.bytes && now > prev.at) {
          kbps = Math.round(((bytes - prev.bytes) * 8) / (now - prev.at)); // bytes/ms*8 = kbit/s
        }
        this.prev.set(p.name, { bytes, at: now });
        const tracks = p.tracks2?.map((t) => t.codec ?? '?') ?? p.tracks ?? [];
        paths.set(p.name, {
          online,
          onlineSince: online ? (p.onlineTime ?? p.readyTime ?? null) : null,
          inboundKbps: kbps,
          readers: p.readers?.length ?? 0,
          tracks,
        });
      }
      for (const name of [...this.prev.keys()]) if (!paths.has(name)) this.prev.delete(name);
      this.last = { reachable: true, error: null, paths };
    } catch (err) {
      this.last = { reachable: false, error: (err as Error).message, paths: new Map() };
    } finally {
      this.running = false;
    }
    try {
      this.onTick(this.last);
    } catch {
      /* listener errors must not stop polling */
    }
    return this.last;
  }
}

export function offlineHealth(): CameraHealth {
  return { online: false, onlineSince: null, inboundKbps: 0, readers: 0, tracks: [] };
}
