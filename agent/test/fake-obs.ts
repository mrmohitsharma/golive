import { EventEmitter } from 'node:events';
import type { ObsClient } from '../src/obs.js';

/**
 * In-memory stand-in for OBS + obs-websocket v5 for fast unit tests. Implements the
 * requests the agent uses with the same names and response fields, and emits the same
 * events. (The real-OBS test in obs-real.test.ts runs the same code against OBS itself.)
 */
export class FakeObs implements ObsClient {
  private em = new EventEmitter();
  scenes = new Map<string, { items: { id: number; input: string }[] }>();
  inputs = new Map<string, { kind: string; settings: Record<string, unknown>; volumeDb: number; muted: boolean; syncOffset: number; filters: Map<string, { kind: string; settings: any; enabled: boolean }> }>();
  program = 'Scene';
  preview: string | null = null;
  studio = false;
  streaming = false;
  bytes = 0;
  calls: { type: string; data?: any }[] = [];
  failNext: string | null = null;
  kinds = ['ffmpeg_source', 'color_source_v3', 'text_ft2_source_v2', 'browser_source'];
  video = { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 30, fpsDenominator: 1 };
  profile: Record<string, string> = {};
  mediaRestarts: string[] = [];
  private nextId = 1;
  streamService: any = null;

  constructor() {
    this.scenes.set('Scene', { items: [] });
  }

  on(event: string, listener: (d: any) => void) {
    this.em.on(event, listener);
    return this;
  }

  emit(event: string, data?: any) {
    this.em.emit(event, data);
  }

  itemsIn(scene: string): string[] {
    return this.scenes.get(scene)?.items.map((i) => i.input) ?? [];
  }

  private err(msg: string): never {
    const e = new Error(msg) as Error & { code: number };
    e.code = 600;
    throw e;
  }

  private input(name: string) {
    return this.inputs.get(name) ?? this.err(`No source was found by the name of \`${name}\`.`);
  }

