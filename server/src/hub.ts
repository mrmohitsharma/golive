import { eventProfile } from './event-types.js';
import { nextCamera, OBS_TRANSITION, switchingOf, type Switching } from './switching.js';
import type { ViewershipService } from './viewership.js';
import type { InfluencersService } from './influencers.js';
import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import type { Config } from './config.js';
import { engineMediaBase } from './config.js';
import { principalKey, type Principal } from './auth.js';
import { can, roleInTournament, type Capability, type TournamentRole } from './authz.js';
import type { CameraRow, CommentatorRow, Repo, TournamentRow } from './repo.js';
import type { ScoringRepo } from './scoring.js';
import type { HealthSnapshot } from './health.js';
import { offlineHealth } from './health.js';
import { engineReadUrl, whepUrl } from './media.js';
import {
  DIRECTOR_ACTIONS,
  FALLBACK_SCENE,
  REPLAY_SCENE,
  commentaryInputFor,
  defaultAudio,
  emptyEngineState,
  feedInputFor,
  sceneNameFor,
  type AudioState,
  type CameraHealth,
  type CameraTelemetry,
  type DirectorAction,
  type EngineCamera,
  type EngineCommentator,
  type EngineState,
  type GraphicsState,
  type ProductionState,
  type YoutubeState,
} from './protocol.js';
import type { GraphicsService } from './graphics.js';
import { mergeGraphics } from './graphics.js';
import type { MediaService, ClipRow } from './replay.js';
import { clipDto } from './replay.js';
import type { YouTubeService } from './youtube.js';
import { watchUrl } from './youtube.js';
import type { CloudEngineManager } from './cloud.js';
import type { OutputsService } from './outputs.js';
import type { BillingService, TournamentBilling } from './billing.js';
import type { ChatReaders } from './chat-readers.js';

interface Client {
  id: string;
  ws: WebSocket;
  principal: Principal;
  tournamentId: string | null;
  role: TournamentRole | null;
  cameraId: string | null;
  isEngine: boolean;
  alive: boolean;
}

interface PendingCommand {
  id: string;
  tournamentId: string;
  action: string;
  cameraId: string | null;
  requestedBy: Client | null;
  requestId: string | null;
  actor: string | null;
  timer: NodeJS.Timeout;
}

interface TournamentLive {
  engine: EngineState;
  engineClient: Client | null;
  telemetry: Map<string, { t: CameraTelemetry; at: number }>;
  programmeOfflineSince: number | null;
  youtube: YoutubeState;
  lastMetersAt: number;
  /** Last time the restream relays were checked against what is wanted (throttle). */
  relayCheckedAt: number;
  /** The show is over: camera phones were told to stop sending until the next show. */
  camerasPaused: boolean;
  /** Laptop OBS: pause the cameras this long after End broadcast unless live again. */
  endTimer: NodeJS.Timeout | null;
  /** V9: auto switch and transition settings (loaded with the event, updated on save). */
  switching: Switching | null;
  /** When the camera on air last changed (by hand or automatically): the auto-switch clock. */
  lastSwitchAt: number;
  /** Main-camera mode: the last of the other cameras shown, so they take turns. */
  autoLastOther: string | null;
}

export interface Logger {
  info: (o: object | string, m?: string) => void;
  warn: (o: object | string, m?: string) => void;
  error: (o: object | string, m?: string) => void;
}

/** Services the hub talks to; wired after construction because they also talk back to the hub. */
export interface HubServices {
  graphics: GraphicsService;
  media: MediaService;
  youtube: YouTubeService;
  cloud: CloudEngineManager;
  outputs: OutputsService;
  billing: BillingService;
  chatReaders: ChatReaders;
  viewership?: ViewershipService;
  influencers?: InfluencersService;
  /** V9: emails a brand channel's followers when one of its events goes live. */
  channels?: { wentLive(tournamentId: string): Promise<unknown> };
}

const COMMAND_TIMEOUT_MS = 8000;
const REPLAY_TIMEOUT_MS = 30000;

export function mergeAudio(stored: unknown): AudioState {
  const d = defaultAudio();
  const s = (stored ?? {}) as Partial<AudioState>;
  return { ...d, ...s, cameras: { ...(s.cameras ?? {}) } };
}

function emptyYoutube(): YoutubeState {
  return {
    source: 'org',
    goliveAvailable: false,
    connected: false,
    channelTitle: null,
    broadcastId: null,
    watchUrl: null,
    privacy: null,
    lifeCycleStatus: null,
    streamStatus: null,
    health: null,
    issues: [],
    checkedAt: null,
    error: null,
  };
}

