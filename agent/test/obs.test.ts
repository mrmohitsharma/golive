import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ObsController, DUCK_FILTER, GRAPHICS_INPUT, LAYERS_SCENE, REPLAY_INPUT, type EngineCamera, type EngineConfig } from '../src/obs.js';
import { FakeObs } from './fake-obs.js';

const cam = (n: number, url = `srt://h:8890?streamid=read:cam-${n}:engine:k`): EngineCamera => ({
  id: `id-${n}`,
  name: `Cam ${n}`,
  hole: n,
  position: 'tee',
  streamPath: `cam-${n}`,
  sceneName: `CG cam-${n}`,
  inputName: `CG cam-${n} Feed`,
  srtUrl: url,
});

const config = (over: Partial<EngineConfig> = {}): EngineConfig => ({
  tournamentId: 't',
  tournamentName: 'T',
  mode: 'laptop',
  fallbackScene: 'CG Fallback',
  replayScene: 'CG Replay',
  cameras: [cam(1), cam(2)],
  commentators: [{ id: 'm1', name: 'Vik', streamPath: 'com-1', inputName: 'CG Commentary com-1', srtUrl: 'srt://h:8890?streamid=read:com-1:engine:k' }],
  graphicsUrl: 'https://live.test/graphics/t?k=g',
  output: null,
  audio: { courseDb: 0, courseMuted: false, cameras: {}, commentaryDb: 0, commentaryMuted: false, ducking: true, commentaryDelayMs: 0 },
  canvas: null,
  ...over,
});

