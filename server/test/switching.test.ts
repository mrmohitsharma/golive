import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addStaff, api, createTournament, engineToken, expectOk, joinAsGuest, signup, startHarness, TestSocket, type Harness } from './helpers.js';
import { nextCamera, patchSwitching, switchingOf } from '../src/switching.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const cams = (...ids: string[]) => ids.map((id) => ({ id }));

describe('switching rules', () => {
  it('defaults and clamps the settings', () => {
    const d = switchingOf(null);
    assert.deepEqual(d, { auto: { on: false, mode: 'round', mainCameraId: null, everySec: 60 }, transition: { style: 'fade', ms: 700 } });
    const c = switchingOf({ auto: { on: 1, mode: 'main', mainCameraId: 'x', everySec: 2 }, transition: { style: 'wipe', ms: 99999 } });
    assert.equal(c.auto.everySec, 10);
    assert.equal(c.auto.mainCameraId, null, 'not an id');
    assert.equal(c.transition.style, 'fade');
    assert.equal(c.transition.ms, 2000);
    assert.equal(switchingOf({ auto: { everySec: 99999 } }).auto.everySec, 1800);
    const p = patchSwitching(d, { auto: { everySec: 90 }, transition: { style: 'slide' } });
    assert.equal(p.auto.everySec, 90);
    assert.equal(p.auto.mode, 'round', 'keeps what was not sent');
    assert.equal(p.transition.style, 'slide');
  });

  it('round-robin goes to the camera after the one on air, and wraps', () => {
    const s = switchingOf({ auto: { on: true } }).auto;
    assert.equal(nextCamera(cams(A, B, C), A, s, null), B);
    assert.equal(nextCamera(cams(A, B, C), C, s, null), A);
    assert.equal(nextCamera(cams(A, B, C), null, s, null), A, 'nothing on air: the first camera');
    assert.equal(nextCamera(cams(B, C), A, s, null), B, 'the camera on air left: start from the first');
    assert.equal(nextCamera(cams(A), A, s, null), null, 'only the camera on air: no switch');
    assert.equal(nextCamera([], A, s, null), null);
  });

  it('main camera mode goes main → other → main → next other', () => {
    const s = switchingOf({ auto: { on: true, mode: 'main', mainCameraId: A } }).auto;
    assert.equal(nextCamera(cams(A, B, C), B, s, B), A, 'back to the main camera');
    assert.equal(nextCamera(cams(A, B, C), A, s, null), B);
    assert.equal(nextCamera(cams(A, B, C), A, s, B), C, 'the next of the others');
    assert.equal(nextCamera(cams(A, B, C), A, s, C), B);
    assert.equal(nextCamera(cams(A), A, s, null), null, 'no other camera: stay');
    assert.equal(nextCamera(cams(B, C), B, s, null), C, 'main camera not live: round-robin on the others');
  });
});

