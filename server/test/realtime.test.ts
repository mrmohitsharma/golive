import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addStaff, api, createTournament, engineToken, expectOk, joinAsGuest, signup, startHarness, TestSocket, type Harness } from './helpers.js';

describe('real-time control', () => {
  let h: Harness;
  let owner: { token: string; orgId: string };
  let directorToken: string;
  let tournamentId: string;
  let cameraGuest: string;
  let camA: any;
  let camB: any;
  let director: TestSocket;
  let engine: TestSocket;
  let phone: TestSocket;

  before(async () => {
    h = await startHarness();
    owner = await signup(h, 'owner@club.test');
    directorToken = await addStaff(h, owner.token, owner.orgId, 'd@club.test', 'director');
    tournamentId = await createTournament(h, owner.token, owner.orgId);
    cameraGuest = await joinAsGuest(h, owner.token, tournamentId, 'camera', 'device-aaaa-0001');
    const reg = (name: string, deviceId: string, token: string) =>
      expectOk(api(h, 'POST', `/api/tournaments/${tournamentId}/cameras/register`, { name, deviceId, platform: 'android', hole: 3 }, token));
    camA = (await reg('Cam A', 'device-aaaa-0001', cameraGuest)).camera;
    const g2 = await joinAsGuest(h, owner.token, tournamentId, 'camera', 'device-bbbb-0002');
    camB = (await reg('Cam B', 'device-bbbb-0002', g2)).camera;
    await expectOk(api(h, 'PATCH', `/api/cameras/${camB.id}`, { hole: 9 }, directorToken));
  });
  after(async () => {
    director?.close();
    engine?.close();
    phone?.close();
    await h.close();
  });

  it('rejects sockets without a valid token', async () => {
    await assert.rejects(TestSocket.open(h.wsUrl, 'garbage'));
  });

  it('director gets a full snapshot; commands fail clearly when no engine is connected', async () => {
    director = await TestSocket.open(h.wsUrl, directorToken);
    director.send({ type: 'subscribe', tournamentId });
    const snap = await director.type('snapshot');
    assert.equal(snap.role, 'director');
    assert.equal(snap.cameras.length, 2);
    assert.equal(snap.engine.connected, false);
    assert.equal(snap.production.mode, 'laptop');
    assert.equal(snap.graphics.holeCard.auto, true);
    assert.equal(snap.audio.ducking, true);
    director.send({ type: 'command', action: 'cut', cameraId: camA.id, requestId: 'r0' });
    const res = await director.type('command.result');
    assert.equal(res.ok, false);
    assert.match(res.error, /engine is offline/i);
  });

  it('a camera guest cannot direct; it joins its own camera and gets tally', async () => {
    phone = await TestSocket.open(h.wsUrl, cameraGuest);
    phone.send({ type: 'subscribe', tournamentId });
    const snap = await phone.type('snapshot');
    assert.equal(snap.role, 'camera');
    assert.equal(snap.cameras, undefined, 'camera guests do not see other feeds');
    phone.send({ type: 'command', action: 'cut', cameraId: camA.id });
    assert.equal((await phone.type('error')).code, 'forbidden');
    phone.send({ type: 'camera.join', cameraId: camB.id });
    assert.equal((await phone.type('error')).code, 'forbidden', 'cannot join someone else’s camera');
    phone.send({ type: 'camera.join', cameraId: camA.id });
    assert.equal((await phone.type('camera.joined')).camera.id, camA.id);
    assert.deepEqual(await phone.type('tally'), { type: 'tally', onAir: false, preview: false });
  });

  it('a user token cannot pretend to be the engine', async () => {
    const s = await TestSocket.open(h.wsUrl, directorToken);
    s.send({ type: 'engine.hello', tournamentId });
    assert.equal((await s.type('error')).code, 'forbidden');
    s.close();
  });

  it('engine connects with its key and receives the full OBS configuration', async () => {
    engine = await TestSocket.open(h.wsUrl, await engineToken(h, tournamentId));
    engine.send({ type: 'engine.hello' });
    const cfg = await engine.type('engine.config');
    assert.equal(cfg.cameras.length, 2);
    assert.ok(cfg.cameras.every((c: any) => c.srtUrl.startsWith('srt://') && c.inputName.endsWith(' Feed')));
    assert.match(cfg.graphicsUrl, new RegExp(`/graphics/${tournamentId}\\?k=[0-9a-f]{32}$`));
    assert.equal(cfg.output, null, 'no platform set up: OBS keeps its own stream settings');
    assert.equal(cfg.canvas, null, 'laptop mode keeps the operator’s OBS canvas');
    assert.equal(cfg.audio.courseDb, 0);
    await director.next((m) => m.type === 'engine' && m.engine.connected);
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true } });
    await director.next((m) => m.type === 'engine' && m.engine.obsConnected);
  });

  it('preview → take, confirmed by the engine; tally and auto hole card follow the programme', async () => {
    director.send({ type: 'command', action: 'preview', cameraId: camB.id, requestId: 'r1' });
    const cmd = await engine.type('command');
    assert.equal(cmd.sceneName, `CG ${camB.streamPath}`);
    engine.send({ type: 'command.result', id: cmd.id, ok: true });
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, previewCameraId: camB.id } });
    assert.equal((await director.next((m) => m.type === 'command.result' && m.requestId === 'r1')).ok, true);

    director.send({ type: 'command', action: 'take', requestId: 'r2' });
    const take = await engine.type('command');
    assert.equal(take.cameraId, camB.id);
    engine.send({ type: 'command.result', id: take.id, ok: true });
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, programmeCameraId: camB.id } });
    await director.next((m) => m.type === 'engine' && m.engine.programmeCameraId === camB.id);
    const g = await director.next((m) => m.type === 'graphics' && m.graphics.holeCard.visible);
    assert.equal(g.graphics.holeCard.hole, 9, 'hole card shows the on-air camera’s hole');
  });

  it('reports engine-side failures back to the director', async () => {
    director.send({ type: 'command', action: 'cut', cameraId: camA.id, requestId: 'r3' });
    const cmd = await engine.type('command');
    engine.send({ type: 'command.result', id: cmd.id, ok: false, error: 'Scene missing in OBS' });
    const res = await director.next((m) => m.type === 'command.result' && m.requestId === 'r3');
    assert.equal(res.error, 'Scene missing in OBS');
  });

  it('replay fails clearly when there is no recording (MediaMTX unreachable here)', async () => {
    director.send({ type: 'command', action: 'replay', cameraId: camA.id, seconds: 10, requestId: 'r4' });
    const res = await director.next((m) => m.type === 'command.result' && m.requestId === 'r4', 8000);
    assert.equal(res.ok, false);
    assert.ok(res.error.length > 0);
  });

  it('audio changes reach the engine and other directors', async () => {
    const r = await expectOk(api(h, 'PATCH', `/api/tournaments/${tournamentId}/audio`, { courseDb: -6, cameras: { [camA.id]: { muted: true } } }, directorToken));
    assert.equal(r.audio.courseDb, -6);
    const msg = await engine.type('engine.audio');
    assert.equal(msg.audio.cameras[camA.id].muted, true);
    await director.next((m) => m.type === 'audio' && m.audio.courseDb === -6);
  });

  it('engine meters are forwarded to directors', async () => {
    engine.send({ type: 'engine.meters', levels: { 'CG Commentary com-1': -12.5 } });
    const m = await director.type('meters');
    assert.equal(m.levels['CG Commentary com-1'], -12.5);
  });

  it('pushes health from MediaMTX and phone telemetry to directors', async () => {
    phone.send({ type: 'telemetry', telemetry: { state: 'live', bitrateKbps: 2500, battery: 81, charging: false, appState: 'foreground' } });
    h.setMediaPaths([{ name: camB.streamPath, online: true, onlineTime: new Date().toISOString(), inboundBytes: 1000, readers: [{}], tracks2: [{ codec: 'H264' }] }]);
    await h.app.poller.pollOnce();
    const msg = await director.next((m) => m.type === 'cameras' && m.cameras.some((c: any) => c.id === camB.id && c.status === 'live'));
    const a = msg.cameras.find((c: any) => c.id === camA.id);
    assert.equal(a.telemetry.battery, 81);
    assert.equal(msg.cameras.find((c: any) => c.id === camB.id).onAir, true);
  });

  it('auto-cuts to fallback when the programme camera drops', async () => {
    h.setMediaPaths([]);
    await h.app.poller.pollOnce();
    await new Promise((r) => setTimeout(r, 80));
    await h.app.poller.pollOnce();
    const cmd = await engine.next((m) => m.type === 'command' && m.action === 'fallback');
    engine.send({ type: 'command.result', id: cmd.id, ok: true });
    const alert = await director.next((m) => m.type === 'alert' && m.level === 'warning');
    assert.match(alert.message, /fallback/i);
    const log = await expectOk(api(h, 'GET', `/api/tournaments/${tournamentId}/switch-log`, undefined, directorToken));
    assert.ok(log.entries.some((e: any) => e.action === 'fallback' && e.ok && e.actor === 'system'));
  });

  it('camera reassignment is pushed to the engine and the phone', async () => {
    await expectOk(api(h, 'PATCH', `/api/cameras/${camA.id}`, { name: 'Cam A Green', hole: 12 }, directorToken));
    const cfg = await engine.next((m) => m.type === 'engine.config' && m.cameras.some((c: any) => c.name === 'Cam A Green'));
    assert.ok(cfg);
    assert.equal((await phone.type('camera.updated')).camera.hole, 12);
  });

  it('marks the engine offline when it disconnects', async () => {
    engine.close();
    await director.next((m) => m.type === 'engine' && !m.engine.connected);
    await director.next((m) => m.type === 'alert' && m.level === 'error');
  });
});
