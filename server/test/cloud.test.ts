import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CloudDriver, EngineSpec } from '../src/cloud.js';
import { addStaff, api, createTournament, engineToken, expectOk, signup, startHarness, TestSocket, type Harness } from './helpers.js';

class FakeDriver implements CloudDriver {
  readonly name = 'fake';
  started: EngineSpec[] = [];
  running = new Set<string>();
  stopped: string[] = [];
  failNext = false;
  async start(spec: EngineSpec) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('no capacity');
    }
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

describe('cloud production mode', () => {
  let h: Harness;
  const driver = new FakeDriver();
  let owner: { token: string; orgId: string };
  let directorToken: string;
  let tournamentId: string;
  let director: TestSocket;

  before(async () => {
    h = await startHarness({ cloudDriver: driver, env: { CLOUD_ENGINE_IDLE_STOP_MIN: '0', ENGINE_SRT_HOST: 'mediamtx', ENGINE_SRT_PORT: '8890' } });
    owner = await signup(h, 'owner@club.test');
    directorToken = await addStaff(h, owner.token, owner.orgId, 'd@club.test', 'director');
    tournamentId = await createTournament(h, owner.token, owner.orgId, { mode: 'laptop' });
    director = await TestSocket.open(h.wsUrl, directorToken);
    director.send({ type: 'subscribe', tournamentId });
    const snap = await director.type('snapshot');
    assert.deepEqual({ mode: snap.production.mode, available: snap.production.cloudAvailable, status: snap.production.cloud.status }, { mode: 'laptop', available: true, status: 'stopped' });
  });
  after(async () => {
    director.close();
    await h.close();
  });

  it('new events default to cloud when the server can run cloud engines', async () => {
    const r = await expectOk(api(h, 'POST', `/api/orgs/${owner.orgId}/tournaments`, { name: 'Default mode' }, owner.token));
    assert.equal(r.tournament.mode, 'cloud');
  });

  it('cannot start a cloud engine in laptop mode', async () => {
    const r = await api(h, 'POST', `/api/tournaments/${tournamentId}/cloud-engine/start`, undefined, directorToken);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'not_cloud_mode');
  });

  it('switching to cloud mode, starting, and the engine connecting moves to running', async () => {
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tournamentId}`, { mode: 'cloud' }, directorToken));
    await director.next((m) => m.type === 'production' && m.production.mode === 'cloud');
    const r = await expectOk(api(h, 'POST', `/api/tournaments/${tournamentId}/cloud-engine/start`, undefined, directorToken));
    assert.equal(r.production.cloud.status, 'starting');
    const spec = driver.started[0];
    const t = await h.app.repo.tournamentById(tournamentId);
    assert.equal(spec.env.TOURNAMENT_ID, tournamentId);
    assert.equal(spec.env.ENGINE_KEY, t!.engine_key);
    assert.match(spec.env.OBS_PASSWORD, /^[0-9a-f]{24}$/);
    // Starting twice is a no-op.
    await expectOk(api(h, 'POST', `/api/tournaments/${tournamentId}/cloud-engine/start`, undefined, directorToken));
    assert.equal(driver.started.length, 1);

    const engine = await TestSocket.open(h.wsUrl, await engineToken(h, tournamentId));
    engine.send({ type: 'engine.hello' });
    const cfg = await engine.type('engine.config');
    assert.equal(cfg.mode, 'cloud');
    assert.deepEqual(cfg.canvas, { width: 1920, height: 1080, fps: 30, videoKbps: 6000 });
    await director.next((m) => m.type === 'production' && m.production.cloud.status === 'running');
    engine.close();
  });

  it('mode cannot change while the cloud engine runs', async () => {
    const r = await api(h, 'PATCH', `/api/tournaments/${tournamentId}`, { mode: 'laptop' }, directorToken);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'engine_running');
  });

  it('auto-stops when nothing is live (idle timeout), so the bill only covers event hours', async () => {
    await h.app.cloud.tick(); // first idle observation
    await new Promise((r) => setTimeout(r, 20));
    await h.app.cloud.tick(); // idle > 0 min → stop
    assert.deepEqual(driver.stopped, ['c1']);
    await director.next((m) => m.type === 'production' && m.production.cloud.status === 'stopped');
  });

  it('a crashed engine is reported; a failed start shows the reason', async () => {
    await expectOk(api(h, 'POST', `/api/tournaments/${tournamentId}/cloud-engine/start`, undefined, directorToken));
    driver.running.clear();
    await h.app.cloud.tick();
    const msg = await director.next((m) => m.type === 'production' && m.production.cloud.status === 'error');
    assert.match(msg.production.cloud.error, /stopped unexpectedly/);
    driver.failNext = true;
    const r = await api(h, 'POST', `/api/tournaments/${tournamentId}/cloud-engine/start`, undefined, directorToken);
    assert.equal(r.status, 502);
    assert.match(r.body.error.message, /no capacity/);
  });

  it('cloud engines read cameras over the internal network', async () => {
    const g = await addStaff(h, owner.token, owner.orgId, 'cam@club.test', 'camera');
    await expectOk(api(h, 'POST', `/api/tournaments/${tournamentId}/cameras/register`, { name: 'C', deviceId: 'dev-cam-0001', platform: 'ios' }, g));
    const cfg = await h.app.hub.engineConfig((await h.app.repo.tournamentById(tournamentId))!);
    assert.ok(cfg.cameras[0].srtUrl.startsWith('srt://mediamtx:8890?'));
  });
});
