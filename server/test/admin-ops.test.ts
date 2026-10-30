import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';

describe('V7 admin ops: SMS, platform settings, safety, data requests, viewership, system, reports', () => {
  let h: Harness;
  let admin: { token: string; userId: string; orgId: string };
  let owner: { token: string; orgId: string; userId: string };
  let tid: string;
  const sms: any[] = [];

  before(async () => {
    const msg91Fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      sms.push({ headers: init?.headers, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ type: 'success' }), { status: 200 });
    }) as typeof fetch;
    h = await startHarness({ env: { BILLING_ENABLED: 'true' }, msg91Fetch });
    admin = await signup(h, 'boss@golive.test', 'Go Live HQ');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [admin.userId]);
    owner = await signup(h, 'rahul@dlf.test', 'DLF Golf Club');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'Monsoon Open' });
  });
  after(async () => h.close());

  it('SMS: MSG91 key and templates from the admin panel, masked, used at once; test SMS; message log', async () => {
    let s = await expectOk(api(h, 'GET', '/api/admin/sms', undefined, admin.token));
    assert.deepEqual([s.source, s.live], ['none', false]);
    assert.match(s.texts.otp, /\{#var#\} is your Go Live code/);
    s = await expectOk(api(h, 'PUT', '/api/admin/sms', { authKey: 'msg91-secret-key-123', templates: { otp: 'tpl-otp', reminder: 'tpl-rem', winner: null, draw_entry: '' } }, admin.token));
    assert.deepEqual([s.source, s.live, s.authKey, s.templates.otp, s.templates.draw_entry], ['admin', true, 'msg9…-123', 'tpl-otp', null]);
    const t = await expectOk(api(h, 'POST', '/api/admin/sms/test', { phone: '98123 45678' }, admin.token));
    assert.deepEqual([t.ok, t.provider, t.to], [true, 'msg91', '91******5678']);
    assert.equal(sms[0].headers.authkey, 'msg91-secret-key-123');
    assert.equal(sms[0].body.template_id, 'tpl-otp');
    // No template for winner messages: recorded as failed, with the reason.
    await h.app.messenger.send([{ kind: 'winner', phone: '919812345679', vars: ['Cap', 'Open', 'x'], tournamentId: tid }]);
    const m = await expectOk(api(h, 'GET', '/api/admin/messages', undefined, admin.token));
    assert.equal(m.messages[0].status, 'failed');
    assert.match(m.messages[0].error, /template for winner is not set/);
    assert.equal(m.messages[0].event, 'Monsoon Open');
    assert.deepEqual([m.stats.sentMonth, m.stats.failedMonth], [1, 1]);
    const stored = (await h.db.query("SELECT value_enc FROM platform_secrets WHERE key = 'msg91'")).rows[0].value_enc;
    assert.ok(!stored.includes('msg91-secret-key-123'));
    await expectOk(api(h, 'DELETE', '/api/admin/sms', undefined, admin.token));
    assert.equal(h.app.messenger.live, false, 'back to the test sender');
  });

  it('sign-up switch: closes sign-up on the API, the app config and the website at once', async () => {
    await expectOk(api(h, 'PUT', '/api/admin/platform', { signupEnabled: false }, admin.token));
    assert.equal((await api(h, 'POST', '/api/auth/signup', { name: 'X', email: 'x@y.test', password: 'password123', orgName: 'XYZ' })).body.error.code, 'signup_disabled');
    assert.equal((await expectOk(api(h, 'GET', '/api/auth/config'))).signupEnabled, false);
    assert.match(await fetch(`${h.baseUrl}/signup`).then((r) => r.text()), /data-signup="false"/);
    await expectOk(api(h, 'PUT', '/api/admin/platform', { signupEnabled: true, costs: { fixedMonthlyInr: 20000, smsInr: 0.2 } }, admin.token));
    const p = await expectOk(api(h, 'GET', '/api/admin/platform', undefined, admin.token));
    assert.deepEqual([p.signupEnabled, p.costs.fixedMonthlyInr, p.costs.smsInr], [true, 20000, 0.2]);
    assert.ok(p.costs.cloudEngineInrPerHour > 0, 'other costs keep their defaults');
    await expectOk(api(h, 'POST', '/api/auth/signup', { name: 'X', email: 'x@y.test', password: 'password123', orgName: 'XYZ' }), 201);
  });

  it('chat across events: search, and unban an author', async () => {
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}`, { chatSlowSec: 0 }, owner.token));
    const name = await expectOk(api(h, 'POST', `/api/public/tournaments/${tid}/chat/name`, { name: 'Spammer' }));
    await expectOk(api(h, 'POST', `/api/public/tournaments/${tid}/chat`, { text: 'buy followers cheap' }, name.token));
    const c = await expectOk(api(h, 'GET', '/api/admin/chat?q=followers', undefined, admin.token));
    assert.equal(c.messages.length, 1);
    await expectOk(api(h, 'POST', `/api/chat/${c.messages[0].id}/ban`, {}, admin.token));
    assert.equal((await api(h, 'POST', `/api/public/tournaments/${tid}/chat`, { text: 'again' }, name.token)).body.error.code, 'chat_banned');
    const bans = (await expectOk(api(h, 'GET', '/api/admin/chat-bans', undefined, admin.token))).bans;
    assert.equal(bans.length, 1);
    await expectOk(api(h, 'POST', '/api/admin/chat-bans/remove', { eventId: bans[0].eventId, source: bans[0].source, authorKey: bans[0].authorKey }, admin.token));
    await expectOk(api(h, 'POST', `/api/public/tournaments/${tid}/chat`, { text: 'sorry, real question: tee times?' }, name.token));
  });

  it('data requests: filed publicly (limited), worked by admins', async () => {
    await expectOk(api(h, 'POST', '/api/public/data-requests', { email: 'Rahul@DLF.test', kind: 'delete_account', details: 'Please delete my login' }), 201);
    await expectOk(api(h, 'POST', '/api/public/data-requests', { email: 'rahul@dlf.test', kind: 'export' }), 201);
    await expectOk(api(h, 'POST', '/api/public/data-requests', { email: 'rahul@dlf.test', kind: 'export' }), 201);
    assert.equal((await api(h, 'POST', '/api/public/data-requests', { email: 'rahul@dlf.test', kind: 'export' })).status, 429);
    const list = (await expectOk(api(h, 'GET', '/api/admin/data-requests?status=open', undefined, admin.token))).requests;
    assert.equal(list.length, 3);
    assert.equal(list[0].userId, owner.userId, 'linked to the account');
    await expectOk(api(h, 'PATCH', `/api/admin/data-requests/${list[0].id}`, { status: 'done', note: 'Deleted' }, admin.token));
    assert.equal((await expectOk(api(h, 'GET', '/api/admin/data-requests?status=done', undefined, admin.token))).requests[0].doneBy, 'boss@golive.test');
  });

  it('viewership and prizes across all events', async () => {
    const view = await fetch(`${h.baseUrl}/api/public/tournaments/${tid}/view`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/130.0' }, body: '{}' }).then((r) => r.json()) as any;
    await fetch(`${h.baseUrl}/api/public/view/beat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: view.token, playingSec: 30, unmutedSec: 0 }) });
    await h.app.viewership.flush();
    const v = await expectOk(api(h, 'GET', '/api/admin/viewership?days=7', undefined, admin.token));
    assert.deepEqual([v.totals.viewers, v.topEvents[0].name], [1, 'Monsoon Open']);
    assert.deepEqual((await expectOk(api(h, 'GET', '/api/admin/wins', undefined, admin.token))).wins, []);
  });

  it('system health and margin from daily usage; every report as JSON and CSV', async () => {
    await h.db.query(`INSERT INTO usage_daily (day, tournament_id, org_id, mode, live_seconds, camera_seconds) VALUES ((now() AT TIME ZONE 'Asia/Kolkata')::date, $1, $2, 'cloud', 7200, 28800)`, [tid, owner.orgId]);
    const s = await expectOk(api(h, 'GET', '/api/admin/system', undefined, admin.token));
    assert.ok(s.database.sizeMb > 0);
    assert.equal(s.integrations.sms, 'Test sender (no MSG91 key)');
    const now = s.margin.at(-1);
    assert.deepEqual([now.cloudHours, now.cameraHours, now.costs.fixed], [2, 8, 20000]);
    assert.equal(s.margin.length, 6);
    for (const kind of ['revenue', 'usage', 'growth', 'viewership', 'sms', 'margin']) {
      const j = await expectOk(api(h, 'GET', `/api/admin/reports/${kind}?months=3`, undefined, admin.token));
      assert.ok(j.head.length > 3, kind);
      const r = await fetch(`${h.baseUrl}/api/admin/reports/${kind}.csv?months=3`, { headers: { authorization: `Bearer ${admin.token}` } });
      assert.equal(r.status, 200, kind);
      assert.match(r.headers.get('content-type')!, /text\/csv/);
    }
    const usage = await expectOk(api(h, 'GET', '/api/admin/reports/usage', undefined, admin.token));
    assert.deepEqual(usage.rows[0].slice(1, 6), ['DLF Golf Club', 1, 2, 8, 2]);
    assert.equal((await api(h, 'GET', '/api/admin/reports/nope', undefined, admin.token)).status, 400);
  });
});
