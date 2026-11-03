import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';
import { DEFAULT_PRICING, viewerCostCc } from '../src/billing.js';

describe('viewer-minute billing: X credits per viewer-minute, tiers, welcome allowance', () => {
  let h: Harness;
  let now = Date.parse('2026-11-03T05:00:00Z');
  let adminToken: string;
  let owner: { token: string; orgId: string; userId: string };
  let tid: string;
  let live: string[] = [];
  const alerts: string[] = [];
  const minute = (n: number) => new Date(Date.parse('2026-11-03T05:00:00Z') + n * 60_000);
  const tick = async (sec = 30) => {
    now += sec * 1000;
    await h.app.billing.tick();
  };
  const balance = async () => (await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/billing`, undefined, owner.token))).balance as number;
  const state = async () => (await expectOk(api(h, 'GET', `/api/tournaments/${tid}/billing`, undefined, owner.token))).billing;

  before(async () => {
    h = await startHarness({ env: { BILLING_ENABLED: 'true' }, billingClock: () => now });
    const a = await signup(h, 'staff@golive.test', 'Go Live');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [a.userId]);
    adminToken = a.token;
    // Only viewer-minutes cost anything here: X = 0.1, tier 2 from 100 at 50%, tier 3 from 200 at 20%, 10 free for a new club.
    await expectOk(api(h, 'PUT', '/api/admin/settings', {
      pricing: { ...DEFAULT_PRICING, freeMinutes: 0, minutePrice: 0, viewerMinutePrice: 0.1, viewerTier2From: 100, viewerTier2Pct: 50, viewerTier3From: 200, viewerTier3Pct: 20, welcomeViewerMinutes: 10 },
    }, adminToken));
    owner = await signup(h, 'owner@viewers.test', 'Viewers Club');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'Big Final' });
    await expectOk(api(h, 'POST', `/api/admin/orgs/${owner.orgId}/credits`, { credits: 100, note: 'test' }, adminToken));
    h.app.billing.hooks = { streaming: () => live, alert: (_t, _l, m) => alerts.push(m), stop: () => { live = []; }, changed: () => {} };
  });
  after(async () => h.close());

  it('tiers are cumulative within an event', () => {
    const p = { ...DEFAULT_PRICING, viewerMinutePrice: 0.1, viewerTier2From: 100, viewerTier2Pct: 50, viewerTier3From: 200, viewerTier3Pct: 20 };
    assert.equal(viewerCostCc(50, p), 500);
    assert.equal(viewerCostCc(320, p), 1000 + 500 + 240);
    assert.equal(viewerCostCc(320, { ...p, viewerTier2From: 0, viewerTier3From: 0 }), 3200, '0 = no tiers');
    assert.equal(viewerCostCc(1000, { ...p, viewerMinutePrice: 0 }), 0);
  });

  it('a new club gets its welcome viewer-minutes once; admin can change them', async () => {
    const b = await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/billing`, undefined, owner.token));
    assert.equal(b.freeViewerMinutes, 10);
    assert.equal(b.pricing.viewerMinutePrice, 0.1);
  });

  it('watch page (exact seconds) + YouTube + Facebook viewer-minutes: free ones first, then X with tiers, one ledger line', async () => {
    live = [tid];
    await tick(); // session starts
    // 20 YouTube viewers for a minute, and one watch-page viewer who watched 10 minutes live.
    await h.db.query('INSERT INTO viewer_minutes (tournament_id, at, watching, unmuted, youtube) VALUES ($1, $2, 1, 0, 20)', [tid, minute(1)]);
    await h.db.query("INSERT INTO viewers (tournament_id, viewer_key, live_sec) VALUES ($1, 'vk-1', 600)", [tid]);
    // A flagged viewer (bot / over the network cap) is not charged.
    await h.db.query("INSERT INTO viewers (tournament_id, viewer_key, live_sec, flagged) VALUES ($1, 'vk-bot', 6000, true)", [tid]);
    await tick();
    let s = await state();
    assert.deepEqual([s.viewers.minutes, s.viewers.freeUsed, s.viewers.billable, s.viewers.freeLeft], [30, 10, 20, 0]);
    assert.equal(await balance(), 98, '20 billable × 0.1');
    // 300 Facebook viewers for a minute: 320 billable = 100 × 0.1 + 100 × 0.05 + 120 × 0.02.
    await h.db.query('INSERT INTO viewer_minutes (tournament_id, at, watching, unmuted, facebook) VALUES ($1, $2, 0, 0, 300)', [tid, minute(2)]);
    await tick();
    assert.equal(await balance(), 82.6);
    s = await state();
    assert.equal(s.viewers.minutes, 330);
    assert.ok(s.minutes.remainingSeconds !== null, 'time left at this audience is estimated');
    const tx = (await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/billing`, undefined, owner.token))).transactions.filter((t: any) => t.kind === 'viewers');
    assert.equal(tx.length, 1, 'one growing line per broadcast');
    assert.deepEqual([tx[0].credits, tx[0].quantity, tx[0].tournamentName], [-17.4, 320, 'Big Final']);
  });

  it('when the wallet cannot pay viewer-minutes: grace, then the show ends; the unpaid part is written off', async () => {
    await h.db.query('INSERT INTO viewer_minutes (tournament_id, at, watching, unmuted, facebook) VALUES ($1, $2, 0, 0, 10000)', [tid, minute(3)]);
    await tick();
    assert.ok(alerts.some((a) => /Credits finished\. The broadcast will end in 5 minutes/.test(a)));
    assert.equal(await balance(), 82.6, 'nothing taken when it cannot be paid in full');
    for (let i = 0; i < 11; i++) await tick();
    assert.ok(alerts.some((a) => /grace period is over/.test(a)));
    assert.deepEqual(live, [], 'broadcast stopped');
    await tick(); // session closes
    const t = (await h.app.repo.tournamentById(tid))!;
    assert.equal(Number(t.viewer_cc_billed), Math.floor(viewerCostCc(10320, { ...DEFAULT_PRICING, viewerMinutePrice: 0.1, viewerTier2From: 100, viewerTier2Pct: 50, viewerTier3From: 200, viewerTier3Pct: 20 })));
    assert.equal(await balance(), 82.6, 'unpaid grace viewer-minutes are not taken later');
  });

  it('admin: free viewer-minutes per club, per-club X override, tier check', async () => {
    const r = await expectOk(api(h, 'PATCH', `/api/admin/orgs/${owner.orgId}/billing`, { freeViewerMinutes: 50, overrides: { viewerMinutePrice: 0.5 } }, adminToken));
    assert.deepEqual([r.freeViewerMinutes, r.pricing.viewerMinutePrice], [50, 0.5]);
    const club = await expectOk(api(h, 'GET', `/api/admin/orgs/${owner.orgId}`, undefined, adminToken));
    assert.equal(club.tournaments[0].viewerMinutes, 10330);
    const bad = await api(h, 'PUT', '/api/admin/settings', { pricing: { ...DEFAULT_PRICING, viewerTier2From: 500, viewerTier3From: 400 } }, adminToken);
    assert.equal(bad.body.error.code, 'bad_tiers');
    assert.equal((await api(h, 'PUT', '/api/admin/settings', { pricing: { ...DEFAULT_PRICING, viewerMinutePrice: 1.5 } }, adminToken)).status, 400, 'X is at most 1 credit');
  });
});
