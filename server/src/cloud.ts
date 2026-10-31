import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Config } from './config.js';
import { randomSecret } from './crypto.js';
import { HttpError } from './errors.js';
import type { CloudEngineStatus, ProductionState } from './protocol.js';
import type { Repo, TournamentRow } from './repo.js';

/** What a cloud engine needs to start: it is the same OBS agent as on a laptop, plus OBS. */
export interface EngineSpec {
  tournamentId: string;
  name: string;
  env: Record<string, string>;
}

export interface CloudDriver {
  readonly name: string;
  start(spec: EngineSpec): Promise<string>;
  stop(handle: string): Promise<void>;
  isRunning(handle: string): Promise<boolean>;
}

interface Log {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
}

// ---------------------------------------------------------------- Docker (production)

/**
 * Runs the cloud engine image (infra/cloud-engine) on the Docker host the server runs on,
 * through the Docker Engine API on its unix socket. One container per live tournament,
 * removed when stopped.
 */
export class DockerDriver implements CloudDriver {
  readonly name = 'docker';
  constructor(private readonly config: Config) {}

  private request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          socketPath: this.config.DOCKER_SOCKET,
          path: `/v1.43${path}`,
          method,
          headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
          timeout: 30_000,
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            let parsed: unknown = raw;
            try {
              parsed = raw ? JSON.parse(raw) : null;
            } catch {
              /* plain text */
            }
            resolve({ status: res.statusCode ?? 0, body: parsed as T });
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('Docker API timeout')));
      if (data) req.write(data);
      req.end();
    });
  }

  async start(spec: EngineSpec): Promise<string> {
    const name = `cg-engine-${spec.tournamentId.slice(0, 8)}`;
    // A leftover container with the same name (crash, restart) is replaced.
    await this.request('DELETE', `/containers/${name}?force=true`).catch(() => {});
    const create = await this.request<{ Id?: string; message?: string }>('POST', `/containers/create?name=${name}`, {
      Image: this.config.CLOUD_ENGINE_IMAGE,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: { 'cogolfer.tournament': spec.tournamentId },
      HostConfig: {
        AutoRemove: true,
        NetworkMode: this.config.CLOUD_ENGINE_NETWORK,
        NanoCpus: Math.round(this.config.CLOUD_ENGINE_CPUS * 1e9),
        Memory: this.config.CLOUD_ENGINE_MEMORY_MB * 1024 * 1024,
        ShmSize: 512 * 1024 * 1024,
      },
    });
    if (create.status !== 201 || !create.body.Id) {
      throw new Error(`Docker could not create the engine: ${create.body.message ?? create.status}`);
    }
    const started = await this.request<{ message?: string }>('POST', `/containers/${create.body.Id}/start`);
    if (started.status !== 204 && started.status !== 304) {
      throw new Error(`Docker could not start the engine: ${started.body?.message ?? started.status}`);
    }
    return create.body.Id;
  }

  async stop(handle: string): Promise<void> {
    await this.request('POST', `/containers/${handle}/stop?t=10`).catch(() => {});
  }

  async isRunning(handle: string): Promise<boolean> {
    const r = await this.request<{ State?: { Running?: boolean } }>('GET', `/containers/${handle}/json`).catch(() => null);
    return Boolean(r && r.status === 200 && r.body.State?.Running);
  }
}

// ---------------------------------------------------------------- local process (dev / tests)

/** Runs the same entrypoint as the container, as a local process (OBS + Xvfb + agent on this machine). */
export class ProcessDriver implements CloudDriver {
  readonly name = 'process';
  private procs = new Map<string, ChildProcess>();
  private slot = 0;
  constructor(private readonly config: Config, private readonly log: Log) {}

