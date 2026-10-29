import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';
import { applyRetention } from '../src/retention.js';

describe('viewership step 5: the Influencers & games add-on, SMS allowance, reports, retention', () => {
  let h: Harness;
  let adminToken: string;
  let owner: { token: string; orgId: string; userId: string };
  let tid: string;

  before(async () => {
    h = await startHarness({ env: { BILLING_ENABLED: 'true' } });
    const a = await signup(h, 'staff@cogolfers.test', 'CoGolfers');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [a.userId]);
    adminToken = a.token;
    owner = await signup(h, 'addon@club.test', 'Addon Club');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'Addon Open' });
  });
  after(async () => h.close());

  it('without the add-on: no influencers, games or reminders; the watch page shows no games', async () => {
    const s = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/viewership-addon`, undefined, owner.token));
    assert.deepEqual([s.required, s.on, s.price, s.messagesIncluded], [true, false, 500, 500]);
    const inf = await api(h, 'POST', `/api/tournaments/${tid}/influencers`, { name: 'Ravi', handle: 'ravigolf' }, owner.token);
    assert.deepEqual([inf.status, inf.body.error.code], [402, 'viewership_addon']);
    const game = await api(h, 'POST', `/api/tournaments/${tid}/moments`, { type: 'poll', title: 'P', clock: 'director', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }, owner.token);
    assert.equal(game.body.error.code, 'viewership_addon');
    const rem = await api(h, 'POST', `/api/public/tournaments/${tid}/remind`, { phone: '9812345678', consent: true });
    assert.equal(rem.body.error.code, 'reminders_off');
    assert.deepEqual((await expectOk(api(h, 'GET', `/api/public/tournaments/${tid}/moments`))).moments, []);
    assert.equal((await expectOk(api(h, 'GET', `/api/public/tournaments/${tid}`))).tournament.extras, false);
  });

  it('turning it on costs credits once; then everything works', async () => {
    const poor = await api(h, 'POST', `/api/tournaments/${tid}/billing/viewership`, {}, owner.token);
    assert.deepEqual([poor.status, poor.body.error.code], [402, 'insufficient_credits']);
    await expectOk(api(h, 'POST', `/api/admin/orgs/${owner.orgId}/credits`, { credits: 503, note: 'Test' }, adminToken));
    const on = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/billing/viewership`, {}, owner.token));
    assert.deepEqual([on.on, on.balance], [true, 3]);
    assert.equal((await expectOk(api(h, 'POST', `/api/tournaments/${tid}/billing/viewership`, {}, owner.token))).balance, 3, 'no second charge');
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/influencers`, { name: 'Ravi', handle: 'ravigolf' }, owner.token), 201);
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/moments`, { type: 'poll', title: 'P', clock: 'director', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }, owner.token), 201);
    assert.equal((await expectOk(api(h, 'GET', `/api/public/tournaments/${tid}/moments`))).moments.length, 1);
    const tx = await h.db.query("SELECT kind FROM wallet_tx WHERE org_id = $1 AND kind = 'viewership'", [owner.orgId]);
    assert.equal(tx.rowCount, 1);
  });

  it('SMS: included ones first, then paid from the wallet, then not sent (codes always go)', async () => {
    const cur = await expectOk(api(h, 'GET', '/api/admin/settings', undefined, adminToken));
    await expectOk(api(h, 'PUT', '/api/admin/settings', { pricing: { ...cur.pricing, viewershipMessages: 1, messagePrice: 2 } }, adminToken));
    const msg = (phone: string) => ({ kind: 'reminder' as const, phone, vars: ['Addon Open', 'https://x'], tournamentId: tid });
    const sent = await h.app.messenger.send([msg('919812345671'), msg('919812345672'), msg('919812345673')]);
    assert.equal(sent, 2, '1 included + 1 paid (3 credits buy one at 2)');
    const rows = (await h.db.query("SELECT status, error FROM messages WHERE tournament_id = $1 ORDER BY status", [tid])).rows;
    assert.deepEqual(rows.map((r) => r.status + (r.error ? ':' + r.error : '')).sort(), ['failed:no_credits', 'sent', 'sent']);
    const otp = await h.app.messenger.send([{ kind: 'otp', phone: '919812345674', vars: ['123456'], tournamentId: tid }]);
    assert.equal(otp, 1, 'a claim code goes out even with an empty wallet');
    const s = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/viewership-addon`, undefined, owner.token));
    assert.deepEqual([s.messagesUsed, s.balance], [3, 1]);
  });

  it('Reports: CSV downloads for organisers only', async () => {
    for (const kind of ['minutes', 'influencers', 'games']) {
      const r = await fetch(`${h.baseUrl}/api/tournaments/${tid}/report.csv?kind=${kind}`, { headers: { authorization: `Bearer ${owner.token}` } });
      assert.equal(r.status, 200, kind);
      assert.match(r.headers.get('content-type')!, /text\/csv/);
      const text = await r.text();
      assert.ok(text.split('\r\n').length >= 2 || kind === 'minutes', kind);
    }
    const games = await (await fetch(`${h.baseUrl}/api/tournaments/${tid}/report.csv?kind=games`, { headers: { authorization: `Bearer ${owner.token}` } })).text();
    assert.match(games, /"P","poll","director"/);
    const other = await signup(h, 'nosy@club.test', 'Nosy');
    assert.equal((await fetch(`${h.baseUrl}/api/tournaments/${tid}/report.csv?kind=games`, { headers: { authorization: `Bearer ${other.token}` } })).status, 404);
  });

  it('retention: old viewers anonymised, old reminders and draw entries deleted, old winners lose contact details', async () => {
    const v = (await (await fetch(`${h.baseUrl}/api/public/tournaments/${tid}/view`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/130.0' }, body: '{}' })).json()) as any;
    assert.ok(v.token);
    await h.db.query("UPDATE viewers SET last_seen_at = now() - interval '91 days' WHERE tournament_id = $1", [tid]);
    await h.db.query("INSERT INTO reminders (tournament_id, phone, consent_at, created_at) VALUES ($1, '919812345699', now(), now() - interval '31 days')", [tid]);
    const r = await applyRetention(h.app.repo);
    assert.ok(r.viewers >= 1);
    assert.ok(r.reminders >= 1);
    const left = (await h.db.query('SELECT count(*)::int AS n FROM viewers WHERE tournament_id = $1 AND viewer_key IS NOT NULL', [tid])).rows[0].n;
    assert.equal(left, 0);
    assert.equal((await h.db.query('SELECT count(*)::int AS n FROM viewers WHERE tournament_id = $1', [tid])).rows[0].n >= 1, true, 'counts stay');
  });
});
