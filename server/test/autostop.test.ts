import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CloudDriver, EngineSpec } from '../src/cloud.js';
import { api, createTournament, engineToken, expectOk, joinAsGuest, signup, startHarness, TestSocket, type Harness } from './helpers.js';

class FakeDriver implements CloudDriver {
  readonly name = 'fake';
  started: EngineSpec[] = [];
  running = new Set<string>();
  stopped: string[] = [];
  async start(spec: EngineSpec) {
    this.started.push(spec);
    const id = `c${this.started.length}`;
    this.running.add(id);
    return id;
  }
  async stop(id: string) {
    this.running.delete(id);
    this.stopped.push(id);
  }
  async isRunning(id: string) {
    return this.running.has(id);
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('V7 cost saving: Cloud OBS stops when the show is not live; phones pause after the show', () => {
  let h: Harness;
  const driver = new FakeDriver();
  let owner: { token: string; orgId: string };
  let tid: string;
  let director: TestSocket;
  let phone: TestSocket;
  let engine: TestSocket;

  before(async () => {
    h = await startHarness({ cloudDriver: driver, env: { CLOUD_ENGINE_IDLE_STOP_SEC: '2', CLOUD_ENGINE_IDLE_WARN_SEC: '1', CLOUD_ENGINE_START_TIMEOUT_SEC: '3' } });
    owner = await signup(h, 'mohit@icca.test', 'ICCA');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'New Test Event', mode: 'cloud' });
    director = await TestSocket.open(h.wsUrl, owner.token);
    director.send({ type: 'subscribe', tournamentId: tid });
    await director.type('snapshot');
    // A camera phone joins and keeps sending video.
    const guest = await joinAsGuest(h, owner.token, tid, 'camera', 'phone-0001-abcd');
    const cam = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/cameras/register`, { name: 'Cam 1', deviceId: 'phone-0001-abcd', platform: 'android' }, guest), 201);
    phone = await TestSocket.open(h.wsUrl, guest);
    phone.send({ type: 'camera.join', cameraId: cam.camera.id });
    await phone.type('camera.joined');
    phone.send({ type: 'telemetry', telemetry: { state: 'live', bitrateKbps: 2500 } });
  });
  after(async () => {
    for (const s of [director, phone, engine]) s?.close();
    await h.close();
  });

  it('counts only from when Cloud OBS is ready; a phone sending video does not keep it on', async () => {
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/cloud-engine/start`, undefined, owner.token));
    await wait(1200);
    await h.app.cloud.tick();
    assert.equal(driver.stopped.length, 0, 'still booting: not counted as idle');
    engine = await TestSocket.open(h.wsUrl, await engineToken(h, tid));
    engine.send({ type: 'engine.hello' });
    await engine.type('engine.config');
    const run = await director.next((m) => m.type === 'production' && m.production.cloud.status === 'running');
    assert.ok(run.production.cloud.autoStopAt, 'the idle countdown is shown');
    assert.equal(run.production.cloud.autoStopAfterIdleSec, 2);
    assert.equal(h.app.hub.isBusy(tid), false, 'the phone sending video is not "live"');
  });

  it('a director working in the control room restarts the count', async () => {
    const before = Date.parse((await expectOk(api(h, 'GET', `/api/tournaments/${tid}/state`, undefined, owner.token))).production.cloud.autoStopAt);
    await wait(600);
    director.send({ type: 'command', action: 'fallback', requestId: 'r1' });
    await wait(150);
    const after = Date.parse((await expectOk(api(h, 'GET', `/api/tournaments/${tid}/state`, undefined, owner.token))).production.cloud.autoStopAt);
    assert.ok(after - before >= 500, `${after - before}`);
  });

  it('live: never stops; after End broadcast it warns, Keep running restarts the count, then it stops and the phones pause', async () => {
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, streaming: { active: true } } });
    await director.next((m) => m.type === 'production' && m.production.cloud.autoStopAt === null);
    await wait(2200);
    await h.app.cloud.tick();
    assert.equal(driver.stopped.length, 0, 'never while live');

    // End broadcast: the count starts.
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, streaming: { active: false } } });
    await h.app.cloud.tick();
    await wait(1100);
    await h.app.cloud.tick();
    const warn = await director.next((m) => m.type === 'alert' && /stops in .* because the show is not live/.test(m.message));
    assert.equal(warn.level, 'warning');
    const kept = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/cloud-engine/keep`, {}, owner.token));
    assert.equal(kept.kept, true);
    assert.ok(Date.parse(kept.production.cloud.autoStopAt) - Date.now() > 1500, 'Keep running gives the full time again');
    await wait(1200);
    await h.app.cloud.tick();
    assert.equal(driver.stopped.length, 0, 'kept running');
    await wait(1000);
    await h.app.cloud.tick();
    assert.deepEqual(driver.stopped, ['c1']);
    await director.next((m) => m.type === 'alert' && /Cloud OBS stopped: the show was not live/.test(m.message));
    const p = await phone.next((m) => m.type === 'camera.pause');
    assert.match(p.message, /show has ended/);
    assert.equal((await expectOk(api(h, 'POST', `/api/tournaments/${tid}/cloud-engine/keep`, {}, owner.token))).kept, false, 'nothing to keep once stopped');
  });

  it('the next Start show tells the phones to send again; a phone joining while paused is told to wait', async () => {
    const late = await joinAsGuest(h, owner.token, tid, 'camera', 'phone-0002-abcd');
    const cam2 = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/cameras/register`, { name: 'Cam 2', deviceId: 'phone-0002-abcd', platform: 'ios' }, late), 201);
    const p2 = await TestSocket.open(h.wsUrl, late);
    p2.send({ type: 'camera.join', cameraId: cam2.camera.id });
    await p2.next((m) => m.type === 'camera.pause');
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/cloud-engine/start`, undefined, owner.token));
    await phone.next((m) => m.type === 'camera.resume');
    await p2.next((m) => m.type === 'camera.resume');
    p2.close();
  });

  it('a Cloud OBS that never connects is stopped instead of billing for nothing', async () => {
    engine.close();
    await wait(3200);
    await h.app.cloud.tick();
    assert.deepEqual(driver.stopped, ['c1', 'c2']);
    await director.next((m) => m.type === 'alert' && /did not start in time/.test(m.message));
  });

  it('Laptop OBS: the phones pause a while after End broadcast, unless the show goes live again', async () => {
    const lt = await createTournament(h, owner.token, owner.orgId, { name: 'Laptop show', mode: 'laptop' });
    const g = await joinAsGuest(h, owner.token, lt, 'camera', 'phone-0003-abcd');
    const c = await expectOk(api(h, 'POST', `/api/tournaments/${lt}/cameras/register`, { name: 'Cam L', deviceId: 'phone-0003-abcd', platform: 'android' }, g), 201);
    const ph = await TestSocket.open(h.wsUrl, g);
    ph.send({ type: 'camera.join', cameraId: c.camera.id });
    await ph.type('camera.joined');
    const eng = await TestSocket.open(h.wsUrl, await engineToken(h, lt));
    eng.send({ type: 'engine.hello' });
    await eng.type('engine.config');
    const live = (on: boolean) => eng.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, streaming: { active: on } } });
    live(true); await wait(100); live(false); await wait(800); live(true); await wait(100); live(false);
    await wait(1200);
    assert.equal((ph as any).queue.filter((m: any) => m.type === 'camera.pause').length, 0, 'going live again cancelled the first pause');
    await ph.next((m) => m.type === 'camera.pause', 3000);
    ph.close();
    eng.close();
  });
});
