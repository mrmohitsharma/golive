/**
 * Drives OBS Studio through obs-websocket v5. Every Director action becomes an OBS request,
 * and the programme the Director app shows comes from OBS's own events, never from the
 * last command sent. Same code for a venue laptop and for cloud OBS.
 */

export interface EngineCamera {
  id: string;
  name: string;
  hole: number | null;
  position: string | null;
  streamPath: string;
  sceneName: string;
  inputName: string;
  srtUrl: string;
}

export interface EngineCommentator {
  id: string;
  name: string;
  streamPath: string;
  inputName: string;
  srtUrl: string;
}

export interface AudioState {
  courseDb: number;
  courseMuted: boolean;
  cameras: Record<string, { db: number; muted: boolean }>;
  commentaryDb: number;
  commentaryMuted: boolean;
  ducking: boolean;
  commentaryDelayMs: number;
}

export interface EngineConfig {
  tournamentId: string;
  tournamentName: string;
  mode: 'laptop' | 'cloud';
  fallbackScene: string;
  replayScene: string;
  cameras: EngineCamera[];
  commentators: EngineCommentator[];
  graphicsUrl: string | null;
  /** Where OBS streams: the server's programme ingest (it restreams to YouTube/Facebook/Instagram), or null = use the agent .env / OBS settings. */
  output: { server: string; key: string } | null;
  audio: AudioState;
  canvas: { width: number; height: number; fps: number; videoKbps: number } | null;
  /** What viewers get (both modes, from V7 servers): OBS output height and bitrate, 2 s keyframes. */
  encoder?: { height: number; videoKbps: number } | null;
}

/** The subset of obs-websocket-js we use, so tests can plug in a fake OBS. */
export interface ObsClient {
  call(requestType: string, requestData?: Record<string, unknown>): Promise<any>;
  on(event: string, listener: (data: any) => void): unknown;
}

export interface ObsState {
  obsConnected: boolean;
  obsVersion: string | null;
  programmeScene: string | null;
  previewScene: string | null;
  programmeCameraId: string | null;
  previewCameraId: string | null;
  fallbackActive: boolean;
  replayActive: boolean;
  studioMode: boolean;
  streaming: {
    active: boolean;
    reconnecting: boolean;
    timecode: string | null;
    kbps: number | null;
    congestion: number | null;
    skippedFrames: number | null;
    totalFrames: number | null;
  };
  warnings: string[];
  lastError: string | null;
  /** What OBS sends (output size, bitrate if known): the server passes a 720p programme straight through. */
  video: { outputWidth: number; outputHeight: number; kbps: number | null } | null;
}

export const ADVANCED_OUTPUT_WARNING = 'OBS uses Advanced output: set the stream to 1280x720, 2500 kbps, keyframe every 2 s (or switch Output to Simple) to save server and viewer costs';

export const SCENE_PREFIX = 'CG cam-';
export const FEED_SUFFIX = ' Feed';
export const GRAPHICS_INPUT = 'CG Graphics';
/**
 * Shared layers (commentary audio + graphics) live in ONE nested scene that every programme
 * scene references. In Studio Mode OBS puts a duplicate of the scene on air at each cut, so
 * sources added to a camera scene later would not be heard/seen until the next cut; the
 * duplicate references the same nested scene, so changes inside it are live immediately.
 */
export const LAYERS_SCENE = 'CG Layers';
export const COMMENTARY_PREFIX = 'CG Commentary ';
export const REPLAY_INPUT = 'CG Replay Clip';
export const DUCK_FILTER = 'CG Duck';
const FALLBACK_BG = 'CG Fallback Background';
const FALLBACK_TEXT = 'CG Fallback Text';
const TEXT_KINDS = ['text_gdiplus_v3', 'text_gdiplus_v2', 'text_ft2_source_v2', 'text_ft2_source'];
const COLOR_KINDS = ['color_source_v3', 'color_source_v2', 'color_source'];
const BROWSER_KIND = 'browser_source';
const NO_BROWSER_WARNING = 'This OBS has no Browser Source, so graphics (scores, lower thirds) are off. Install OBS from obsproject.com.';

