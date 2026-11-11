import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';
import { SIMPLE_PLAN, extraCamerasCc, extraDestinationsCc } from '../src/billing.js';

describe('V9 simple pricing: one live rate, extras per minute while on, watch-page viewers only, welcome credits', () => {
  let h: Harness;
  let now = Date.parse('2026-11-11T05:00:00Z');
  let adminToken: string;
  let owner: { token: string; orgId: string; userId: string };
  let tid: string;
  let live: string[] = [];
  let camsLive = 4;
  let dests = 2;
  const alerts: string[] = [];
  // The meter counts at most 30 s per pass (a stalled server never bills time it did not see).
  const tick = async (sec = 60) => {
    for (let left = sec; left > 0; left -= 30) {
      now += Math.min(30, left) * 1000;
      await h.app.billing.tick();
    }
  };
  const wallet = async () => expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/billing`, undefined, owner.token));
  const state = async () => (await expectOk(api(h, 'GET', `/api/tournaments/${tid}/billing`, undefined, owner.token))).billing;

  before(async () => {
    h = await startHarness({ env: { BILLING_ENABLED: 'true' }, billingClock: () => now });
    const a = await signup(h, 'staff@simple.test', 'Go Live');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [a.userId]);
    adminToken = a.token;
    h.app.billing.hooks = { streaming: () => live, alert: (_t, _l, m) => alerts.push(m), stop: () => { live = []; }, changed: () => {} };
    h.app.billing.liveCameraCounter = async () => camsLive;
    h.app.billing.destinationCounter = async () => dests;
  });
  after(async () => h.close());

  it('extras maths: only what is beyond the included ones', () => {
    assert.equal(extraCamerasCc(4, SIMPLE_PLAN), 400, '2 extra × 2 credits');
    assert.equal(extraCamerasCc(1, SIMPLE_PLAN), 0);
    assert.equal(extraDestinationsCc(3, SIMPLE_PLAN), 200);
    assert.equal(extraCamerasCc(9, { ...SIMPLE_PLAN, cameraMinutePrice: 0 }), 0, 'off: slots are used instead');
  });

  it('admin gets the simple plan and saves it', async () => {
    const s = await expectOk(api(h, 'GET', '/api/admin/settings', undefined, adminToken));
    assert.equal(s.simplePlan.minutePrice, 6);
    assert.equal(s.simplePlan.chargeSocialViewers, false);
    assert.equal(s.pricing.cameraMinutePrice, 0, 'off until the admin switches');
    const saved = await expectOk(api(h, 'PUT', '/api/admin/settings', { pricing: s.simplePlan }, adminToken));
    assert.equal(saved.pricing.welcomeCredits, 300);
    const pub = await expectOk(api(h, 'GET', '/api/public/pricing'));
    assert.equal(pub.pricing.destinationMinutePrice, 1, 'the website reads the new prices');
  });

  it('a new club gets the welcome credits once, on its wallet history', async () => {
    owner = await signup(h, 'owner@simple.test', 'Simple Club');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'Sunday Medal' });
    const w = await wallet();
    assert.equal(w.balance, 300);
    const welcome = w.transactions.filter((t: any) => t.kind === 'welcome');
    assert.equal(welcome.length, 1);
    assert.equal(welcome[0].credits, 300);
    // Reading the wallet again does not add them again.
    assert.equal((await wallet()).balance, 300);
  });

  it('no slots to buy: any number of cameras and destinations can be switched on', async () => {
    const t = (await h.app.repo.tournamentById(tid))!;
    assert.equal(await h.app.billing.cameraLimit(t), null);
    assert.equal(await h.app.billing.destinationLimit(t), null);
    const s = await state();
    assert.equal(s.cameras.perMinute, 2);
    assert.equal(s.destinations.perMinute, 1);
    assert.equal(s.canGoLive, true, '2 destinations in use does not block going live');
  });

  it('while live: live rate + extra cameras sending video + extra destinations + watch-page viewers; YouTube viewers free', async () => {
    live = [tid];
    await tick(30); // session starts
    await h.db.query("INSERT INTO viewers (tournament_id, viewer_key, live_sec) VALUES ($1, 'w-1', 600)", [tid]);
    await h.db.query('INSERT INTO viewer_minutes (tournament_id, at, watching, unmuted, youtube, facebook) VALUES ($1, now(), 1, 0, 500, 300)', [tid]);
    await tick(); // one minute
    // 6 live + (4-2)×2 cameras + (2-1)×1 destination + 10 watch-page viewer-minutes × 0.1333.
    const w = await wallet();
    assert.equal(w.balance, Math.round((300 - 6 - 4 - 1 - 1.33) * 100) / 100);
    const kinds = Object.fromEntries(w.transactions.filter((t: any) => t.tournamentName === 'Sunday Medal').map((t: any) => [t.kind, t.credits]));
    assert.deepEqual(kinds, { minutes: -6, cameras: -4, destinations: -1, viewers: -1.33 });
    const s = await state();
    assert.equal(s.viewers.minutes, 10, 'YouTube and Facebook viewers are not counted for billing');
    assert.equal(s.cameras.liveNow, 4);
    assert.ok(s.perMinuteNow >= 11 && s.perMinuteNow <= 13, `about 11 + viewers a minute now (${s.perMinuteNow})`);
  });

  it('an extra camera is charged only while it sends video; half minutes accrue exactly', async () => {
    camsLive = 3; // one extra now
    dests = 1; // no extra
    const before = (await wallet()).balance;
    await tick(60);
    assert.equal(Math.round(((await wallet()).balance - before) * 100) / 100, -8, '6 live + 2 for one extra camera over a minute');
    const tx = (await wallet()).transactions.filter((t: any) => t.kind === 'cameras');
    assert.equal(tx.length, 1, 'one growing line per broadcast');
    assert.equal(tx[0].credits, -6);
  });

  it('branding: one purchase turns on logo, watermark and ticker', async () => {
    const t = (await h.app.repo.tournamentById(tid))!;
    await h.app.billing.buyAddon(t, 'ticker', owner.userId);
    const t2 = (await h.app.repo.tournamentById(tid))!;
    assert.equal(await h.app.billing.addonOn(t2, 'branding'), true);
    assert.equal(await h.app.billing.addonOn(t2, 'ticker'), true);
    await h.app.billing.buyAddon(t2, 'branding', owner.userId);
    const tx = (await wallet()).transactions.filter((x: any) => x.kind === 'branding' || x.kind === 'ticker');
    assert.equal(tx.length, 1, 'charged once');
    assert.equal(tx[0].credits, -199);
  });

  it('extras the wallet cannot pay: grace like live minutes, and written off when the show ends', async () => {
    camsLive = 12; // 10 extra = 20 a minute
    await h.db.query('UPDATE org_billing SET balance_cc = 1000 WHERE org_id = $1', [owner.orgId]); // 10 credits
    await tick();
    assert.ok(alerts.some((a) => /Credits finished/.test(a)));
    for (let i = 0; i < 6 && live.length; i++) await tick();
    assert.deepEqual(live, [], 'stopped after the grace minutes');
    await tick(30); // session closes
    const t = (await h.app.repo.tournamentById(tid))!;
    assert.equal(Number(t.cam_cc_accrued), Number(t.cam_cc_billed), 'unpaid extras written off');
  });

  it('per-club override can switch YouTube/Facebook viewer charging back on', async () => {
    await expectOk(api(h, 'PATCH', `/api/admin/orgs/${owner.orgId}/billing`, { overrides: { chargeSocialViewers: true } }, adminToken));
    const w = await wallet();
    assert.equal(w.pricing.chargeSocialViewers, true);
  });
});