describe('ObsController', () => {
  let obs: FakeObs;
  let ctl: ObsController;
  let meters: Record<string, number>[];

  beforeEach(async () => {
    obs = new FakeObs();
    meters = [];
    ctl = new ObsController(obs, { fallbackText: 'Back soon' }, () => {}, () => {}, (l) => meters.push(l));
    await ctl.onConnected();
  });

  it('on connect enables studio mode and creates the fallback scene', () => {
    assert.equal(obs.studio, true);
    assert.ok(obs.scenes.has('CG Fallback'));
    assert.equal(obs.inputs.get('CG Fallback Text')!.settings.text, 'Back soon');
    assert.deepEqual(ctl.state.warnings, []);
  });

  it('builds camera scenes, commentary, replay and graphics layers, idempotently', async () => {
    const r1 = await ctl.sync(config());
    assert.deepEqual(r1, { created: 2, updated: 0, removed: 0 });
    assert.equal(obs.inputs.get('CG cam-1 Feed')!.settings.input, cam(1).srtUrl);
    assert.equal(obs.inputs.get(GRAPHICS_INPUT)!.kind, 'browser_source');
    assert.equal(obs.inputs.get(GRAPHICS_INPUT)!.settings.url, 'https://live.test/graphics/t?k=g');
    assert.ok(obs.scenes.has('CG Replay') && obs.inputs.has(REPLAY_INPUT));
    // Commentary and graphics live in one nested scene, referenced on top of every programme scene,
    // so changes are live even on the Studio Mode duplicate that is on air.
    assert.deepEqual(obs.itemsIn(LAYERS_SCENE).sort(), ['CG Commentary com-1', GRAPHICS_INPUT].sort());
    for (const s of ['CG cam-1', 'CG cam-2', 'CG Fallback', 'CG Replay']) {
      assert.equal(obs.itemsIn(s).at(-1), LAYERS_SCENE, `${s} has the layers on top`);
    }
    assert.deepEqual(await ctl.sync(config()), { created: 0, updated: 0, removed: 0 });
    assert.equal(obs.itemsIn('CG cam-1').filter((i) => i === LAYERS_SCENE).length, 1);
  });

  it('without a Browser Source, everything else works and the director is warned', async () => {
    obs = new FakeObs();
    obs.kinds = obs.kinds.filter((k) => k !== 'browser_source');
    ctl = new ObsController(obs, { fallbackText: 'x' }, () => {});
    await ctl.onConnected();
    await ctl.sync(config());
    assert.match(ctl.state.warnings[0], /Browser Source/);
    assert.ok(!obs.inputs.has(GRAPHICS_INPUT));
    assert.ok(obs.scenes.has('CG cam-1'));
  });

  it('updates changed URLs, removes deleted cameras and commentators, never the scene on air', async () => {
    await ctl.sync(config({ cameras: [cam(1), cam(2), cam(3)] }));
    await ctl.execute('cut', 'id-3');
    const r = await ctl.sync(config({ cameras: [cam(1, 'srt://new-url')], commentators: [] }));
    assert.deepEqual(r, { created: 0, updated: 1, removed: 1 });
    assert.ok(!obs.scenes.has('CG cam-2'));
    assert.ok(obs.scenes.has('CG cam-3'), 'on-air scene kept');
    assert.ok(!obs.inputs.has('CG Commentary com-1'));
  });

  it('preview, take and cut drive OBS; the confirmed programme follows OBS events', async () => {
    await ctl.sync(config());
    await ctl.execute('preview', 'id-2');
    assert.equal(ctl.state.previewCameraId, 'id-2');
    await ctl.execute('take', 'id-2');
    assert.equal(ctl.state.programmeCameraId, 'id-2');
    obs.program = 'CG cam-1';
    obs.emit('CurrentProgramSceneChanged', { sceneName: 'CG cam-1' });
    assert.equal(ctl.state.programmeCameraId, 'id-1');
  });

  it('replay plays the clip and returns to the camera when it ends', async () => {
    await ctl.sync(config());
    await ctl.execute('cut', 'id-1');
    await ctl.execute('replay.play', 'id-2', { url: 'https://live.test/media/replays/x.mp4?sig=s', durationSec: 10, returnScene: 'CG cam-1' });
    assert.equal(obs.program, 'CG Replay');
    assert.equal(obs.inputs.get(REPLAY_INPUT)!.settings.input, 'https://live.test/media/replays/x.mp4?sig=s');
    assert.deepEqual(obs.mediaRestarts, [REPLAY_INPUT]);
    assert.equal(ctl.state.replayActive, true);
    assert.equal(ctl.state.programmeCameraId, null);
    obs.emit('MediaInputPlaybackEnded', { inputName: REPLAY_INPUT });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(obs.program, 'CG cam-1');
    assert.equal(ctl.state.replayActive, false);
  });

  it('audio: course level, per-camera trims and mutes, commentary delay, ducking on the commentator', async () => {
    await ctl.sync(config());
    await ctl.applyAudio({ courseDb: -6, courseMuted: false, cameras: { 'id-2': { db: -4, muted: true } }, commentaryDb: 3, commentaryMuted: false, ducking: true, commentaryDelayMs: 400 });
    assert.equal(obs.inputs.get('CG cam-1 Feed')!.volumeDb, -6);
    assert.equal(obs.inputs.get('CG cam-2 Feed')!.volumeDb, -10);
    assert.equal(obs.inputs.get('CG cam-2 Feed')!.muted, true);
    assert.equal(obs.inputs.get('CG Commentary com-1')!.volumeDb, 3);
    assert.equal(obs.inputs.get('CG Commentary com-1')!.syncOffset, 400);
    const duck = obs.inputs.get('CG cam-1 Feed')!.filters.get(DUCK_FILTER)!;
    assert.equal(duck.kind, 'compressor_filter');
    assert.equal(duck.settings.sidechain_source, 'CG Commentary com-1');
    assert.equal(duck.enabled, true);
    await ctl.applyAudio({ ...config().audio, ducking: false, courseMuted: true });
    assert.equal(obs.inputs.get('CG cam-1 Feed')!.filters.get(DUCK_FILTER)!.enabled, false);
    assert.equal(obs.inputs.get('CG cam-1 Feed')!.muted, true);
  });

  it('cloud mode sets canvas and encoder (2 s keyframes); laptop mode leaves them alone', async () => {
    await ctl.sync(config());
    assert.equal(Object.keys(obs.profile).length, 0);
    await ctl.sync(config({ mode: 'cloud', canvas: { width: 1280, height: 720, fps: 30, videoKbps: 4500 } }));
    assert.equal(obs.video.baseWidth, 1280);
    assert.equal(obs.profile['SimpleOutput.VBitrate'], '4500');
    assert.equal(obs.profile['SimpleOutput.x264Settings'], 'keyint=60 min-keyint=30');
  });

  it('streams to the server programme ingest (SRT) when the server restreams', async () => {
    const srt = 'srt://live.test:8890?streamid=publish:prog-abc:engine:k&latency=600000&pkt_size=1316';
    await ctl.sync(config({ output: { server: srt, key: '' } }));
    assert.deepEqual(obs.streamService.streamServiceSettings, { server: srt, key: '' });
    await ctl.execute('stream.start', null);
    assert.equal(ctl.state.streaming.active, true);
  });

  it('without a server destination, falls back to the stream key in the agent .env', async () => {
    obs = new FakeObs();
    ctl = new ObsController(obs, { fallbackText: 'x', youtubeStreamKey: 'env-key', youtubeServer: 'rtmps://a.rtmps.youtube.com/live2' }, () => {});
    await ctl.onConnected();
    await ctl.sync(config({ output: null }));
    assert.deepEqual(obs.streamService.streamServiceSettings, { server: 'rtmps://a.rtmps.youtube.com/live2', key: 'env-key' });
  });

  it('volume meters become peak dB per source, throttled', async () => {
    await ctl.sync(config());
    obs.emit('InputVolumeMeters', { inputs: [{ inputName: 'CG Commentary com-1', inputLevelsMul: [[0.2, 0.5, 0.5], [0.1, 0.25, 0.25]] }, { inputName: 'Mic/Aux', inputLevelsMul: [[1, 1, 1]] }] });
    obs.emit('InputVolumeMeters', { inputs: [{ inputName: 'CG Commentary com-1', inputLevelsMul: [[1, 1, 1]] }] });
    assert.equal(meters.length, 1);
    assert.deepEqual(meters[0], { 'CG Commentary com-1': -6 });
  });

  it('surfaces OBS errors and refuses work while disconnected', async () => {
    await ctl.sync(config());
    obs.failNext = 'SetCurrentProgramScene';
    await assert.rejects(ctl.execute('cut', 'id-1'), /simulated/);
    await assert.rejects(ctl.execute('cut', 'id-unknown'), /Unknown camera/);
    ctl.onDisconnected('socket closed');
    await assert.rejects(ctl.execute('cut', 'id-1'), /not connected/);
  });
});