export function feedInputSettings(srtUrl: string) {
  return {
    is_local_file: false,
    input: srtUrl,
    input_format: 'mpegts',
    reconnect_delay_sec: 2,
    buffering_mb: 1,
    hw_decode: true,
    // Keep every camera connected so a cut is instant (costs laptop download bandwidth;
    // see docs/DEPLOYMENT.md "Laptop sizing").
    close_when_inactive: false,
    restart_on_activate: false,
    clear_on_media_end: false,
    looping: false,
  };
}

export function commentaryInputSettings(srtUrl: string) {
  return { ...feedInputSettings(srtUrl), hw_decode: false };
}

export function replayInputSettings(url: string) {
  return {
    is_local_file: false,
    input: url,
    reconnect_delay_sec: 1,
    buffering_mb: 4,
    hw_decode: true,
    close_when_inactive: true,
    restart_on_activate: true,
    clear_on_media_end: false,
    looping: false,
  };
}

const DEFAULT_AUDIO: AudioState = { courseDb: 0, courseMuted: false, cameras: {}, commentaryDb: 0, commentaryMuted: false, ducking: true, commentaryDelayMs: 0 };

export class ObsController {
  private config: EngineConfig | null = null;
  private canvas = { width: 1920, height: 1080 };
  private lastBytes: { bytes: number; at: number } | null = null;
  private inputKinds: string[] = [];
  private replayReturnScene: string | null = null;
  private replayTimer: NodeJS.Timeout | null = null;
  private lastMeters = 0;
  public state: ObsState = {
    obsConnected: false,
    obsVersion: null,
    programmeScene: null,
    previewScene: null,
    programmeCameraId: null,
    previewCameraId: null,
    fallbackActive: false,
    replayActive: false,
    studioMode: false,
    streaming: { active: false, reconnecting: false, timecode: null, kbps: null, congestion: null, skippedFrames: null, totalFrames: null },
    warnings: [],
    lastError: null,
    video: null,
  };

  constructor(
    private readonly obs: ObsClient,
    private readonly opts: { fallbackText: string; youtubeStreamKey?: string; youtubeServer?: string },
    private readonly onChange: () => void,
    private readonly log: (msg: string) => void = () => {},
    private readonly onMeters: (levels: Record<string, number>) => void = () => {},
  ) {
    obs.on('CurrentProgramSceneChanged', (d) => this.setScenes(d.sceneName, this.state.previewScene));
    obs.on('CurrentPreviewSceneChanged', (d) => this.setScenes(this.state.programmeScene, d.sceneName));
    obs.on('StudioModeStateChanged', (d) => {
      this.state.studioMode = Boolean(d.studioModeEnabled);
      if (!this.state.studioMode) this.setScenes(this.state.programmeScene, null);
      else this.onChange();
    });
    obs.on('StreamStateChanged', (d) => {
      this.state.streaming.active = Boolean(d.outputActive);
      this.state.streaming.reconnecting = d.outputState === 'OBS_WEBSOCKET_OUTPUT_RECONNECTING';
      this.onChange();
    });
    obs.on('MediaInputPlaybackEnded', (d) => {
      if (d.inputName === REPLAY_INPUT && this.state.replayActive) void this.endReplay('replay finished');
    });
    obs.on('InputVolumeMeters', (d) => this.meters(d));
  }

  private get fallbackScene() {
    return this.config?.fallbackScene ?? 'CG Fallback';
  }
  private get replayScene() {
    return this.config?.replayScene ?? 'CG Replay';
  }
  private get cameras(): EngineCamera[] {
    return this.config?.cameras ?? [];
  }
  private get commentators(): EngineCommentator[] {
    return this.config?.commentators ?? [];
  }