  async start(spec: EngineSpec): Promise<string> {
    if (!this.config.CLOUD_ENGINE_PROCESS_CMD) throw new Error('CLOUD_ENGINE_PROCESS_CMD is not set');
    // Several engines on one machine: each gets its own X display, OBS port and OBS profile.
    const slot = this.slot++ % 50;
    const home = path.join(os.tmpdir(), `cg-engine-${spec.tournamentId.slice(0, 8)}`);
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home, { recursive: true });
    const p = spawn('/bin/bash', ['-c', `exec ${this.config.CLOUD_ENGINE_PROCESS_CMD}`], {
      env: { ...process.env, ...spec.env, DISPLAY_NUM: String(110 + slot), OBS_PORT: String(4460 + slot), ENGINE_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const handle = String(p.pid);
    this.procs.set(handle, p);
    const tag = `engine ${spec.tournamentId.slice(0, 8)}`;
    p.stdout?.on('data', (d) => this.log.info({ engine: tag }, d.toString().trim().slice(0, 400)));
    p.stderr?.on('data', (d) => this.log.info({ engine: tag }, d.toString().trim().slice(0, 400)));
    p.on('exit', (code) => {
      this.procs.delete(handle);
      this.log.info({ engine: tag, code }, 'cloud engine process exited');
    });
    return handle;
  }

  async stop(handle: string): Promise<void> {
    const p = this.procs.get(handle);
    const pid = Number(handle);
    try {
      process.kill(-pid, 'SIGTERM'); // whole process group: Xvfb, OBS, agent
    } catch {
      p?.kill('SIGTERM');
    }
    await new Promise((r) => setTimeout(r, 1500));
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }

  async isRunning(handle: string): Promise<boolean> {
    return this.procs.has(handle);
  }
}

// ---------------------------------------------------------------- manager

interface CloudRecord {
  id?: string;
  driver?: string;
  status?: CloudEngineStatus;
  startedAt?: string | null;
  error?: string | null;
}

/**
 * Cloud production mode: OBS runs on the server instead of a venue laptop. Started per
 * event from the Director app, stopped by the director, after a period with nothing live,
 * or at a hard cap, so the bill only covers event hours.
 */
export class CloudEngineManager {
  private idleSince = new Map<string, number>();
  private warned = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  /** Set by the app: tell directors, and pause the cameras when Cloud OBS stops on its own. */
  events: {
    alert?: (tournamentId: string, level: 'info' | 'warning' | 'error', message: string) => void;
    stopped?: (tournamentId: string, reason: string) => void;
    started?: (tournamentId: string) => void;
  } = {};

  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
    private readonly driver: CloudDriver | null,
    private readonly log: Log,
    private readonly onChange: (tournamentId: string, state: ProductionState) => void,
    /** Is anything live (OBS streaming or a camera online)? Used for the idle auto-stop. */
    private readonly isBusy: (tournamentId: string) => boolean,
  ) {}

  get available(): boolean {
    return this.driver !== null;
  }

  start(): void {
    if (this.timer || !this.driver) return;
    // Every 10 s, so a 2-minute idle stop with a 1-minute warning is on time.
    this.timer = setInterval(() => void this.watchdog(), 10_000);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }

  state(t: TournamentRow): ProductionState {
    const c = (t.cloud_engine ?? {}) as CloudRecord;
    return {
      mode: t.production_mode,
      cloudAvailable: this.available,
      cloud: {
        status: c.status ?? 'stopped',
        startedAt: c.startedAt ?? null,
        error: c.error ?? null,
        costPerHour: this.config.CLOUD_ENGINE_COST_PER_HOUR,
        autoStopAfterIdleMin: Math.max(1, Math.round(this.config.CLOUD_ENGINE_IDLE_STOP_SEC / 60)),
        autoStopAfterIdleSec: this.config.CLOUD_ENGINE_IDLE_STOP_SEC,
        autoStopAt: c.status === 'running' && this.idleSince.has(t.id)
          ? new Date(this.idleSince.get(t.id)! + this.config.CLOUD_ENGINE_IDLE_STOP_SEC * 1000).toISOString()
          : null,
      },
    };
  }

  private async save(t: TournamentRow, rec: CloudRecord): Promise<void> {
    await this.repo.setTournamentJson(t.id, 'cloud_engine', rec);
    const fresh = await this.repo.tournamentById(t.id);
    if (fresh) this.onChange(t.id, this.state(fresh));
  }

  async startEngine(t: TournamentRow): Promise<ProductionState> {
    if (!this.driver) throw new HttpError(501, 'cloud_unavailable', 'Cloud production is not enabled on this server.');
    if (t.production_mode !== 'cloud') throw new HttpError(409, 'not_cloud_mode', 'Switch this tournament to cloud production first.');
    const cur = (t.cloud_engine ?? {}) as CloudRecord;
    if (cur.id && (cur.status === 'starting' || cur.status === 'running') && (await this.driver.isRunning(cur.id))) {
      return this.state(t);
    }
    const spec: EngineSpec = {
      tournamentId: t.id,
      name: t.name,
      env: {
        SERVER_URL: this.config.CLOUD_ENGINE_SERVER_URL,
        TOURNAMENT_ID: t.id,
        ENGINE_KEY: t.engine_key,
        OBS_PASSWORD: randomSecret(12),
        FALLBACK_TEXT: "We'll be right back",
      },
    };
    await this.save(t, { status: 'starting', startedAt: new Date().toISOString(), error: null, driver: this.driver.name });
    try {
      const id = await this.driver.start(spec);
      this.idleSince.delete(t.id);
      this.warned.delete(t.id);
      await this.save(t, { id, driver: this.driver.name, status: 'starting', startedAt: new Date().toISOString(), error: null });
      this.log.info({ tournament: t.id, handle: id }, 'cloud engine starting');
      try {
        this.events.started?.(t.id);
      } catch {}
    } catch (err) {
      await this.save(t, { status: 'error', startedAt: null, error: (err as Error).message.slice(0, 300) });
      throw new HttpError(502, 'cloud_start_failed', `Could not start the cloud engine: ${(err as Error).message}`);
    }
    return this.state((await this.repo.tournamentById(t.id))!);
  }

  async stopEngine(t: TournamentRow, reason = 'stopped by director'): Promise<ProductionState> {
    const cur = (t.cloud_engine ?? {}) as CloudRecord;
    if (cur.id && this.driver) {
      await this.save(t, { ...cur, status: 'stopping' });
      await this.driver.stop(cur.id).catch((err) => this.log.warn({ err: (err as Error).message }, 'cloud engine stop failed'));
    }
    this.idleSince.delete(t.id);
    this.warned.delete(t.id);
    await this.save(t, { status: 'stopped', startedAt: null, error: null });
    this.log.info({ tournament: t.id, reason }, 'cloud engine stopped');
    try {
      this.events.stopped?.(t.id, reason);
    } catch {}
    return this.state((await this.repo.tournamentById(t.id))!);
  }

  /** The agent inside the engine connected: it is really running. */
  async engineConnected(tournamentId: string): Promise<void> {
    const t = await this.repo.tournamentById(tournamentId);
    const cur = (t?.cloud_engine ?? {}) as CloudRecord;
    if (t && cur.id && cur.status === 'starting') {
      // The idle count starts now, not while it was booting.
      this.idleSince.set(tournamentId, Date.now());
      this.warned.delete(tournamentId);
      await this.save(t, { ...cur, status: 'running' });
    }
  }

  /**
   * "Keep running", or a director working in the control room: restart the idle count.
   * Returns the new state when Cloud OBS is running, else null.
   */
  async keepRunning(tournamentId: string, quiet = false): Promise<ProductionState | null> {
    if (!this.idleSince.has(tournamentId)) return null;
    const had = this.warned.has(tournamentId);
    this.idleSince.set(tournamentId, Date.now());
    this.warned.delete(tournamentId);
    const t = await this.repo.tournamentById(tournamentId);
    if (!t) return null;
    const s = this.state(t);
    // Always tell the room when a warning was showing, so the countdown goes away.
    if (!quiet || had) this.onChange(tournamentId, s);
    return s;
  }

  private async watchdog(): Promise<void> {
    if (!this.driver) return;
    for (const t of await this.repo.tournamentsWithCloudEngine()) {
      const cur = (t.cloud_engine ?? {}) as CloudRecord;
      if (!cur.id || cur.status === 'stopped') continue;
      if (!(await this.driver.isRunning(cur.id))) {
        await this.save(t, { status: 'error', startedAt: null, error: 'The cloud engine stopped unexpectedly. Start it again.' });
        continue;
      }
      const startedAt = cur.startedAt ? Date.parse(cur.startedAt) : Date.now();
      if (Date.now() - startedAt > this.config.CLOUD_ENGINE_MAX_HOURS * 3600_000) {
        await this.stopEngine(t, 'maximum runtime reached');
        continue;
      }
      // Booting: never connected in time → stop (nothing to bill for).
      if (cur.status === 'starting') {
        if (Date.now() - startedAt > this.config.CLOUD_ENGINE_START_TIMEOUT_SEC * 1000) {
          this.events.alert?.(t.id, 'error', 'Cloud OBS did not start in time, so it was stopped. Press Start show to try again.');
          await this.stopEngine(t, 'did not start');
        }
        continue;
      }
      if (this.isBusy(t.id)) {
        if (this.idleSince.has(t.id)) {
          this.idleSince.delete(t.id);
          this.warned.delete(t.id);
          this.onChange(t.id, this.state(t));
        }
        continue;
      }
      // Not live: count, warn, then stop.
      const first = !this.idleSince.has(t.id);
      const since = this.idleSince.get(t.id) ?? Date.now();
      this.idleSince.set(t.id, since);
      if (first) this.onChange(t.id, this.state(t));
      const idleSec = (Date.now() - since) / 1000;
      const stopSec = this.config.CLOUD_ENGINE_IDLE_STOP_SEC;
      if (idleSec >= stopSec) {
        this.events.alert?.(t.id, 'warning', `Cloud OBS stopped: the show was not live for ${fmt(stopSec)}. Press Start show to turn it on again.`);
        await this.stopEngine(t, 'idle');
      } else if (idleSec >= this.config.CLOUD_ENGINE_IDLE_WARN_SEC && !this.warned.has(t.id)) {
        this.warned.add(t.id);
        this.events.alert?.(t.id, 'warning', `Cloud OBS stops in ${fmt(Math.ceil(stopSec - idleSec))} because the show is not live. Go live, or press Keep running in the control room to keep it on.`);
        this.onChange(t.id, this.state(t));
      }
    }
  }

  /** For tests: run one watchdog pass now. */
  async tick(): Promise<void> {
    await this.watchdog();
  }
}

export function makeDriver(config: Config, log: Log): CloudDriver | null {
  if (config.CLOUD_ENGINE_DRIVER === 'docker') return new DockerDriver(config);
  if (config.CLOUD_ENGINE_DRIVER === 'process') return new ProcessDriver(config, log);
  return null;
}

/** 120 → "2 minutes", 45 → "45 seconds". */
function fmt(sec: number): string {
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60} minute${sec === 60 ? '' : 's'}`;
  if (sec >= 90) return `${Math.round(sec / 60)} minutes`;
  return `${Math.round(sec)} seconds`;
}