export class Hub {
  private clients = new Set<Client>();
  private live = new Map<string, TournamentLive>();
  private pending = new Map<string, PendingCommand>();
  private health: HealthSnapshot = { reachable: false, error: 'not polled yet', paths: new Map() };
  private pingTimer: NodeJS.Timeout;
  private ytTimer: NodeJS.Timeout | null = null;
  services!: HubServices;

  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
    private readonly scoring: ScoringRepo,
    private readonly log: Logger,
  ) {
    this.pingTimer = setInterval(() => this.heartbeat(), 15000);
  }

  private autoTimer: NodeJS.Timeout | null = null;
  /** V9: checks every second whether an event with auto switch on is due for the next camera. */
  startAutoSwitch(): void {
    if (this.autoTimer) return;
    this.autoTimer = setInterval(() => void this.autoSwitchTick().catch((err) => this.log.warn({ err: (err as Error).message }, 'auto switch failed')), 1000);
  }

  startYoutubePolling(): void {
    if (this.ytTimer) return;
    this.ytTimer = setInterval(() => void this.pollYoutube(), this.config.YOUTUBE_POLL_MS);
  }

  close(): void {
    clearInterval(this.pingTimer);
    if (this.autoTimer) clearInterval(this.autoTimer);
    for (const t of this.chatTimers.values()) clearTimeout(t);
    if (this.ytTimer) clearInterval(this.ytTimer);
    for (const p of this.pending.values()) clearTimeout(p.timer);
    for (const c of this.clients) c.ws.close(1001, 'server shutting down');
  }

  // ------------------------------------------------------------------ state
  private liveFor(tournamentId: string): TournamentLive {
    let l = this.live.get(tournamentId);
    if (!l) {
      l = { engine: emptyEngineState(), engineClient: null, telemetry: new Map(), programmeOfflineSince: null, youtube: emptyYoutube(), lastMetersAt: 0, relayCheckedAt: 0, camerasPaused: false, endTimer: null, switching: null, lastSwitchAt: Date.now(), autoLastOther: null };
      this.live.set(tournamentId, l);
    }
    return l;
  }

  // ------------------------------------------------------------------ V9 switching
  /** The event's switching settings (from memory; read from the event the first time). */
  async switching(tid: string): Promise<Switching> {
    const l = this.liveFor(tid);
    if (!l.switching) {
      const t = await this.repo.tournamentById(tid);
      l.switching = switchingOf((t as { switching?: unknown } | null)?.switching);
    }
    return l.switching;
  }

  /** Saved from the control room: takes effect at once; the auto clock restarts when switched on. */
  setSwitching(tid: string, sw: Switching): void {
    const l = this.liveFor(tid);
    const turnedOn = sw.auto.on && !l.switching?.auto.on;
    l.switching = sw;
    if (turnedOn) l.lastSwitchAt = Date.now();
    this.pushSwitching(tid);
  }

  /** What the control room shows: settings, when the next automatic switch happens and to which camera. */
  async switchingView(tid: string, known?: CameraRow[]) {
    const sw = await this.switching(tid);
    const l = this.liveFor(tid);
    let next: string | null = null;
    if (sw.auto.on) {
      const cams = known ?? (await this.repo.camerasForTournament(tid));
      next = nextCamera(cams.filter((c) => this.usableForAir(tid, c)), l.engine.programmeCameraId, sw.auto, l.autoLastOther);
    }
    return { ...sw, nextAt: sw.auto.on ? new Date(l.lastSwitchAt + sw.auto.everySec * 1000).toISOString() : null, nextCameraId: next, running: sw.auto.on && this.autoReady(tid) };
  }

  /** Sent only when a director is watching (saves the camera read otherwise). */
  private pushSwitching(tid: string, cams?: CameraRow[]): void {
    if (!this.hasClients(tid, 'direct')) return;
    void this.switchingView(tid, cams)
      .then((v) => this.toTournament(tid, { type: 'switching', switching: v }, 'direct'))
      .catch(() => {});
  }

  /** A camera that can go on air now: sending video, not on a call, not paused. */
  /** Billing: a camera counts as switched on while it is sending video. */
  cameraSending(c: CameraRow): boolean {
    return this.healthFor(c.stream_path).online;
  }

  private usableForAir(tid: string, c: CameraRow): boolean {
    if (!this.healthFor(c.stream_path).online) return false;
    const tel = this.telemetryFor(tid, c.id);
    return !tel?.inCall && tel?.state !== 'paused';
  }

  /** Auto switch only runs while live, with the engine up, and never over a replay or the fallback screen. */
  private autoReady(tid: string): boolean {
    const l = this.liveFor(tid);
    const e = l.engine;
    return Boolean(l.engineClient && e.obsConnected && e.streaming.active && !e.replayActive && !e.fallbackActive);
  }

  async autoSwitchTick(): Promise<void> {
    const now = Date.now();
    for (const [tid, l] of this.live) {
      const sw = l.switching;
      if (!sw?.auto.on || !this.autoReady(tid)) continue;
      if (now - l.lastSwitchAt < sw.auto.everySec * 1000) continue;
      // Try again in a few seconds if nothing can be switched to (or the command fails).
      l.lastSwitchAt = now - sw.auto.everySec * 1000 + 5000;
      const cams = await this.repo.camerasForTournament(tid);
      const nextId = nextCamera(cams.filter((c) => this.usableForAir(tid, c)), l.engine.programmeCameraId, sw.auto, l.autoLastOther);
      const next = nextId ? cams.find((c) => c.id === nextId) : null;
      if (!next) continue;
      const r = this.dispatch(tid, 'cut', next.id, null, null, { sceneName: sceneNameFor(next.stream_path), auto: true });
      if (r.ok) {
        l.lastSwitchAt = now;
        if (sw.auto.mode === 'main' && next.id !== sw.auto.mainCameraId) l.autoLastOther = next.id;
        this.pushSwitching(tid, cams);
      }
    }
  }

  /**
   * V9: the director adjusts a camera phone from the control room (zoom, brightness, focus).
   * The phone applies it (zooming smoothly when it is on air) and reports the new values.
   */
  adjustCamera(tid: string, cameraId: string, v: { zoom?: number; ev?: number; focus?: 'auto' | 'lock' }): boolean {
    const smooth = this.liveFor(tid).engine.programmeCameraId === cameraId;
    let sent = false;
    for (const c of this.clients) {
      if (c.tournamentId === tid && c.cameraId === cameraId) {
        this.send(c, { type: 'camera.adjust', ...v, smooth });
        sent = true;
      }
    }
    return sent;
  }

  engineState(tournamentId: string): EngineState {
    return this.liveFor(tournamentId).engine;
  }

  healthFor(streamPath: string): CameraHealth {
    return this.health.paths.get(streamPath) ?? offlineHealth();
  }

  /** Anything live in this tournament? (cloud engine idle auto-stop) */
  isBusy(tournamentId: string): boolean {
    // Only the show being live keeps Cloud OBS on: a phone left sending video does not.
    return this.liveFor(tournamentId).engine.streaming.active;
  }

  /**
   * The show is over (Cloud OBS stopped, or Laptop OBS ended a while ago): tell the camera
   * phones to stop sending until the next show, saving their data and our bandwidth.
   */
  pauseCameras(tournamentId: string, message: string): void {
    const l = this.liveFor(tournamentId);
    if (l.engine.streaming.active) return;
    l.camerasPaused = true;
    for (const c of this.clients) if (c.tournamentId === tournamentId && c.cameraId) this.send(c, { type: 'camera.pause', message });
  }

  /** A new show starts (Start show, Cloud OBS started, or live again): phones may send again. */
  resumeCameras(tournamentId: string): void {
    const l = this.liveFor(tournamentId);
    if (l.endTimer) clearTimeout(l.endTimer);
    l.endTimer = null;
    if (!l.camerasPaused) return;
    l.camerasPaused = false;
    for (const c of this.clients) if (c.tournamentId === tournamentId && c.cameraId) this.send(c, { type: 'camera.resume' });
  }

  telemetryFor(tournamentId: string, cameraId: string): (CameraTelemetry & { receivedAt: string }) | null {
    const t = this.liveFor(tournamentId).telemetry.get(cameraId);
    if (!t || Date.now() - t.at > this.config.TELEMETRY_STALE_MS) return null;
    return { ...t.t, receivedAt: new Date(t.at).toISOString() };
  }

  cameraDto(c: CameraRow) {
    const health = this.healthFor(c.stream_path);
    const telemetry = this.telemetryFor(c.tournament_id, c.id);
    const engine = this.liveFor(c.tournament_id).engine;
    let status: 'live' | 'connecting' | 'paused' | 'offline' = 'offline';
    if (health.online) status = 'live';
    else if (telemetry?.state === 'paused') status = 'paused';
    else if (telemetry && ['connecting', 'reconnecting', 'live'].includes(telemetry.state)) status = 'connecting';
    return {
      id: c.id,
      tournamentId: c.tournament_id,
      name: c.name,
      hole: c.hole,
      position: c.position,
      streamPath: c.stream_path,
      platform: c.device_platform,
      deviceModel: c.device_model,
      sortOrder: c.sort_order,
      status,
      health,
      telemetry,
      onAir: engine.programmeCameraId === c.id && !engine.replayActive,
      inPreview: engine.previewCameraId === c.id,
      whepUrl: whepUrl(this.config, c.stream_path),
      thumbnailUrl: `/api/cameras/${c.id}/thumbnail.jpg`,
    };
  }

  commentatorDto(m: CommentatorRow) {
    const h = this.healthFor(m.stream_path);
    return { id: m.id, tournamentId: m.tournament_id, name: m.name, streamPath: m.stream_path, online: h.online, inboundKbps: h.inboundKbps };
  }

  async youtubeState(t: TournamentRow): Promise<YoutubeState> {
    const l = this.liveFor(t.id);
    const yt = this.services?.youtube;
    const org = yt?.enabled ? await this.repo.orgYoutube(t.org_id) : null;
    const platform = yt?.enabled ? await yt.platformChannel() : null;
    const source = t.yt_source ?? 'org';
    return {
      ...l.youtube,
      source,
      goliveAvailable: Boolean(platform?.enabled),
      connected: source === 'golive' ? Boolean(platform?.enabled) : source === 'key' ? Boolean(t.yt_stream_key_enc) : Boolean(org),
      channelTitle: source === 'golive' ? (platform?.channelTitle ?? null) : source === 'key' ? null : (org?.channel_title ?? null),
      broadcastId: t.yt_broadcast_id,
      watchUrl: watchUrl(t.yt_broadcast_id),
      privacy: t.yt_privacy,
    };
  }

  productionState(t: TournamentRow): ProductionState {
    return this.services.cloud.state(t);
  }

  async snapshot(t: TournamentRow, role: TournamentRole | null) {
    const base = {
      tournament: {
        id: t.id,
        orgId: t.org_id,
        name: t.name,
        venue: t.venue,
        startsOn: t.starts_on,
        autoFallback: t.auto_fallback,
        mode: t.production_mode,
        eventType: t.event_type ?? 'golf',
        profile: eventProfile(t.event_type),
        publicWatch: t.public_watch !== false,
        chatEnabled: t.chat_enabled !== false,
        chatSlowSec: t.chat_slow_sec ?? 3,
      },
      role,
      leaderboard: (await this.scoring.leaderboard(t.id)).rows.slice(0, 20),
      serverTime: new Date().toISOString(),
    };
    if (!can(role, 'watch')) return base;
    const [cams, coms] = await Promise.all([this.repo.camerasForTournament(t.id), this.repo.commentatorsForTournament(t.id)]);
    return {
      ...base,
      cameras: cams.map((c) => this.cameraDto(c)),
      commentators: coms.map((m) => this.commentatorDto(m)),
      engine: this.liveFor(t.id).engine,
      mediaServer: { reachable: this.health.reachable, error: this.health.error },
      graphics: mergeGraphics(t.graphics),
      audio: mergeAudio(t.audio),
      production: this.productionState(t),
      youtube: await this.youtubeState(t),
      outputs: await this.services.outputs.state(t),
      ...(can(role, 'direct') ? { billing: await this.services.billing.tournamentState(t), switching: await this.switchingView(t.id) } : {}),
    };
  }

  async engineConfig(t: TournamentRow) {
    const mode = t.production_mode;
    const [cams, coms] = await Promise.all([this.repo.camerasForTournament(t.id), this.repo.commentatorsForTournament(t.id)]);
    const cameras: EngineCamera[] = cams.map((c) => ({
      id: c.id,
      name: c.name,
      hole: c.hole,
      position: c.position,
      streamPath: c.stream_path,
      sceneName: sceneNameFor(c.stream_path),
      inputName: feedInputFor(c.stream_path),
      srtUrl: engineReadUrl(this.config, c.stream_path, t.read_key, mode),
    }));
    const commentators: EngineCommentator[] = coms.map((m) => ({
      id: m.id,
      name: m.name,
      streamPath: m.stream_path,
      inputName: commentaryInputFor(m.stream_path),
      srtUrl: engineReadUrl(this.config, m.stream_path, t.read_key, mode),
    }));
    return {
      tournamentId: t.id,
      tournamentName: t.name,
      mode,
      fallbackScene: FALLBACK_SCENE,
      replayScene: REPLAY_SCENE,
      cameras,
      commentators,
      graphicsUrl: `${engineMediaBase(this.config, mode)}/graphics/${t.id}?k=${t.graphics_key}`,
      // OBS streams once: to this server for restreaming, or (null) wherever OBS / the agent .env says.
      output: await this.services.outputs.engineOutput(t),
      audio: mergeAudio(t.audio),
      canvas:
        mode === 'cloud'
          ? {
              width: this.config.CLOUD_ENGINE_WIDTH,
              height: this.config.CLOUD_ENGINE_HEIGHT,
              fps: this.config.CLOUD_ENGINE_FPS,
              videoKbps: this.config.CLOUD_ENGINE_VIDEO_KBPS,
            }
          : null,
      // What viewers get (both modes): OBS scales its output to this and the server passes it
      // straight through to YouTube and the watch player, so nothing is re-encoded.
      encoder: { height: this.config.PROGRAMME_HEIGHT, videoKbps: this.config.PROGRAMME_KBPS },
    };
  }

  // ------------------------------------------------------------------ connections
  attach(ws: WebSocket, principal: Principal): void {
    const client: Client = { id: crypto.randomUUID(), ws, principal, tournamentId: null, role: null, cameraId: null, isEngine: false, alive: true };
    this.clients.add(client);
    ws.on('pong', () => (client.alive = true));
    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return this.send(client, { type: 'error', code: 'bad_json', message: 'Message was not valid JSON.' });
      }
      this.onMessage(client, msg).catch((err) => {
        this.log.error({ err: (err as Error).message, type: msg.type }, 'ws handler failed');
        this.send(client, { type: 'error', code: 'internal', message: 'Server error handling message.' });
      });
    });
    ws.on('close', () => this.detach(client));
    ws.on('error', () => this.detach(client));
    this.send(client, { type: 'hello', principal: { kind: principal.kind, id: principal.id, name: principal.name } });
  }

  private detach(client: Client): void {
    if (!this.clients.delete(client)) return;
    if (client.isEngine && client.tournamentId) {
      const l = this.liveFor(client.tournamentId);
      if (l.engineClient === client) {
        l.engineClient = null;
        l.engine = { ...l.engine, connected: false, obsConnected: false, updatedAt: new Date().toISOString() };
        this.broadcastEngine(client.tournamentId);
        this.alert(client.tournamentId, 'error', 'Broadcast engine disconnected. Switching is unavailable until it reconnects.');
        for (const p of this.pending.values()) {
          if (p.tournamentId === client.tournamentId) this.resolveCommand(p.id, false, 'Broadcast engine disconnected.');
        }
      }
    }
  }

  private heartbeat(): void {
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate();
        this.detach(c);
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        /* ignore */
      }
    }
  }

  private send(client: Client, msg: object): void {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
  }

  /** Sends to subscribed (non-engine) clients of a tournament whose role has `cap`. */
  private hasClients(tournamentId: string, cap: Capability): boolean {
    for (const c of this.clients) if (c.tournamentId === tournamentId && !c.isEngine && !c.cameraId && can(c.role, cap)) return true;
    return false;
  }

  toTournament(tournamentId: string, msg: object, cap: Capability = 'watch'): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.tournamentId !== tournamentId || c.isEngine || c.cameraId) continue;
      if (!can(c.role, cap)) continue;
      if (c.ws.readyState === 1) c.ws.send(data);
    }
  }

  /** A laptop was moved to another event or removed: disconnect the agent so it picks up its new event. */
  dropEngine(tournamentId: string, message: string): void {
    const e = this.liveFor(tournamentId).engineClient;
    if (!e) return;
    this.send(e, { type: 'engine.reassigned', message });
    e.ws.close(4002, 'laptop reassigned');
  }

  private toEngine(tournamentId: string, msg: object): boolean {
    const e = this.liveFor(tournamentId).engineClient;
    if (!e) return false;
    this.send(e, msg);
    return true;
  }

  alert(tournamentId: string, level: 'info' | 'warning' | 'error', message: string): void {
    this.toTournament(tournamentId, { type: 'alert', level, message, at: new Date().toISOString() }, 'direct');
  }

  // ------------------------------------------------------------------ messages
  private async onMessage(client: Client, msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'ping':
        return this.send(client, { type: 'pong', at: Date.now() });

      case 'subscribe': {
        const t = await this.tournament(client, msg.tournamentId);
        if (!t) return;
        const role = await roleInTournament(this.repo, client.principal, t);
        if (!can(role, 'view') || role === 'engine') return this.forbidden(client, 'follow this tournament');
        client.tournamentId = t.id;
        client.role = role;
        client.cameraId = null;
        return this.send(client, { type: 'snapshot', ...(await this.snapshot(t, role)) });
      }

      case 'camera.join': {
        const cam = typeof msg.cameraId === 'string' ? await this.repo.cameraById(msg.cameraId).catch(() => null) : null;
        if (!cam) return this.send(client, { type: 'error', code: 'camera_not_found', message: 'Camera not found.' });
        const t = (await this.repo.tournamentById(cam.tournament_id))!;
        const role = await roleInTournament(this.repo, client.principal, t);
        const owns = cam.owner === principalKey(client.principal);
        if (!owns && !can(role, 'manage')) return this.forbidden(client, 'use this camera');
        client.tournamentId = cam.tournament_id;
        client.role = role;
        client.cameraId = cam.id;
        this.send(client, { type: 'camera.joined', camera: this.cameraDto(cam) });
        if (this.liveFor(cam.tournament_id).camerasPaused) this.send(client, { type: 'camera.pause', message: 'The show has ended, so this camera stopped sending. Tap Go live when the director starts the next show.' });
        return this.sendTally(client);
      }

      case 'telemetry': {
        if (!client.cameraId || !client.tournamentId) return;
        const t = sanitizeTelemetry(msg.telemetry);
        const l = this.liveFor(client.tournamentId);
        const before = l.telemetry.get(client.cameraId)?.t;
        l.telemetry.set(client.cameraId, { t, at: Date.now() });
        await this.repo.saveTelemetry(client.cameraId, t).catch(() => {});
        // A call or the app leaving the screen: tell the director at once, and take the camera
        // off air if it is showing. MIC OFF / ON A CALL badges update straight away.
        const call = t.inCall === true && before?.inCall !== true;
        const paused = t.state === 'paused' && before?.state !== 'paused';
        if (call || paused) await this.cameraInterrupted(client.tournamentId, client.cameraId, call ? 'call' : 'paused');
        if (call || paused || (t.micMuted ?? false) !== (before?.micMuted ?? false) || (t.inCall ?? false) !== (before?.inCall ?? false)) {
          await this.pushCameras(client.tournamentId).catch(() => {});
        } else if (t.controls && !sameControls(t.controls, before?.controls)) {
          // Zoom / brightness / focus moved on the phone: just that, no camera list rebuild.
          this.toTournament(client.tournamentId, { type: 'camera.controls', cameraId: client.cameraId, controls: t.controls }, 'direct');
        }
        return;
      }

      case 'engine.hello': {
        const p = client.principal;
        if (p.kind !== 'engine') return this.forbidden(client, 'act as the broadcast engine');
        const t = await this.tournament(client, p.tournamentId);
        if (!t) return;
        const l = this.liveFor(t.id);
        if (l.engineClient && l.engineClient !== client) {
          this.send(l.engineClient, { type: 'error', code: 'replaced', message: 'Another engine connected for this tournament.' });
          l.engineClient.ws.close(4000, 'replaced by another engine');
        }
        client.isEngine = true;
        client.tournamentId = t.id;
        client.role = 'engine';
        l.engineClient = client;
        l.engine = { ...l.engine, connected: true, updatedAt: new Date().toISOString() };
        this.send(client, { type: 'engine.config', ...(await this.engineConfig(t)) });
        this.broadcastEngine(t.id);
        await this.switching(t.id).catch(() => {});
        this.alert(t.id, 'info', `Broadcast engine connected (${t.production_mode === 'cloud' ? 'cloud' : 'laptop'}).`);
        await this.services.cloud.engineConnected(t.id).catch(() => {});
        return;
      }

      case 'engine.state':
        if (!client.isEngine || !client.tournamentId) return;
        return this.onEngineState(client.tournamentId, (msg.state ?? {}) as Partial<EngineState>);

      case 'engine.meters': {
        if (!client.isEngine || !client.tournamentId) return;
        const l = this.liveFor(client.tournamentId);
        if (Date.now() - l.lastMetersAt < 200) return;
        l.lastMetersAt = Date.now();
        return this.toTournament(client.tournamentId, { type: 'meters', levels: msg.levels ?? {} }, 'direct');
      }

      case 'command.result': {
        if (!client.isEngine) return;
        return this.resolveCommand(String(msg.id ?? ''), Boolean(msg.ok), typeof msg.error === 'string' ? msg.error : null);
      }

      case 'command':
        return this.onDirectorCommand(client, msg);

      default:
        return this.send(client, { type: 'error', code: 'unknown_type', message: `Unknown message type ${String(msg.type)}.` });
    }
  }

  private async onEngineState(tournamentId: string, s: Partial<EngineState>): Promise<void> {
    const l = this.liveFor(tournamentId);
    const prevProgramme = l.engine.programmeCameraId;
    const prevPreview = l.engine.previewCameraId;
    const prevReplay = l.engine.replayActive;
    const prevStreaming = l.engine.streaming.active;
    const prevObs = l.engine.obsConnected;
    l.engine = {
      ...l.engine,
      connected: true,
      obsConnected: Boolean(s.obsConnected),
      obsVersion: s.obsVersion ?? l.engine.obsVersion ?? null,
      programmeCameraId: s.programmeCameraId ?? null,
      previewCameraId: s.previewCameraId ?? null,
      programmeScene: s.programmeScene ?? null,
      previewScene: s.previewScene ?? null,
      fallbackActive: Boolean(s.fallbackActive),
      replayActive: Boolean(s.replayActive),
      studioMode: Boolean(s.studioMode),
      streaming: {
        active: Boolean(s.streaming?.active),
        reconnecting: Boolean(s.streaming?.reconnecting),
        timecode: s.streaming?.timecode ?? null,
        kbps: s.streaming?.kbps ?? null,
        congestion: s.streaming?.congestion ?? null,
        skippedFrames: s.streaming?.skippedFrames ?? null,
        totalFrames: s.streaming?.totalFrames ?? null,
      },
      warnings: Array.isArray(s.warnings) ? s.warnings.filter((w) => typeof w === 'string').slice(0, 5) : [],
      lastError: s.lastError ?? null,
      video:
        s.video && Number.isFinite(s.video.outputHeight) && Number.isFinite(s.video.outputWidth)
          ? { outputWidth: Number(s.video.outputWidth), outputHeight: Number(s.video.outputHeight), kbps: s.video.kbps == null ? null : Number(s.video.kbps) }
          : null,
      updatedAt: new Date().toISOString(),
    };
    if (l.engine.programmeCameraId !== prevProgramme) {
      l.programmeOfflineSince = null;
      // Any switch (the director's or automatic) restarts the auto-switch clock from that camera.
      l.lastSwitchAt = Date.now();
      if (l.switching?.auto.on) this.pushSwitching(tournamentId);
    }
    this.broadcastEngine(tournamentId);
    if (l.engine.programmeCameraId !== prevProgramme || l.engine.previewCameraId !== prevPreview || l.engine.replayActive !== prevReplay) {
      this.broadcastTally(tournamentId);
    }
    if (prevReplay && !l.engine.replayActive) await this.services.graphics.setReplay(tournamentId, false).catch(() => {});
    await this.syncRelays(tournamentId, prevStreaming, l.engine.streaming.active).catch((err) =>
      this.log.warn({ err: (err as Error).message }, 'restream sync failed'),
    );
    // Onboarding timing (P1-12): mixer up = test done; streaming = first live.
    if (!prevObs && l.engine.obsConnected) await this.repo.markOnboarding(tournamentId, 'test').catch(() => {});
    if (!prevStreaming && l.engine.streaming.active) {
      await this.repo.markOnboarding(tournamentId, 'live').catch(() => {});
      // Stream clock (viewership): the first Go live of the event.
      await this.services.viewership?.streamStarted(tournamentId).catch(() => {});
      // "Remind me" sign-ups get their message when the stream starts (once).
      const tr = await this.repo.tournamentById(tournamentId).catch(() => null);
      if (tr) await this.services.influencers?.sendReminders(tr).catch((err) => this.log.warn({ err: (err as Error).message }, 'reminders failed'));
      // In the background: emailing a big channel's followers must never hold up live switching.
      void this.services.channels?.wentLive(tournamentId).catch((err) => this.log.warn({ err: (err as Error).message }, 'channel alert failed'));
    }
    if (l.engine.programmeCameraId !== prevProgramme && l.engine.programmeCameraId) {
      const cam = await this.repo.cameraById(l.engine.programmeCameraId);
      if (cam) await this.services.graphics.onProgramme(tournamentId, { cameraName: cam.name, hole: cam.hole }).catch(() => {});
    }
  }

  private async onDirectorCommand(client: Client, msg: Record<string, unknown>): Promise<void> {
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
    const fail = (error: string) => this.send(client, { type: 'command.result', requestId, action: msg.action, ok: false, error });
    if (!client.tournamentId) return fail('Open a tournament first.');
    if (!can(client.role, 'direct')) return this.forbidden(client, 'direct the broadcast');
    const action = msg.action as DirectorAction;
    if (!DIRECTOR_ACTIONS.includes(action)) return fail(`Unknown action ${String(action)}.`);
    const tid = client.tournamentId;
    const l = this.liveFor(tid);
    // A director working in the control room is not idle: restart Cloud OBS's idle count.
    void this.services.cloud.keepRunning(tid, true).catch(() => {});
    let cameraId = typeof msg.cameraId === 'string' ? msg.cameraId : null;
    if (action === 'take' && !cameraId) cameraId = l.engine.previewCameraId;

    if (['preview', 'take', 'cut', 'replay'].includes(action)) {
      const cam = cameraId ? await this.repo.cameraById(cameraId).catch(() => null) : null;
      if (!cam || cam.tournament_id !== tid) return fail('Pick a camera from this tournament first.');
      if (action === 'replay') {
        const gate = this.canDispatch(tid);
        if (!gate.ok) return fail(gate.error);
        const seconds = clampInt(msg.seconds, 5, 60, 10);
        const slowmo = msg.slowmo === true;
        let replay;
        try {
          const t = (await this.repo.tournamentById(tid))!;
          replay = await this.services.media.makeReplay(cam.stream_path, seconds, slowmo, t.production_mode);
        } catch (err) {
          return fail((err as Error).message);
        }
        const r = this.dispatch(tid, 'replay.play', cam.id, client, requestId, {
          url: replay.url,
          durationSec: replay.durationSec,
          returnScene: l.engine.programmeScene,
        });
        if (!r.ok) return fail(r.error);
        await this.services.graphics.setReplay(tid, true).catch(() => {});
        return;
      }
      const r = this.dispatch(tid, action, cam.id, client, requestId, { sceneName: sceneNameFor(cam.stream_path) });
      if (!r.ok) return fail(r.error);
      return;
    }
    if (action === 'stream.start') {
      const gate = this.canDispatch(tid);
      if (!gate.ok) return fail(gate.error);
      const t = await this.repo.tournamentById(tid);
      if (t) {
        const allowed = await this.services.billing.checkGoLive(t);
        if (!allowed.ok) return fail(allowed.error);
        // Facebook needs a live video per stream; create it before OBS starts sending.
        for (const p of await this.services.outputs.prepare(t)) this.alert(tid, 'warning', p);
        this.outputsChanged(tid).catch(() => {});
      }
    }
    const r = this.dispatch(tid, action, null, client, requestId, {});
    if (!r.ok) return fail(r.error);
  }

  /**
   * Keeps the restream relays in step with OBS: start when OBS starts streaming, stop and
   * close the Facebook live video when it stops, and re-check now and then while live
   * (server restart mid-show, a platform switched on or off).
   */
  private async syncRelays(tournamentId: string, was: boolean, now: boolean): Promise<void> {
    const l = this.liveFor(tournamentId);
    const due = Date.now() - l.relayCheckedAt > 10_000;
    if (was === now && !(now && due)) return;
    l.relayCheckedAt = Date.now();
    const t = await this.repo.tournamentById(tournamentId);
    if (!t) return;
    if (was && !now) await this.services.outputs.ended(t);
    else await this.services.outputs.reconcile(t, now);
    if (now) this.resumeCameras(tournamentId);
    // Laptop OBS has no cloud engine to stop: pause the phones a while after the show ends.
    if (was && !now && t.production_mode !== 'cloud') {
      if (l.endTimer) clearTimeout(l.endTimer);
      l.endTimer = setTimeout(() => {
        l.endTimer = null;
        this.pauseCameras(tournamentId, 'The show has ended, so this camera stopped sending. Tap Go live when the director starts the next show.');
      }, this.config.CLOUD_ENGINE_IDLE_STOP_SEC * 1000);
      l.endTimer.unref?.();
    }
    await this.outputsChanged(tournamentId);
    // Viewer comments from YouTube and Facebook are read only while live.
    const fresh = await this.repo.tournamentById(tournamentId);
    if (fresh) await this.services.chatReaders.sync(fresh, now).catch(() => {});
  }

  /** After platform settings change: re-apply while live, and refresh the engine's destination. */
  async outputsUpdated(tournamentId: string): Promise<void> {
    const t = await this.repo.tournamentById(tournamentId);
    if (!t) return;
    const l = this.liveFor(tournamentId);
    if (l.engine.streaming.active) await this.services.outputs.reconcile(t, true);
    else this.toEngine(tournamentId, { type: 'engine.config', ...(await this.engineConfig(t)) });
    await this.outputsChanged(tournamentId);
    // The number of destinations counts against the event's included destinations.
    this.billingChanged(tournamentId, await this.services.billing.tournamentState(t));
  }

  /** Tournaments whose engine is connected and streaming: what billing meters. */
  streamingTournaments(): string[] {
    return [...this.live.entries()].filter(([, l]) => l.engineClient && l.engine.streaming.active).map(([id]) => id);
  }

  /** Chat changed: staff apps refresh (they fetch the feed by version). Throttled to 2/s. */
  private chatTimers = new Map<string, NodeJS.Timeout>();
  chatChanged(tournamentId: string): void {
    if (this.chatTimers.has(tournamentId)) return;
    this.chatTimers.set(
      tournamentId,
      setTimeout(() => {
        this.chatTimers.delete(tournamentId);
        this.toTournament(tournamentId, { type: 'chat' }, 'watch');
      }, 500),
    );
  }

  billingChanged(tournamentId: string, billing: TournamentBilling): void {
    this.toTournament(tournamentId, { type: 'billing', billing }, 'direct');
  }

  /** Ends the broadcast on the server's own decision (credits finished, club suspended). */
  systemStop(tournamentId: string): void {
    const r = this.dispatch(tournamentId, 'stream.stop', null, null, null, {});
    if (!r.ok) this.log.warn({ tournamentId, error: r.error }, 'billing stop failed');
  }

  async outputsChanged(tournamentId: string): Promise<void> {
    const t = await this.repo.tournamentById(tournamentId);
    if (!t) return;
    this.toTournament(tournamentId, { type: 'outputs', outputs: await this.services.outputs.state(t) }, 'direct');
  }

  private async tournament(client: Client, id: unknown): Promise<TournamentRow | null> {
    const t = typeof id === 'string' ? await this.repo.tournamentById(id).catch(() => null) : null;
    if (!t) this.send(client, { type: 'error', code: 'tournament_not_found', message: 'Tournament not found.' });
    return t;
  }

  private forbidden(client: Client, what: string): void {
    this.send(client, { type: 'error', code: 'forbidden', message: `You cannot ${what}.` });
  }

  // ------------------------------------------------------------------ commands
  private canDispatch(tournamentId: string): { ok: true } | { ok: false; error: string } {
    const l = this.liveFor(tournamentId);
    if (!l.engineClient) return { ok: false, error: 'Broadcast engine is offline. Start the OBS agent (laptop) or the cloud engine.' };
    if (!l.engine.obsConnected) return { ok: false, error: 'The engine agent is running but cannot reach OBS.' };
    return { ok: true };
  }

  private dispatch(
    tournamentId: string,
    action: string,
    cameraId: string | null,
    requestedBy: Client | null,
    requestId: string | null,
    extra: Record<string, unknown>,
  ): { ok: true; id: string } | { ok: false; error: string } {
    const gate = this.canDispatch(tournamentId);
    if (!gate.ok) return gate;
    const id = crypto.randomUUID();
    const timeout = action === 'replay.play' ? REPLAY_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
    const timer = setTimeout(() => this.resolveCommand(id, false, 'Broadcast engine did not confirm in time.'), timeout);
    this.pending.set(id, {
      id,
      tournamentId,
      action,
      cameraId,
      requestedBy,
      requestId,
      actor: requestedBy ? principalKey(requestedBy.principal) : 'system',
      timer,
    });
    // V9: every switch to a camera or the fallback screen uses the event's transition (Fade or Slide).
    const sw = this.liveFor(tournamentId).switching;
    const transition = ['take', 'cut', 'fallback'].includes(action) ? { name: OBS_TRANSITION[sw?.transition.style ?? 'fade'], ms: sw?.transition.ms ?? 700 } : undefined;
    this.toEngine(tournamentId, { type: 'command', id, action, cameraId, ...(transition ? { transition } : {}), ...extra });
    return { ok: true, id };
  }

  private resolveCommand(id: string, ok: boolean, error: string | null): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    const action = p.action === 'replay.play' ? 'replay' : p.action;
    if (p.requestedBy) {
      this.send(p.requestedBy, { type: 'command.result', requestId: p.requestId, commandId: id, action, cameraId: p.cameraId, ok, error });
    }
    if (!ok && action === 'replay') void this.services.graphics.setReplay(p.tournamentId, false).catch(() => {});
    this.repo.logSwitch({ tournamentId: p.tournamentId, actor: p.actor, action, cameraId: p.cameraId, ok, error }).catch(() => {});
    if (!ok) this.log.warn({ action, error }, 'engine command failed');
  }

  // ------------------------------------------------------------------ broadcasts
  private broadcastEngine(tournamentId: string): void {
    this.toTournament(tournamentId, { type: 'engine', engine: this.liveFor(tournamentId).engine }, 'watch');
  }

  private broadcastTally(tournamentId: string): void {
    for (const c of this.clients) if (c.tournamentId === tournamentId && c.cameraId) this.sendTally(c);
  }

  private sendTally(c: Client): void {
    if (!c.tournamentId || !c.cameraId) return;
    const e = this.liveFor(c.tournamentId).engine;
    this.send(c, {
      type: 'tally',
      onAir: e.programmeCameraId === c.cameraId && !e.replayActive && !e.fallbackActive,
      preview: e.previewCameraId === c.cameraId,
    });
  }

  /** Camera tiles only (status, telemetry badges) to control rooms: no OBS resync. */
  async pushCameras(tournamentId: string): Promise<void> {
    const [cams, coms] = await Promise.all([this.repo.camerasForTournament(tournamentId), this.repo.commentatorsForTournament(tournamentId)]);
    this.toTournament(
      tournamentId,
      {
        type: 'cameras',
        cameras: cams.map((c) => this.cameraDto(c)),
        commentators: coms.map((m) => this.commentatorDto(m)),
        mediaServer: { reachable: this.health.reachable, error: this.health.error },
      },
      'watch',
    );
  }

  /** After REST changes to cameras/commentators: resync OBS and refresh apps. */
  async camerasChanged(tournamentId: string): Promise<void> {
    const t = await this.repo.tournamentById(tournamentId);
    if (!t) return;
    this.toEngine(tournamentId, { type: 'engine.config', ...(await this.engineConfig(t)) });
    for (const c of this.clients) {
      if (c.tournamentId !== tournamentId || c.isEngine) continue;
      if (c.cameraId) {
        const cam = await this.repo.cameraById(c.cameraId);
        this.send(c, cam ? { type: 'camera.updated', camera: this.cameraDto(cam) } : { type: 'camera.removed' });
      } else if (can(c.role, 'watch')) {
        this.send(c, { type: 'snapshot', ...(await this.snapshot(t, c.role)) });
      }
    }
  }

  /** Engine config changed for non-camera reasons (YouTube broadcast, mode). */
  async engineConfigChanged(tournamentId: string): Promise<void> {
    const t = await this.repo.tournamentById(tournamentId);
    if (t) this.toEngine(tournamentId, { type: 'engine.config', ...(await this.engineConfig(t)) });
  }

  audioChanged(tournamentId: string, audio: AudioState): void {
    this.toEngine(tournamentId, { type: 'engine.audio', audio });
    this.toTournament(tournamentId, { type: 'audio', audio }, 'direct');
  }

  graphicsChanged(tournamentId: string, graphics: GraphicsState): void {
    this.toTournament(tournamentId, { type: 'graphics', graphics }, 'direct');
  }

  async leaderboardChanged(tournamentId: string): Promise<void> {
    const rows = (await this.scoring.leaderboard(tournamentId)).rows.slice(0, 20);
    this.toTournament(tournamentId, { type: 'leaderboard', rows }, 'view');
    await this.services.graphics.publish(tournamentId);
  }

  clipChanged(clip: ClipRow): void {
    this.toTournament(clip.tournament_id, { type: 'clip', clip: clipDto(clip) }, 'direct');
  }

  productionChanged(tournamentId: string, production: ProductionState): void {
    this.toTournament(tournamentId, { type: 'production', production }, 'direct');
  }

  /** Every health poll: push camera health to the control room, run auto-fallback. */
  async onHealth(snap: HealthSnapshot): Promise<void> {
    const wasReachable = this.health.reachable;
    this.health = snap;
    const active = new Set<string>();
    for (const c of this.clients) if (c.tournamentId && !c.isEngine) active.add(c.tournamentId);
    for (const [tid, l] of this.live) if (l.engineClient) active.add(tid);
    for (const tournamentId of active) {
      const t = await this.repo.tournamentById(tournamentId);
      if (!t) continue;
      const [cams, coms] = await Promise.all([this.repo.camerasForTournament(tournamentId), this.repo.commentatorsForTournament(tournamentId)]);
      this.toTournament(
        tournamentId,
        {
          type: 'cameras',
          cameras: cams.map((c) => this.cameraDto(c)),
          commentators: coms.map((m) => this.commentatorDto(m)),
          mediaServer: { reachable: snap.reachable, error: snap.error },
        },
        'watch',
      );
      if (wasReachable && !snap.reachable) this.alert(tournamentId, 'error', `Video ingest server unreachable: ${snap.error ?? 'unknown error'}`);
      this.autoFallback(t, cams);
    }
  }

  /**
   * A camera phone got a call (Android keeps sending video, the sound goes silent) or the app
   * left the screen (iPhone pauses the camera). Alert the director; if it is on air and
   * auto-fallback is on, cut to another working camera (the one in preview first), or to
   * the fallback scene when there is none.
   */
  async cameraInterrupted(tid: string, cameraId: string, why: 'call' | 'paused'): Promise<void> {
    const t = await this.repo.tournamentById(tid);
    if (!t) return;
    const cams = await this.repo.camerasForTournament(tid);
    const cam = cams.find((c) => c.id === cameraId);
    const name = cam?.name ?? 'A camera';
    const what = why === 'call' ? `${name} is on a phone call (video continues, its sound is paused).` : `${name} is paused: the phone left the Go Live app.`;
    const l = this.liveFor(tid);
    const e = l.engine;
    const onAir = e.programmeCameraId === cameraId && !e.fallbackActive && !e.replayActive;
    if (!onAir || !t.auto_fallback || !l.engineClient || !e.obsConnected) {
      this.alert(tid, 'warning', what);
      return;
    }
    const usable = (c: CameraRow) => {
      if (c.id === cameraId || !this.healthFor(c.stream_path).online) return false;
      const tel = this.telemetryFor(tid, c.id);
      return !tel?.inCall && tel?.state !== 'paused';
    };
    const next = cams.find((c) => c.id === e.previewCameraId && usable(c)) ?? cams.find(usable);
    const r = next
      ? this.dispatch(tid, 'cut', next.id, null, null, { sceneName: sceneNameFor(next.stream_path) })
      : this.dispatch(tid, 'fallback', null, null, null, {});
    this.alert(
      tid,
      'warning',
      r.ok ? `${what} Switched the show to ${next ? next.name : 'the fallback scene'} automatically.` : `${what} Could not switch automatically: ${r.error}`,
    );
  }

  private autoFallback(t: TournamentRow, cams: CameraRow[]): void {
    const l = this.liveFor(t.id);
    const prog = l.engine.programmeCameraId;
    if (!t.auto_fallback || !prog || l.engine.fallbackActive || l.engine.replayActive || !l.engineClient || !l.engine.obsConnected) {
      l.programmeOfflineSince = null;
      return;
    }
    if (!this.health.reachable) return;
    const cam = cams.find((c) => c.id === prog);
    if (cam && this.healthFor(cam.stream_path).online) {
      l.programmeOfflineSince = null;
      return;
    }
    const now = Date.now();
    if (l.programmeOfflineSince === null) {
      l.programmeOfflineSince = now;
      return;
    }
    if (now - l.programmeOfflineSince < this.config.AUTO_FALLBACK_GRACE_MS) return;
    if ([...this.pending.values()].some((p) => p.tournamentId === t.id && p.action === 'fallback')) return;
    l.programmeOfflineSince = null;
    const r = this.dispatch(t.id, 'fallback', null, null, null, {});
    this.alert(
      t.id,
      'warning',
      r.ok ? `${cam?.name ?? 'Programme camera'} dropped. Cut to fallback scene automatically.` : `${cam?.name ?? 'Programme camera'} dropped and fallback failed: ${r.error}`,
    );
  }

  private async pollYoutube(): Promise<void> {
    if (!this.services?.youtube.enabled) return;
    const watched = new Set<string>();
    for (const c of this.clients) if (c.tournamentId && can(c.role, 'direct')) watched.add(c.tournamentId);
    for (const tid of watched) {
      const t = await this.repo.tournamentById(tid);
      if (!t?.yt_broadcast_id) continue;
      const l = this.liveFor(tid);
      try {
        const s = await this.services.youtube.status(t);
        l.youtube = { ...l.youtube, ...s, issues: s.issues ?? [], checkedAt: new Date().toISOString(), error: null };
      } catch (err) {
        l.youtube = { ...l.youtube, checkedAt: new Date().toISOString(), error: (err as Error).message.slice(0, 200) };
      }
      this.toTournament(tid, { type: 'youtube', youtube: await this.youtubeState(t) }, 'direct');
    }
  }

  /** For tests. */
  async pollYoutubeNow(): Promise<void> {
    await this.pollYoutube();
  }

  stats() {
    return {
      clients: this.clients.size,
      engines: [...this.live.entries()].filter(([, l]) => l.engineClient).map(([id]) => id),
      pendingCommands: this.pending.size,
    };
  }
}

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : def;
  return Math.min(max, Math.max(min, n));
}