describe('auto switch, transitions and remote camera controls', () => {
  let h: Harness;
  let directorToken: string;
  let tid: string;
  let camA: any, camB: any, camC: any;
  let guestA: string;
  let director: TestSocket, engine: TestSocket, phoneA: TestSocket;
  const hub = () => h.app.hub as any;

  before(async () => {
    h = await startHarness();
    const owner = await signup(h, 'sw-owner@club.test');
    directorToken = await addStaff(h, owner.token, owner.orgId, 'sw-d@club.test', 'director');
    tid = await createTournament(h, owner.token, owner.orgId);
    const reg = async (name: string, deviceId: string) => {
      const g = await joinAsGuest(h, owner.token, tid, 'camera', deviceId);
      return { g, cam: (await expectOk(api(h, 'POST', `/api/tournaments/${tid}/cameras/register`, { name, deviceId, platform: 'android' }, g))).camera };
    };
    const a = await reg('Cam A', 'device-sw-000a');
    guestA = a.g;
    camA = a.cam;
    camB = (await reg('Cam B', 'device-sw-000b')).cam;
    camC = (await reg('Cam C', 'device-sw-000c')).cam;
    const online = (p: string) => ({ name: p, online: true, onlineTime: new Date().toISOString(), inboundBytes: 1000, readers: [{}], tracks2: [{ codec: 'H264' }] });
    h.setMediaPaths([online(camA.streamPath), online(camB.streamPath), online(camC.streamPath)]);
    await h.app.poller.pollOnce();

    director = await TestSocket.open(h.wsUrl, directorToken);
    director.send({ type: 'subscribe', tournamentId: tid });
    const snap = await director.type('snapshot');
    assert.equal(snap.switching.auto.on, false);
    assert.equal(snap.switching.transition.style, 'fade');

    engine = await TestSocket.open(h.wsUrl, await engineToken(h, tid));
    engine.send({ type: 'engine.hello' });
    await engine.type('engine.config');
    director.drain();
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, programmeCameraId: camA.id, streaming: { active: true } } });
    await director.next((m) => m.type === 'engine' && m.engine.programmeCameraId === camA.id && m.engine.streaming?.active);

    phoneA = await TestSocket.open(h.wsUrl, guestA);
    phoneA.send({ type: 'subscribe', tournamentId: tid });
    await phoneA.type('snapshot');
    phoneA.send({ type: 'camera.join', cameraId: camA.id });
    await phoneA.type('camera.joined');
  });
  after(async () => {
    director?.close();
    engine?.close();
    phoneA?.close();
    await h.close();
  });

  it('manual cuts carry the event transition (Fade by default, Slide once chosen)', async () => {
    director.send({ type: 'command', action: 'cut', cameraId: camB.id, requestId: 'm1' });
    const cut = await engine.next((m) => m.type === 'command' && m.action === 'cut');
    assert.deepEqual(cut.transition, { name: 'Fade', ms: 700 });
    engine.send({ type: 'command.result', id: cut.id, ok: true });

    const r = await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/switching`, { transition: { style: 'slide', ms: 500 } }, directorToken));
    assert.equal(r.switching.transition.style, 'slide');
    await director.next((m) => m.type === 'switching' && m.switching.transition.style === 'slide');
    director.send({ type: 'command', action: 'preview', cameraId: camC.id, requestId: 'm2' });
    const pv = await engine.next((m) => m.type === 'command' && m.action === 'preview');
    assert.equal(pv.transition, undefined, 'preview is not a switch on air');
    engine.send({ type: 'command.result', id: pv.id, ok: true });
    director.drain();
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, programmeCameraId: camB.id, previewCameraId: camC.id, streaming: { active: true } } });
    await director.next((m) => m.type === 'engine' && m.engine.previewCameraId === camC.id);
    director.send({ type: 'command', action: 'take', requestId: 'm3' });
    const take = await engine.next((m) => m.type === 'command' && m.action === 'take');
    assert.deepEqual(take.transition, { name: 'Slide', ms: 500 });
    engine.send({ type: 'command.result', id: take.id, ok: true });
    director.drain();
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, programmeCameraId: camA.id, streaming: { active: true } } });
    await director.next((m) => m.type === 'engine' && m.engine.programmeCameraId === camA.id);
  });

  it('validates the settings: directors only, main camera from this event', async () => {
    const guest = await api(h, 'PATCH', `/api/tournaments/${tid}/switching`, { auto: { on: true } }, guestA);
    assert.equal(guest.status, 403);
    const noMain = await api(h, 'PATCH', `/api/tournaments/${tid}/switching`, { auto: { on: true, mode: 'main' } }, directorToken);
    assert.equal(noMain.status, 400);
    assert.match(noMain.body.error.message, /main camera/i);
    const other = await api(h, 'PATCH', `/api/tournaments/${tid}/switching`, { auto: { mainCameraId: '00000000-0000-4000-8000-000000000001' } }, directorToken);
    assert.equal(other.status, 400);
  });

  it('auto switch: round-robin on time, with the transition; a manual switch restarts the timer', async () => {
    const r = await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/switching`, { auto: { on: true, mode: 'round', everySec: 30 } }, directorToken));
    assert.equal(r.switching.auto.on, true);
    assert.equal(r.switching.running, true);
    assert.equal(r.switching.nextCameraId, camB.id);
    assert.ok(Date.parse(r.switching.nextAt) - Date.now() > 25_000, 'first switch one interval after turning on');
    const saved = await h.db.query('SELECT switching FROM tournaments WHERE id = $1', [tid]);
    assert.equal(saved.rows[0].switching.auto.everySec, 30);

    // Not due yet: nothing happens.
    engine.drain();
    await hub().autoSwitchTick();
    await assert.rejects(engine.next((m) => m.type === 'command', 200));

    hub().live.get(tid).lastSwitchAt = Date.now() - 31_000;
    await hub().autoSwitchTick();
    const cut = await engine.next((m) => m.type === 'command' && m.action === 'cut');
    assert.equal(cut.cameraId, camB.id);
    assert.equal(cut.auto, true);
    assert.deepEqual(cut.transition, { name: 'Slide', ms: 500 });
    engine.send({ type: 'command.result', id: cut.id, ok: true });
    director.drain();
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, programmeCameraId: camB.id, streaming: { active: true } } });
    const sw = await director.next((m) => m.type === 'switching' && m.switching.nextCameraId === camC.id);
    assert.ok(Date.parse(sw.switching.nextAt) - Date.now() > 25_000);

    // The director cuts to A by hand: auto keeps going from A, a full interval later.
    hub().live.get(tid).lastSwitchAt = Date.now() - 29_000;
    director.drain();
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, programmeCameraId: camA.id, streaming: { active: true } } });
    const after = await director.next((m) => m.type === 'switching' && m.switching.nextCameraId === camB.id);
    assert.ok(Date.parse(after.switching.nextAt) - Date.now() > 25_000, 'timer restarted from the manual switch');
  });

  it('auto switch waits while off air, during a replay, or with no other live camera', async () => {
    engine.drain();
    director.drain();
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, programmeCameraId: camA.id, streaming: { active: false } } });
    await director.next((m) => m.type === 'engine' && !m.engine.streaming?.active);
    hub().live.get(tid).lastSwitchAt = 0;
    await hub().autoSwitchTick();
    await assert.rejects(engine.next((m) => m.type === 'command', 200), 'not live: no switch');

    director.drain();

    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, programmeCameraId: camA.id, replayActive: true, streaming: { active: true } } });
    await director.next((m) => m.type === 'engine' && m.engine.replayActive);
    hub().live.get(tid).lastSwitchAt = 0;
    await hub().autoSwitchTick();
    await assert.rejects(engine.next((m) => m.type === 'command', 200), 'replay on air: no switch');

    director.drain();

    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, programmeCameraId: camA.id, replayActive: false, streaming: { active: true } } });
    await director.next((m) => m.type === 'engine' && !m.engine.replayActive && m.engine.streaming?.active);
    h.setMediaPaths([{ name: camA.streamPath, online: true, onlineTime: new Date().toISOString(), inboundBytes: 1000, readers: [{}], tracks2: [{ codec: 'H264' }] }]);
    await h.app.poller.pollOnce();
    hub().live.get(tid).lastSwitchAt = 0;
    await hub().autoSwitchTick();
    await assert.rejects(engine.next((m) => m.type === 'command' && m.action === 'cut', 200), 'only the camera on air is live');
    assert.ok(Date.now() - hub().live.get(tid).lastSwitchAt > 20_000, 'tries again in a few seconds');
  });

  it('main camera mode: back to the main camera between the others', async () => {
    const online = (p: string) => ({ name: p, online: true, onlineTime: new Date().toISOString(), inboundBytes: 1000, readers: [{}], tracks2: [{ codec: 'H264' }] });
    h.setMediaPaths([online(camA.streamPath), online(camB.streamPath), online(camC.streamPath)]);
    await h.app.poller.pollOnce();
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/switching`, { auto: { mode: 'main', mainCameraId: camA.id } }, directorToken));
    const order: string[] = [];
    let onAir = camA.id;
    for (let i = 0; i < 4; i++) {
      engine.drain();
      hub().live.get(tid).lastSwitchAt = 0;
      await hub().autoSwitchTick();
      const cut = await engine.next((m) => m.type === 'command' && m.action === 'cut');
      engine.send({ type: 'command.result', id: cut.id, ok: true });
      onAir = cut.cameraId;
      director.drain();
      engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, programmeCameraId: onAir, streaming: { active: true } } });
      await director.next((m) => m.type === 'engine' && m.engine.programmeCameraId === onAir);
      order.push(onAir);
    }
    assert.deepEqual(order, [camB.id, camA.id, camC.id, camA.id]);
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/switching`, { auto: { on: false } }, directorToken));
  });

  it('the director adjusts the phone: zoom glides when on air; the phone reports its controls', async () => {
    const on = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/cameras/${camA.id}/adjust`, { zoom: 2.5, ev: -1 }, directorToken));
    assert.equal(on.ok, true);
    const m = await phoneA.type('camera.adjust');
    assert.equal(m.zoom, 2.5);
    assert.equal(m.ev, -1);
    assert.equal(m.smooth, true, 'Cam A is on air');

    director.drain();

    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, programmeCameraId: camB.id, streaming: { active: true } } });
    await director.next((x) => x.type === 'engine' && x.engine.programmeCameraId === camB.id);
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/cameras/${camA.id}/adjust`, { focus: 'lock' }, directorToken));
    const m2 = await phoneA.type('camera.adjust');
    assert.equal(m2.focus, 'lock');
    assert.equal(m2.smooth, false, 'off air: instant');

    const offline = await api(h, 'POST', `/api/tournaments/${tid}/cameras/${camC.id}/adjust`, { zoom: 2 }, directorToken);
    assert.equal(offline.status, 409);
    assert.match(offline.body.error.message, /Cam C/);
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/cameras/${camA.id}/adjust`, {}, directorToken)).status, 400);
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/cameras/${camA.id}/adjust`, { zoom: 2 }, guestA)).status, 403);

    phoneA.send({ type: 'telemetry', telemetry: { state: 'live', controls: { zoom: 2.5, zoomMin: 1, zoomMax: 8, ev: -1, evMin: -4, evMax: 4, evStep: 0.5, autoFocus: true, locked: true, extra: 'x' } } });
    const cams = await director.next((x) => x.type === 'cameras' && x.cameras.some((c: any) => c.id === camA.id && c.telemetry?.controls?.zoom === 2.5));
    const ctl = cams.cameras.find((c: any) => c.id === camA.id).telemetry.controls;
    assert.equal(ctl.locked, true);
    assert.equal(ctl.zoomMax, 8);
    assert.equal(ctl.extra, undefined, 'only known fields');
    // The operator zooms on the phone: the director's slider follows (last change wins).
    phoneA.send({ type: 'telemetry', telemetry: { state: 'live', controls: { zoom: 1.2, zoomMin: 1, zoomMax: 8, ev: -1, evMin: -4, evMax: 4, evStep: 0.5, autoFocus: true, locked: true } } });
    await director.next((x) => x.type === 'cameras' && x.cameras.some((c: any) => c.id === camA.id && c.telemetry?.controls?.zoom === 1.2));
  });
});
