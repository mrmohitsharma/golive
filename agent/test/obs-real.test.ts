/**
 * Runs the agent's OBS controller against a REAL OBS Studio (obs-websocket v5).
 * Skipped unless OBS_TEST_URL is set, e.g.:
 *   OBS_TEST_URL=ws://127.0.0.1:4455 OBS_TEST_PASSWORD=... node --import tsx --test test/obs-real.test.ts
 * Uses its own scene names; leaves OBS with those scenes (run against a throwaway OBS).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { OBSWebSocket, EventSubscription } from 'obs-websocket-js';
import { ObsController, DUCK_FILTER, REPLAY_INPUT, type EngineConfig } from '../src/obs.js';

const URL_ = process.env.OBS_TEST_URL;

/** Real OBS confirms a programme change after the transition (default 300 ms fade), so wait for it. */
async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !fn()) await new Promise((r) => setTimeout(r, 50));
  return fn();
}

describe('ObsController against real OBS', { skip: !URL_ }, () => {
  const obs = new OBSWebSocket();
  let ctl: ObsController;
  let server: http.Server;
  let clipUrl = '';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-real-'));
  const tag = Math.random().toString(36).slice(2, 6);
  const cfg = (): EngineConfig => ({
    tournamentId: 't',
    tournamentName: 'Real OBS test',
    mode: 'cloud',
    fallbackScene: `CG Fallback`,
    replayScene: `CG Replay`,
    cameras: [1, 2].map((n) => ({
      id: `id-${n}`,
      name: `Cam ${n}`,
      hole: n,
      position: null,
      streamPath: `cam-${tag}${n}`,
      sceneName: `CG cam-${tag}${n}`,
      inputName: `CG cam-${tag}${n} Feed`,
      srtUrl: `srt://127.0.0.1:9?streamid=read:cam-${tag}${n}:engine:k&latency=200000&mode=caller`,
    })),
    commentators: [{ id: 'm1', name: 'Vik', streamPath: `com-${tag}`, inputName: `CG Commentary com-${tag}`, srtUrl: `srt://127.0.0.1:9?streamid=read:com-${tag}:engine:k` }],
    graphicsUrl: 'http://127.0.0.1:9/graphics/t?k=x',
    output: { server: 'rtmp://127.0.0.1:9/live', key: 'test-key' },
    audio: { courseDb: -3, courseMuted: false, cameras: {}, commentaryDb: 0, commentaryMuted: false, ducking: true, commentaryDelayMs: 250 },
    canvas: { width: 640, height: 360, fps: 15, videoKbps: 800 },
  });

  before(async () => {
    // A 2-second clip served over HTTP, as the server serves replays.
    const clip = path.join(dir, 'clip.mp4');
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clip]);
    server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'video/mp4');
      fs.createReadStream(clip).pipe(res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    clipUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/clip.mp4`;
    await obs.connect(URL_!, process.env.OBS_TEST_PASSWORD, {
      rpcVersion: 1,
      eventSubscriptions: EventSubscription.General | EventSubscription.Scenes | EventSubscription.Ui | EventSubscription.Outputs | EventSubscription.MediaInputs,
    });
    ctl = new ObsController(obs as never, { fallbackText: 'Back soon' }, () => {});
    await ctl.onConnected();
  });
  after(async () => {
    await obs.disconnect();
    server.close();
  });

  it('connects, reports version, enables studio mode', async () => {
    assert.match(ctl.state.obsVersion!, /^\d+\.\d+/);
    assert.equal((await obs.call('GetStudioModeEnabled')).studioModeEnabled, true);
  });

  it('sync builds scenes, commentary, replay and applies canvas, encoder and stream settings', async () => {
    await ctl.sync(cfg());
    const scenes = (await obs.call('GetSceneList')).scenes.map((s: any) => s.sceneName);
    for (const s of [`CG cam-${tag}1`, `CG cam-${tag}2`, 'CG Fallback', 'CG Replay']) assert.ok(scenes.includes(s), `missing scene ${s}`);
    const items = (await obs.call('GetSceneItemList', { sceneName: `CG cam-${tag}1` })).sceneItems.map((i: any) => i.sourceName);
    assert.ok(items.includes(`CG cam-${tag}1 Feed`));
    assert.equal(items.at(-1), 'CG Layers', 'shared layers on top');
    const layers = (await obs.call('GetSceneItemList', { sceneName: 'CG Layers' })).sceneItems.map((i: any) => i.sourceName);
    assert.ok(layers.includes(`CG Commentary com-${tag}`));
    const feed = await obs.call('GetInputSettings', { inputName: `CG cam-${tag}1 Feed` });
    assert.equal(feed.inputKind, 'ffmpeg_source');
    assert.equal(feed.inputSettings.is_local_file, false);
    const vs = await obs.call('GetVideoSettings');
    assert.deepEqual([vs.baseWidth, vs.baseHeight, vs.fpsNumerator], [640, 360, 15]);
    const kb = await obs.call('GetProfileParameter', { parameterCategory: 'SimpleOutput', parameterName: 'VBitrate' });
    assert.equal(kb.parameterValue, '800');
    const svc = await obs.call('GetStreamServiceSettings');
    assert.equal(svc.streamServiceType, 'rtmp_custom');
    assert.equal(svc.streamServiceSettings.key, 'test-key');
  });

  it('audio: volume, sync offset and the sidechain ducking compressor exist in OBS', async () => {
    const vol = await obs.call('GetInputVolume', { inputName: `CG cam-${tag}1 Feed` });
    assert.ok(Math.abs(vol.inputVolumeDb - -3) < 0.1, `volume ${vol.inputVolumeDb}`);
    const sync = await obs.call('GetInputAudioSyncOffset', { inputName: `CG Commentary com-${tag}` });
    assert.equal(sync.inputAudioSyncOffset, 250);
    const f = await obs.call('GetSourceFilter', { sourceName: `CG cam-${tag}1 Feed`, filterName: DUCK_FILTER });
    assert.equal(f.filterKind, 'compressor_filter');
    assert.equal(f.filterEnabled, true);
    assert.equal(f.filterSettings.sidechain_source, `CG Commentary com-${tag}`);
  });

  it('preview, take and cut change the real programme', async () => {
    await ctl.execute('preview', 'id-2');
    assert.equal((await obs.call('GetCurrentPreviewScene')).currentPreviewSceneName, `CG cam-${tag}2`);
    await ctl.execute('take', 'id-2');
    assert.ok(await until(() => ctl.state.programmeCameraId === 'id-2'), 'take confirmed by OBS');
    assert.equal((await obs.call('GetCurrentProgramScene')).currentProgramSceneName, `CG cam-${tag}2`);
    await ctl.execute('cut', 'id-1');
    assert.ok(await until(() => ctl.state.programmeCameraId === 'id-1'), 'state follows OBS events');
    assert.equal((await obs.call('GetCurrentProgramScene')).currentProgramSceneName, `CG cam-${tag}1`);
  });

  it('replay plays an HTTP clip in OBS and returns to the camera when it ends', async () => {
    await ctl.execute('replay.play', 'id-2', { url: clipUrl, durationSec: 2, returnScene: `CG cam-${tag}1` });
    assert.ok(await until(() => ctl.state.replayActive), 'replay on air');
    assert.equal((await obs.call('GetCurrentProgramScene')).currentProgramSceneName, 'CG Replay');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && ctl.state.replayActive) await new Promise((r) => setTimeout(r, 200));
    assert.equal(ctl.state.replayActive, false, 'replay ended');
    assert.equal((await obs.call('GetCurrentProgramScene')).currentProgramSceneName, `CG cam-${tag}1`);
    const st = await obs.call('GetInputSettings', { inputName: REPLAY_INPUT });
    assert.equal(st.inputSettings.input, clipUrl);
  });

  it('fallback cuts to the fallback scene', async () => {
    await ctl.execute('fallback', null);
    assert.ok(await until(() => ctl.state.fallbackActive));
    assert.equal((await obs.call('GetCurrentProgramScene')).currentProgramSceneName, 'CG Fallback');
  });
});