function num(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
}

function str(v: unknown, max = 200): string | null {
  return typeof v === 'string' ? v.slice(0, max) : null;
}

const STATES = new Set(['idle', 'previewing', 'connecting', 'live', 'reconnecting', 'paused', 'error']);

export function sanitizeTelemetry(raw: unknown): CameraTelemetry {
  const r = (raw ?? {}) as Record<string, unknown>;
  const state = typeof r.state === 'string' && STATES.has(r.state) ? (r.state as CameraTelemetry['state']) : 'idle';
  return {
    state,
    bitrateKbps: num(r.bitrateKbps, 0, 1_000_000),
    battery: num(r.battery, 0, 100),
    charging: typeof r.charging === 'boolean' ? r.charging : null,
    durationSec: num(r.durationSec, 0, 1e7),
    appState: r.appState === 'background' ? 'background' : r.appState === 'foreground' ? 'foreground' : null,
    resolution: str(r.resolution, 20),
    fps: num(r.fps, 0, 240),
    thermal: str(r.thermal, 20),
    error: str(r.error),
    micMuted: typeof r.micMuted === 'boolean' ? r.micMuted : null,
    inCall: typeof r.inCall === 'boolean' ? r.inCall : null,
    controls: sanitizeControls(r.controls),
  };
}