  async call(type: string, data: any = {}): Promise<any> {
    this.calls.push({ type, data });
    if (this.failNext === type) {
      this.failNext = null;
      this.err(`${type} failed (simulated)`);
    }
    switch (type) {
      case 'GetVersion':
        return { obsVersion: '31.0.0', obsWebSocketVersion: '5.5.0' };
      case 'GetVideoSettings':
        return { ...this.video };
      case 'SetVideoSettings':
        if (this.streaming) this.err('Video settings cannot be changed while an output is active.');
        Object.assign(this.video, data);
        return;
      case 'GetProfileParameter': {
        const k = `${data.parameterCategory}.${data.parameterName}`;
        const d: Record<string, string> = { 'Output.Mode': 'Simple', 'SimpleOutput.VBitrate': '2500' };
        return { parameterValue: this.profile[k] ?? d[k] ?? null, defaultParameterValue: d[k] ?? null };
      }
      case 'SetProfileParameter':
        this.profile[`${data.parameterCategory}.${data.parameterName}`] = data.parameterValue;
        return;
      case 'GetStudioModeEnabled':
        return { studioModeEnabled: this.studio };
      case 'SetStudioModeEnabled':
        this.studio = data.studioModeEnabled;
        this.preview = this.studio ? this.program : null;
        this.emit('StudioModeStateChanged', { studioModeEnabled: this.studio });
        return;
      case 'GetSceneList':
        return {
          currentProgramSceneName: this.program,
          currentPreviewSceneName: this.studio ? this.preview : null,
          scenes: [...this.scenes.keys()].map((sceneName, i) => ({ sceneName, sceneIndex: i })),
        };
      case 'CreateScene':
        if (this.scenes.has(data.sceneName)) this.err('scene exists');
        this.scenes.set(data.sceneName, { items: [] });
        return { sceneUuid: 'x' };
      case 'RemoveScene':
        if (!this.scenes.has(data.sceneName)) this.err('no scene');
        this.scenes.delete(data.sceneName);
        return;
      case 'GetInputList':
        return { inputs: [...this.inputs.keys()].map((inputName) => ({ inputName })) };
      case 'GetInputKindList':
        return { inputKinds: this.kinds };
      case 'CreateInput': {
        if (this.inputs.has(data.inputName)) this.err('input exists');
        if (!this.kinds.includes(data.inputKind)) this.err(`unknown kind ${data.inputKind}`);
        const scene = this.scenes.get(data.sceneName) ?? this.err('no scene');
        this.inputs.set(data.inputName, { kind: data.inputKind, settings: { ...data.inputSettings }, volumeDb: 0, muted: false, syncOffset: 0, filters: new Map() });
        const id = this.nextId++;
        scene.items.push({ id, input: data.inputName });
        return { inputUuid: 'u', sceneItemId: id };
      }
      case 'RemoveInput':
        if (!this.inputs.delete(data.inputName)) this.err('no input');
        for (const s of this.scenes.values()) s.items = s.items.filter((i) => i.input !== data.inputName);
        return;
      case 'GetInputSettings':
        return { inputKind: this.input(data.inputName).kind, inputSettings: this.input(data.inputName).settings };
      case 'SetInputSettings': {
        const i = this.input(data.inputName);
        i.settings = data.overlay === false ? { ...data.inputSettings } : { ...i.settings, ...data.inputSettings };
        return;
      }
      case 'GetSceneItemList': {
        const s = this.scenes.get(data.sceneName) ?? this.err('no scene');
        return { sceneItems: s.items.map((it, idx) => ({ sourceName: it.input, sceneItemId: it.id, sceneItemIndex: idx })) };
      }
      case 'CreateSceneItem': {
        const s = this.scenes.get(data.sceneName) ?? this.err('no scene');
        if (!this.inputs.has(data.sourceName) && !this.scenes.has(data.sourceName)) this.err('no source');
        const id = this.nextId++;
        s.items.push({ id, input: data.sourceName });
        return { sceneItemId: id };
      }
      case 'SetSceneItemIndex': {
        const s = this.scenes.get(data.sceneName) ?? this.err('no scene');
        const idx = s.items.findIndex((i) => i.id === data.sceneItemId);
        const [it] = s.items.splice(idx, 1);
        s.items.splice(data.sceneItemIndex, 0, it);
        return;
      }
      case 'SetSceneItemTransform':
        return;
      case 'SetInputVolume':
        this.input(data.inputName).volumeDb = data.inputVolumeDb;
        return;
      case 'SetInputMute':
        this.input(data.inputName).muted = data.inputMuted;
        return;
      case 'SetInputAudioSyncOffset':
        this.input(data.inputName).syncOffset = data.inputAudioSyncOffset;
        return;
      case 'GetSourceFilterList':
        return { filters: [...this.input(data.sourceName).filters.keys()].map((filterName) => ({ filterName })) };
      case 'CreateSourceFilter': {
        const i = this.input(data.sourceName);
        if (i.filters.has(data.filterName)) this.err('filter exists');
        i.filters.set(data.filterName, { kind: data.filterKind, settings: { ...data.filterSettings }, enabled: true });
        return;
      }
      case 'SetSourceFilterSettings': {
        const f = this.input(data.sourceName).filters.get(data.filterName) ?? this.err('no filter');
        f.settings = { ...f.settings, ...data.filterSettings };
        return;
      }
      case 'SetSourceFilterEnabled': {
        const f = this.input(data.sourceName).filters.get(data.filterName) ?? this.err('no filter');
        f.enabled = data.filterEnabled;
        return;
      }
      case 'TriggerMediaInputAction':
        this.input(data.inputName);
        this.mediaRestarts.push(data.inputName);
        return;
      case 'SetCurrentPreviewScene':
        if (!this.studio) this.err('Studio mode is not enabled.');
        if (!this.scenes.has(data.sceneName)) this.err(`No source was found by the name of \`${data.sceneName}\`.`);
        this.preview = data.sceneName;
        this.emit('CurrentPreviewSceneChanged', { sceneName: data.sceneName });
        return;
      case 'SetCurrentProgramScene':
        if (!this.scenes.has(data.sceneName)) this.err(`No source was found by the name of \`${data.sceneName}\`.`);
        this.program = data.sceneName;
        this.emit('CurrentProgramSceneChanged', { sceneName: data.sceneName });
        return;
      case 'GetStreamStatus':
        if (this.streaming) this.bytes += 500_000;
        return {
          outputActive: this.streaming,
          outputReconnecting: false,
          outputTimecode: this.streaming ? '00:00:10.000' : '00:00:00.000',
          outputDuration: 10000,
          outputCongestion: 0.05,
          outputBytes: this.bytes,
          outputSkippedFrames: 0,
          outputTotalFrames: 300,
        };
      case 'StartStream':
        if (this.streaming) this.err('stream already active');
        this.streaming = true;
        this.emit('StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
        return;
      case 'StopStream':
        this.streaming = false;
        this.emit('StreamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
        return;
      case 'SetStreamServiceSettings':
        this.streamService = data;
        return;
      default:
        this.err(`FakeObs: unsupported request ${type}`);
    }
  }
}
