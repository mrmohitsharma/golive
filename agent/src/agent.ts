import WebSocket from 'ws';
import type { AgentConfig } from './config.js';
import { ObsController, type EngineConfig, type ObsClient } from './obs.js';

type Log = (msg: string) => void;

export interface ObsConnector {
  client: ObsClient;
  connect(url: string, password?: string): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * Bridges the server and OBS (on a venue laptop or in the cloud engine container):
 *   server --(command)--> agent --(obs-websocket)--> OBS
 *   OBS --(events)--> agent --(engine.state)--> server --> Director apps
 * Both links reconnect on their own with backoff. Authenticates with the tournament's engine key.
 */
export class Agent {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private obsCtl: ObsController;
  private stateTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private serverBackoff = 1000;
  private obsBackoff = 1000;
  private obsConnecting = false;
  private sendQueued = false;
  private lastConfig: EngineConfig | null = null;
  private syncing: Promise<unknown> = Promise.resolve();
  private serverEnabled = true;
  private serverTimer: NodeJS.Timeout | null = null;
  /** Called when the server says this laptop now runs another event (or none). */
  onReassigned: (() => void) | null = null;

  constructor(
    private readonly config: AgentConfig,
    private readonly obs: ObsConnector,
    private readonly log: Log = (m) => console.log(`[${new Date().toISOString()}] ${m}`),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.obsCtl = new ObsController(
      obs.client,
      { fallbackText: config.fallbackText, youtubeStreamKey: config.youtubeStreamKey, youtubeServer: config.youtubeServer, laptopDefaults: config.laptopDefaults },
      () => this.queueState(),
      log,
      (levels) => this.reply({ type: 'engine.meters', levels }),
    );
    obs.client.on('ConnectionClosed', (e: { message?: string }) => {
      if (!this.obsCtl.state.obsConnected) return;
      this.obsCtl.onDisconnected(e?.message || 'closed');
      this.log(`OBS disconnected: ${e?.message ?? ''}`);
      this.scheduleObsReconnect();
    });
    obs.client.on('ExitStarted', () => this.log('OBS is shutting down'));
  }

  get controller(): ObsController {
    return this.obsCtl;
  }

  async start(opts: { server?: boolean } = {}): Promise<void> {
    this.stopped = false;
    this.serverEnabled = opts.server !== false;
    void this.connectObs();
    if (this.serverEnabled) void this.connectServer();
    this.stateTimer = setInterval(async () => {
      if (this.obsCtl.state.obsConnected) {
        try {
          await this.obsCtl.refreshStream();
        } catch (err) {
          this.log(`stream status failed: ${(err as Error).message}`);
        }
      }
      this.sendState();
    }, this.config.stateIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.stateTimer) clearInterval(this.stateTimer);
    if (this.serverTimer) clearTimeout(this.serverTimer);
    this.ws?.close();
    await this.obs.disconnect().catch(() => {});
  }

  /** App mode: (re)connect to the server for the laptop's current event (a fresh token each time). */
  linkServer(): void {
    this.serverEnabled = true;
    this.token = null;
    this.serverBackoff = 1000;
    if (this.serverTimer) clearTimeout(this.serverTimer);
    this.serverTimer = null;
    if (this.ws) this.ws.close(1000, 'event changed');
    else void this.connectServer();
  }

  /** App mode: the laptop has no event: stay connected to OBS only. */
  unlinkServer(): void {
    this.serverEnabled = false;
    this.token = null;
    if (this.serverTimer) clearTimeout(this.serverTimer);
    this.serverTimer = null;
    this.ws?.close(1000, 'no event');
  }

  /** App mode: OBS address or password changed (read again from OBS's own settings). */
  setObs(url: string, password: string | undefined): void {
    (this.config as { obsUrl: string }).obsUrl = url;
    (this.config as { obsPassword?: string }).obsPassword = password;
  }

  get serverConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Serialises OBS reconfiguration so overlapping config messages do not race. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.syncing.then(fn, fn);
    this.syncing = run.catch(() => {});
    return run;
  }

  // ---------------------------------------------------------------- OBS link
  private async connectObs(): Promise<void> {
    if (this.stopped || this.obsConnecting) return;
    this.obsConnecting = true;
    try {
      await this.obs.connect(this.config.obsUrl, this.config.obsPassword);
      this.obsBackoff = 1000;
      await this.serial(() => this.obsCtl.onConnected());
      this.log(`connected to OBS ${this.obsCtl.state.obsVersion}`);
      for (const w of this.obsCtl.state.warnings) this.log(`warning: ${w}`);
      this.sendState();
    } catch (err) {
      this.obsCtl.onDisconnected((err as Error).message);
      this.log(`cannot reach OBS at ${this.config.obsUrl}: ${(err as Error).message}. Is OBS open with WebSocket server enabled?`);
      this.scheduleObsReconnect();
    } finally {
      this.obsConnecting = false;
    }
  }