  private setScenes(programme: string | null, preview: string | null): void {
    this.state.programmeScene = programme;
    this.state.previewScene = preview;
    this.state.programmeCameraId = this.cameraForScene(programme);
    this.state.previewCameraId = this.cameraForScene(preview);
    this.state.fallbackActive = programme === this.fallbackScene;
    const wasReplay = this.state.replayActive;
    this.state.replayActive = programme === this.replayScene;
    if (wasReplay && !this.state.replayActive && this.replayTimer) {
      clearTimeout(this.replayTimer);
      this.replayTimer = null;
    }
    this.onChange();
  }

  private cameraForScene(scene: string | null): string | null {
    if (!scene) return null;
    return this.cameras.find((c) => c.sceneName === scene)?.id ?? null;
  }

  /** Called once the obs-websocket connection is identified. */
  async onConnected(): Promise<void> {
    const v = await this.obs.call('GetVersion');
    this.state.obsVersion = `${v.obsVersion} (ws ${v.obsWebSocketVersion})`;
    this.inputKinds = (await this.obs.call('GetInputKindList', { unversioned: false })).inputKinds ?? [];
    const vs = await this.obs.call('GetVideoSettings');
    this.canvas = { width: vs.baseWidth, height: vs.baseHeight };
    const studio = await this.obs.call('GetStudioModeEnabled');
    if (!studio.studioModeEnabled) await this.obs.call('SetStudioModeEnabled', { studioModeEnabled: true });
    this.state.studioMode = true;
    this.state.obsConnected = true;
    this.state.lastError = null;
    this.state.warnings = this.inputKinds.includes(BROWSER_KIND) ? [] : [NO_BROWSER_WARNING];
    await this.applyStreamDestination();
    if (this.config) await this.sync(this.config);
    else await this.ensureFallbackScene();
    await this.refreshScenes();
    await this.refreshStream();
  }

  onDisconnected(reason: string): void {
    this.state.obsConnected = false;
    this.state.lastError = `OBS connection lost: ${reason}`;
    this.onChange();
  }

  async refreshScenes(): Promise<void> {
    const list = await this.obs.call('GetSceneList');
    this.setScenes(list.currentProgramSceneName ?? null, list.currentPreviewSceneName ?? null);
  }

  async refreshStream(): Promise<void> {
    const s = await this.obs.call('GetStreamStatus');
    const now = Date.now();
    let kbps: number | null = null;
    if (s.outputActive && this.lastBytes && now > this.lastBytes.at && s.outputBytes >= this.lastBytes.bytes) {
      kbps = Math.round(((s.outputBytes - this.lastBytes.bytes) * 8) / (now - this.lastBytes.at));
    }
    this.lastBytes = s.outputActive ? { bytes: s.outputBytes, at: now } : null;
    this.state.streaming = {
      active: Boolean(s.outputActive),
      reconnecting: Boolean(s.outputReconnecting),
      timecode: s.outputTimecode ?? null,
      kbps,
      congestion: typeof s.outputCongestion === 'number' ? Math.round(s.outputCongestion * 100) / 100 : null,
      skippedFrames: s.outputSkippedFrames ?? null,
      totalFrames: s.outputTotalFrames ?? null,
    };
  }