/** V9: the phone's zoom, brightness and focus, so the director's sliders show the real values. */
function sanitizeControls(raw: unknown): CameraTelemetry['controls'] {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const n = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
  const zoomMin = n(c.zoomMin, 0.1, 100), zoomMax = n(c.zoomMax, 0.1, 200);
  if (zoomMin == null || zoomMax == null) return null;
  return {
    zoom: n(c.zoom, zoomMin, zoomMax) ?? 1,
    zoomMin,
    zoomMax,
    ev: n(c.ev, -20, 20) ?? 0,
    evMin: n(c.evMin, -20, 0) ?? 0,
    evMax: n(c.evMax, 0, 20) ?? 0,
    evStep: n(c.evStep, 0.01, 5) ?? 0.5,
    autoFocus: typeof c.autoFocus === 'boolean' ? c.autoFocus : true,
    locked: typeof c.locked === 'boolean' ? c.locked : false,
  };
}

function sameControls(a: CameraTelemetry['controls'], b: CameraTelemetry['controls'] | undefined): boolean {
  if (!a || !b) return a === (b ?? null);
  return a.zoom === b.zoom && a.ev === b.ev && a.autoFocus === b.autoFocus && a.locked === b.locked && a.zoomMin === b.zoomMin && a.zoomMax === b.zoomMax && a.evMin === b.evMin && a.evMax === b.evMax && a.evStep === b.evStep;
}