  private scheduleObsReconnect(): void {
    if (this.stopped) return;
    const delay = this.obsBackoff;
    this.obsBackoff = Math.min(this.obsBackoff * 2, 15000);
    setTimeout(() => void this.connectObs(), delay);
  }

  // ---------------------------------------------------------------- server link
  private async login(): Promise<string> {
    if (this.config.tokenSource) return this.config.tokenSource();
    const res = await this.fetchImpl(`${this.config.serverUrl}/api/engine/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tournamentId: this.config.tournamentId, engineKey: this.config.engineKey }),
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string; error?: { message?: string } };
    if (!res.ok || !body.token) throw new Error(body.error?.message ?? `engine login failed (${res.status})`);
    return body.token;
  }

  private async connectServer(): Promise<void> {
    if (this.stopped || !this.serverEnabled) return;
    try {
      if (!this.token) this.token = await this.login();
    } catch (err) {
      this.log(`server login failed: ${(err as Error).message}`);
      return this.scheduleServerReconnect();
    }
    const wsUrl = this.config.serverUrl.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${this.token}` } });
    this.ws = ws;
    ws.on('open', () => {
      this.serverBackoff = 1000;
      this.log(`connected to server ${this.config.serverUrl}`);
      ws.send(JSON.stringify({ type: 'engine.hello', version: '0.2.0' }));
    });
    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      void this.onServerMessage(msg);
    });
    ws.on('close', (code, reason) => {
      if (this.ws === ws) this.ws = null;
      if (code === 4001) this.token = null; // token expired → log in again
      if (code === 4002) {
        // The laptop was moved to another event: ask which one, then connect again.
        this.token = null;
        this.log('this laptop was moved to another event');
        this.onReassigned?.();
        return;
      }
      if (code === 1000 && reason.toString() === 'event changed') {
        this.token = null;
        void this.connectServer();
        return;
      }
      if (!this.stopped && this.serverEnabled) {
        this.log(`server connection closed (${code} ${reason.toString()}), reconnecting`);
        this.scheduleServerReconnect();
      }
    });
    ws.on('error', (err) => this.log(`server socket error: ${err.message}`));
  }

  private scheduleServerReconnect(): void {
    if (this.stopped || !this.serverEnabled) return;
    const delay = this.serverBackoff;
    this.serverBackoff = Math.min(this.serverBackoff * 2, 15000);
    if (this.serverTimer) clearTimeout(this.serverTimer);
    this.serverTimer = setTimeout(() => void this.connectServer(), delay);
  }

  private async onServerMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'engine.config': {
        const { type: _t, ...cfg } = msg;
        this.lastConfig = cfg as EngineConfig;
        try {
          const r = await this.serial(() => this.obsCtl.sync(this.lastConfig!));
          if (this.obsCtl.state.obsConnected) {
            this.log(
              `OBS synced: ${cfg.cameras.length} cameras (+${r.created} new, ${r.updated} updated, -${r.removed} removed), ${cfg.commentators.length} commentators, mode ${cfg.mode}`,
            );
          }
        } catch (err) {
          this.obsCtl.state.lastError = `OBS setup failed: ${(err as Error).message}`;
          this.log(this.obsCtl.state.lastError);
        }
        this.sendState();
        return;
      }
      case 'engine.audio': {
        try {
          await this.serial(() => this.obsCtl.applyAudio(msg.audio));
        } catch (err) {
          this.log(`audio update failed: ${(err as Error).message}`);
        }
        return;
      }
      case 'command': {
        const started = Date.now();
        try {
          await this.serial(() => this.obsCtl.execute(msg.action, msg.cameraId ?? null, msg));
          this.reply({ type: 'command.result', id: msg.id, ok: true });
          this.log(`${msg.action}${msg.sceneName ? ' ' + msg.sceneName : ''} ok (${Date.now() - started} ms)`);
        } catch (err) {
          const e = err as { message?: string };
          this.reply({ type: 'command.result', id: msg.id, ok: false, error: e.message ?? 'OBS request failed' });
          this.log(`${msg.action} failed: ${e.message}`);
        }
        await this.obsCtl.refreshScenes().catch(() => {});
        this.sendState();
        return;
      }
      case 'error':
        this.log(`server error: ${msg.code} ${msg.message}`);
        return;
      default:
        return;
    }
  }

  private reply(m: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private queueState(): void {
    if (this.sendQueued) return;
    this.sendQueued = true;
    setImmediate(() => {
      this.sendQueued = false;
      this.sendState();
    });
  }

  sendState(): void {
    this.reply({ type: 'engine.state', state: this.obsCtl.state });
  }
}