  /** YouTube destination: from the server (Connect YouTube), else the laptop's .env key, else OBS's own settings. */
  private async applyStreamDestination(): Promise<void> {
    const out = this.config?.output ?? (this.opts.youtubeStreamKey ? { server: this.opts.youtubeServer!, key: this.opts.youtubeStreamKey } : null);
    if (!out || this.state.streaming.active) return;
    // An srt:// server makes OBS send MPEG-TS over SRT (OBS 28+); rtmp(s):// sends FLV.
    await this.obs.call('SetStreamServiceSettings', { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: out.server, key: out.key } });
  }

  /** Cloud mode: the server sets the canvas and encoder (a laptop operator keeps their own). */
  private async applyCanvas(): Promise<void> {
    const c = this.config?.canvas;
    if (!c || this.state.streaming.active) return;
    if (this.canvas.width !== c.width || this.canvas.height !== c.height) {
      await this.obs.call('SetVideoSettings', {
        baseWidth: c.width,
        baseHeight: c.height,
        outputWidth: c.width,
        outputHeight: c.height,
        fpsNumerator: c.fps,
        fpsDenominator: 1,
      });
      this.canvas = { width: c.width, height: c.height };
    }
    const p = (parameterCategory: string, parameterName: string, parameterValue: string) =>
      this.obs.call('SetProfileParameter', { parameterCategory, parameterName, parameterValue });
    await p('Output', 'Mode', 'Simple');
    await p('SimpleOutput', 'VBitrate', String(c.videoKbps));
    await p('SimpleOutput', 'ABitrate', '160');
    await p('SimpleOutput', 'StreamEncoder', 'x264');
    await p('SimpleOutput', 'Preset', 'veryfast');
    // 2-second keyframes, as YouTube requires (Simple output passes these to x264 as x264opts).
    await p('SimpleOutput', 'UseAdvanced', 'true');
    await p('SimpleOutput', 'x264Settings', `keyint=${c.fps * 2} min-keyint=${c.fps}`);
  }

  /**
   * Both modes: OBS scales its output (not the canvas the scenes are laid out on) to the
   * server's programme size, 720p, at its bitrate with 2 s keyframes, so the server can pass it
   * straight to YouTube and the watch player without re-encoding. OBS in Advanced output mode
   * is left alone with a warning (the server then re-encodes). While streaming, only reports.
   */
  private async applyEncoder(): Promise<void> {
    const e = this.config?.encoder;
    if (!e) return;
    const vs = await this.obs.call('GetVideoSettings');
    const fps = Math.round((vs.fpsNumerator || 30) / (vs.fpsDenominator || 1));
    const height = Math.min(e.height, vs.baseHeight);
    const width = Math.round((height * (vs.baseWidth / vs.baseHeight)) / 2) * 2;
    const live = this.state.streaming.active;
    if (!live && (vs.outputWidth !== width || vs.outputHeight !== height)) {
      await this.obs.call('SetVideoSettings', {
        baseWidth: vs.baseWidth,
        baseHeight: vs.baseHeight,
        outputWidth: width,
        outputHeight: height,
        fpsNumerator: vs.fpsNumerator,
        fpsDenominator: vs.fpsDenominator,
      });
    }
    const get = async (parameterCategory: string, parameterName: string): Promise<string | null> => {
      try {
        return (await this.obs.call('GetProfileParameter', { parameterCategory, parameterName })).parameterValue ?? null;
      } catch {
        return null;
      }
    };
    const mode = (await get('Output', 'Mode')) ?? 'Simple';
    let kbps: number | null = null;
    this.state.warnings = this.state.warnings.filter((w) => w !== ADVANCED_OUTPUT_WARNING);
    if (mode === 'Simple') {
      if (!live) {
        const p = (parameterCategory: string, parameterName: string, parameterValue: string) =>
          this.obs.call('SetProfileParameter', { parameterCategory, parameterName, parameterValue });
        await p('SimpleOutput', 'VBitrate', String(e.videoKbps));
        await p('SimpleOutput', 'UseAdvanced', 'true');
        await p('SimpleOutput', 'x264Settings', `keyint=${fps * 2} min-keyint=${fps}`);
        kbps = e.videoKbps;
      } else kbps = Number(await get('SimpleOutput', 'VBitrate')) || null;
    } else this.state.warnings = [...this.state.warnings, ADVANCED_OUTPUT_WARNING];
    const now = live ? await this.obs.call('GetVideoSettings') : { outputWidth: width, outputHeight: height };
    this.state.video = { outputWidth: now.outputWidth, outputHeight: now.outputHeight, kbps };
  }

  private async pickKind(candidates: string[]): Promise<string> {
    const found = candidates.find((k) => this.inputKinds.includes(k));
    if (!found) throw new Error(`OBS has none of these source types: ${candidates.join(', ')}`);
    return found;
  }

  private async sceneNames(): Promise<Set<string>> {
    const list = await this.obs.call('GetSceneList');
    return new Set((list.scenes as { sceneName: string }[]).map((s) => s.sceneName));
  }

  private async inputNames(): Promise<Set<string>> {
    const list = await this.obs.call('GetInputList');
    return new Set((list.inputs as { inputName: string }[]).map((i) => i.inputName));
  }

  private async fitToCanvas(sceneName: string, sceneItemId: number): Promise<void> {
    await this.obs.call('SetSceneItemTransform', {
      sceneName,
      sceneItemId,
      sceneItemTransform: {
        positionX: 0,
        positionY: 0,
        alignment: 5,
        boundsType: 'OBS_BOUNDS_SCALE_INNER',
        boundsAlignment: 0,
        boundsWidth: this.canvas.width,
        boundsHeight: this.canvas.height,
      },
    });
  }

  async ensureFallbackScene(): Promise<void> {
    const scenes = await this.sceneNames();
    if (scenes.has(this.fallbackScene)) return;
    await this.obs.call('CreateScene', { sceneName: this.fallbackScene });
    const inputs = await this.inputNames();
    if (!inputs.has(FALLBACK_BG)) {
      const bg = await this.obs.call('CreateInput', {
        sceneName: this.fallbackScene,
        inputName: FALLBACK_BG,
        inputKind: await this.pickKind(COLOR_KINDS),
        inputSettings: { color: 0xff1d3b2a, width: this.canvas.width, height: this.canvas.height },
      });
      await this.fitToCanvas(this.fallbackScene, bg.sceneItemId);
    }
    if (!inputs.has(FALLBACK_TEXT)) {
      const kind = await this.pickKind(TEXT_KINDS);
      const size = Math.round(this.canvas.height / 11);
      const settings: Record<string, unknown> = kind.startsWith('text_gdiplus')
        ? { text: this.opts.fallbackText, font: { face: 'Arial', size, style: 'Bold' }, color: 0xffffffff, align: 'center' }
        : { text: this.opts.fallbackText, font: { face: 'Sans Serif', size, style: 'Bold' }, color1: 0xffffffff, color2: 0xffffffff };
      const t = await this.obs.call('CreateInput', { sceneName: this.fallbackScene, inputName: FALLBACK_TEXT, inputKind: kind, inputSettings: settings });
      await this.obs.call('SetSceneItemTransform', {
        sceneName: this.fallbackScene,
        sceneItemId: t.sceneItemId,
        sceneItemTransform: { alignment: 0, positionX: this.canvas.width / 2, positionY: this.canvas.height / 2 },
      });
    }
    this.log(`created fallback scene "${this.fallbackScene}"`);
  }

  private async ensureReplayScene(scenes: Set<string>, inputs: Set<string>): Promise<void> {
    if (!scenes.has(this.replayScene)) await this.obs.call('CreateScene', { sceneName: this.replayScene });
    if (!inputs.has(REPLAY_INPUT)) {
      const r = await this.obs.call('CreateInput', {
        sceneName: this.replayScene,
        inputName: REPLAY_INPUT,
        inputKind: 'ffmpeg_source',
        inputSettings: replayInputSettings(''),
      });
      await this.fitToCanvas(this.replayScene, r.sceneItemId);
    }
  }

  /** The graphics overlay: one Browser Source in the shared layers scene (on top of every programme scene). */
  private async ensureGraphics(inputs: Set<string>): Promise<boolean> {
    const url = this.config?.graphicsUrl;
    if (!url || !this.inputKinds.includes(BROWSER_KIND)) return false;
    const settings = { url, width: this.canvas.width, height: this.canvas.height, fps: 30, reroute_audio: false, shutdown: false, restart_when_active: false };
    if (!inputs.has(GRAPHICS_INPUT)) {
      await this.obs.call('CreateInput', { sceneName: LAYERS_SCENE, inputName: GRAPHICS_INPUT, inputKind: BROWSER_KIND, inputSettings: settings });
    } else {
      const cur = await this.obs.call('GetInputSettings', { inputName: GRAPHICS_INPUT });
      if (cur.inputSettings?.url !== url) await this.obs.call('SetInputSettings', { inputName: GRAPHICS_INPUT, inputSettings: settings, overlay: true });
    }
    return true;
  }

  /** Commentary: one audio input per commentator (SRT read of their WHIP stream), in the shared layers scene. */
  private async ensureCommentary(inputs: Set<string>): Promise<void> {
    const wanted = new Set(this.commentators.map((c) => c.inputName));
    for (const c of this.commentators) {
      if (!inputs.has(c.inputName)) {
        await this.obs.call('CreateInput', {
          sceneName: LAYERS_SCENE,
          inputName: c.inputName,
          inputKind: 'ffmpeg_source',
          inputSettings: commentaryInputSettings(c.srtUrl),
        });
      } else {
        const cur = await this.obs.call('GetInputSettings', { inputName: c.inputName });
        if (cur.inputSettings?.input !== c.srtUrl) {
          await this.obs.call('SetInputSettings', { inputName: c.inputName, inputSettings: commentaryInputSettings(c.srtUrl), overlay: true });
        }
      }
    }
    for (const name of inputs) {
      if (name.startsWith(COMMENTARY_PREFIX) && !wanted.has(name)) await this.obs.call('RemoveInput', { inputName: name }).catch(() => {});
    }
  }

  /** Every programme scene gets one reference to the shared layers scene, on top. */
  private async ensureLayers(sceneName: string): Promise<void> {
    const items = (await this.obs.call('GetSceneItemList', { sceneName })).sceneItems as {
      sourceName: string;
      sceneItemId: number;
      sceneItemIndex: number;
    }[];
    const layer = items.find((i) => i.sourceName === LAYERS_SCENE);
    if (!layer) {
      await this.obs.call('CreateSceneItem', { sceneName, sourceName: LAYERS_SCENE, sceneItemEnabled: true });
      return;
    }
    const top = Math.max(...items.map((i) => i.sceneItemIndex));
    if (layer.sceneItemIndex !== top) await this.obs.call('SetSceneItemIndex', { sceneName, sceneItemId: layer.sceneItemId, sceneItemIndex: top });
  }

  /**
   * Makes OBS match the server's configuration: one scene per camera (SRT Media Source
   * filling the canvas), commentary, replay and fallback scenes, graphics and audio.
   * Removes scenes for deleted cameras, never the one on air.
   */
  async sync(config: EngineConfig): Promise<{ created: number; updated: number; removed: number }> {
    this.config = config;
    const result = { created: 0, updated: 0, removed: 0 };
    if (!this.state.obsConnected) return result;
    await this.applyCanvas();
    await this.applyEncoder();
    await this.applyStreamDestination();
    await this.ensureFallbackScene();
    let scenes = await this.sceneNames();
    let inputs = await this.inputNames();
    if (!scenes.has(LAYERS_SCENE)) await this.obs.call('CreateScene', { sceneName: LAYERS_SCENE });
    await this.ensureCommentary(inputs);
    await this.ensureGraphics(inputs);
    await this.ensureReplayScene(scenes, inputs);
    scenes = await this.sceneNames();
    inputs = await this.inputNames();
    for (const cam of config.cameras) {
      if (!scenes.has(cam.sceneName)) {
        await this.obs.call('CreateScene', { sceneName: cam.sceneName });
        result.created++;
      }
      if (!inputs.has(cam.inputName)) {
        const r = await this.obs.call('CreateInput', {
          sceneName: cam.sceneName,
          inputName: cam.inputName,
          inputKind: 'ffmpeg_source',
          inputSettings: feedInputSettings(cam.srtUrl),
        });
        await this.fitToCanvas(cam.sceneName, r.sceneItemId);
      } else {
        const cur = await this.obs.call('GetInputSettings', { inputName: cam.inputName });
        if (cur.inputSettings?.input !== cam.srtUrl) {
          await this.obs.call('SetInputSettings', { inputName: cam.inputName, inputSettings: feedInputSettings(cam.srtUrl), overlay: true });
          result.updated++;
        }
      }
    }
    for (const s of [...config.cameras.map((c) => c.sceneName), this.fallbackScene, this.replayScene]) await this.ensureLayers(s);
    const wanted = new Set(config.cameras.map((c) => c.sceneName));
    for (const name of scenes) {
      if (!name.startsWith(SCENE_PREFIX) || wanted.has(name) || name === this.state.programmeScene) continue;
      await this.obs.call('RemoveScene', { sceneName: name }).catch(() => {});
      await this.obs.call('RemoveInput', { inputName: name + FEED_SUFFIX }).catch(() => {});
      result.removed++;
    }
    await this.applyAudio(config.audio);
    await this.refreshScenes();
    return result;
  }

  /** Course audio (camera feeds) and commentary levels, mutes, sync delay and ducking. */
  async applyAudio(audio: AudioState = DEFAULT_AUDIO): Promise<void> {
    if (this.config) this.config.audio = audio;
    if (!this.state.obsConnected) return;
    const clampDb = (v: number) => Math.max(-100, Math.min(26, v));
    const duckSource = this.commentators[0]?.inputName ?? null;
    for (const cam of this.cameras) {
      const trim = audio.cameras[cam.id] ?? { db: 0, muted: false };
      await this.obs.call('SetInputVolume', { inputName: cam.inputName, inputVolumeDb: clampDb(audio.courseDb + trim.db) }).catch(() => {});
      await this.obs.call('SetInputMute', { inputName: cam.inputName, inputMuted: audio.courseMuted || trim.muted }).catch(() => {});
      await this.ensureDucking(cam.inputName, duckSource, audio.ducking).catch((err) => this.log(`ducking on ${cam.inputName}: ${(err as Error).message}`));
    }
    for (const c of this.commentators) {
      await this.obs.call('SetInputVolume', { inputName: c.inputName, inputVolumeDb: clampDb(audio.commentaryDb) }).catch(() => {});
      await this.obs.call('SetInputMute', { inputName: c.inputName, inputMuted: audio.commentaryMuted }).catch(() => {});
      await this.obs.call('SetInputAudioSyncOffset', { inputName: c.inputName, inputAudioSyncOffset: audio.commentaryDelayMs }).catch(() => {});
    }
  }

  /** Sidechain compressor on a camera feed keyed by the commentator: course audio dips while they talk. */
  private async ensureDucking(inputName: string, sidechain: string | null, enabled: boolean): Promise<void> {
    const filters = (await this.obs.call('GetSourceFilterList', { sourceName: inputName })).filters as { filterName: string }[];
    const has = filters.some((f) => f.filterName === DUCK_FILTER);
    if (!sidechain) {
      if (has) await this.obs.call('SetSourceFilterEnabled', { sourceName: inputName, filterName: DUCK_FILTER, filterEnabled: false });
      return;
    }
    const settings = { ratio: 8, threshold: -32, attack_time: 10, release_time: 450, output_gain: 0, sidechain_source: sidechain };
    if (!has) {
      await this.obs.call('CreateSourceFilter', { sourceName: inputName, filterName: DUCK_FILTER, filterKind: 'compressor_filter', filterSettings: settings });
    } else {
      await this.obs.call('SetSourceFilterSettings', { sourceName: inputName, filterName: DUCK_FILTER, filterSettings: settings, overlay: true });
    }
    await this.obs.call('SetSourceFilterEnabled', { sourceName: inputName, filterName: DUCK_FILTER, filterEnabled: enabled });
  }

  private sceneFor(cameraId: string | null, sceneName: string | null): string {
    const cam = this.cameras.find((c) => c.id === cameraId);
    const scene = cam?.sceneName ?? sceneName;
    if (!scene) throw new Error('Unknown camera for this tournament. Refresh the camera list.');
    return scene;
  }

  private async playReplay(url: string, durationSec: number, returnScene: string | null): Promise<void> {
    if (!url) throw new Error('No replay file.');
    const scenes = await this.sceneNames();
    const inputs = await this.inputNames();
    await this.ensureReplayScene(scenes, inputs);
    await this.obs.call('SetInputSettings', { inputName: REPLAY_INPUT, inputSettings: replayInputSettings(url), overlay: true });
    this.replayReturnScene = returnScene && returnScene !== this.replayScene ? returnScene : this.state.programmeScene;
    await this.obs.call('SetCurrentProgramScene', { sceneName: this.replayScene });
    await this.obs.call('TriggerMediaInputAction', { inputName: REPLAY_INPUT, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' });
    if (this.replayTimer) clearTimeout(this.replayTimer);
    // Safety net if OBS never reports the end of the clip.
    this.replayTimer = setTimeout(() => void this.endReplay('replay timeout'), (durationSec + 6) * 1000);
  }

  private async endReplay(reason: string): Promise<void> {
    if (this.replayTimer) clearTimeout(this.replayTimer);
    this.replayTimer = null;
    if (this.state.programmeScene !== this.replayScene) return;
    const back = this.replayReturnScene && this.replayReturnScene !== this.replayScene ? this.replayReturnScene : this.fallbackScene;
    this.log(`${reason}: back to ${back}`);
    await this.obs.call('SetCurrentProgramScene', { sceneName: back }).catch((err) => this.log(`return from replay failed: ${(err as Error).message}`));
  }

  async execute(action: string, cameraId: string | null, extra: Record<string, unknown> = {}): Promise<void> {
    if (!this.state.obsConnected) throw new Error('OBS is not connected.');
    const sceneName = typeof extra.sceneName === 'string' ? extra.sceneName : null;
    switch (action) {
      case 'preview': {
        if (!this.state.studioMode) await this.obs.call('SetStudioModeEnabled', { studioModeEnabled: true });
        await this.obs.call('SetCurrentPreviewScene', { sceneName: this.sceneFor(cameraId, sceneName) });
        return;
      }
      case 'take':
      case 'cut':
        await this.obs.call('SetCurrentProgramScene', { sceneName: this.sceneFor(cameraId, sceneName) });
        return;
      case 'fallback':
        await this.ensureFallbackScene();
        await this.obs.call('SetCurrentProgramScene', { sceneName: this.fallbackScene });
        return;
      case 'replay.play':
        await this.playReplay(String(extra.url ?? ''), Number(extra.durationSec ?? 10), (extra.returnScene as string | null) ?? null);
        return;
      case 'stream.start':
        await this.applyStreamDestination();
        await this.obs.call('StartStream');
        return;
      case 'stream.stop':
        await this.obs.call('StopStream');
        return;
      default:
        throw new Error(`Unsupported action ${action}`);
    }
  }

  /** InputVolumeMeters (about 20/s) → peak dB per input, 4 times a second. */
  private meters(d: { inputs?: { inputName: string; inputLevelsMul?: number[][] }[] }): void {
    const now = Date.now();
    if (now - this.lastMeters < 250) return;
    this.lastMeters = now;
    const ours = new Set([...this.cameras.map((c) => c.inputName), ...this.commentators.map((c) => c.inputName)]);
    const levels: Record<string, number> = {};
    for (const i of d.inputs ?? []) {
      if (!ours.has(i.inputName)) continue;
      const peak = Math.max(0, ...(i.inputLevelsMul ?? []).map((ch) => ch[1] ?? 0));
      levels[i.inputName] = peak > 0 ? Math.max(-60, Math.round(20 * Math.log10(peak) * 10) / 10) : -60;
    }
    if (Object.keys(levels).length) this.onMeters(levels);
  }
}
