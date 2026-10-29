import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { addStaff, api, createTournament, engineToken, expectOk, joinAsGuest, signup, startHarness, TestSocket, type Harness } from './helpers.js';

/** Fake Cashfree PG: create order, get order (status controlled by the test). */
function fakeCashfree() {
  const orders = new Map<string, { amount: number; status: string; body: any; headers: Record<string, string> }>();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (headers['x-client-id'] !== 'cf-app' || headers['x-client-secret'] !== 'cf-secret') return json(401, { message: 'authentication Failed' });
    if (url.pathname === '/pg/orders' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      orders.set(body.order_id, { amount: body.order_amount, status: 'ACTIVE', body, headers });
      return json(200, { cf_order_id: 991, order_id: body.order_id, order_status: 'ACTIVE', payment_session_id: `session_${body.order_id}` });
    }
    const m = url.pathname.match(/^\/pg\/orders\/([^/]+)$/);
    if (m && (init?.method ?? 'GET') === 'GET') {
      const o = orders.get(m[1]);
      if (!o) return json(404, { message: 'order not found' });
      return json(200, { order_id: m[1], order_status: o.status, order_amount: o.amount, order_currency: 'INR' });
    }
    return json(404, { message: `fake: no route ${url.pathname}` });
  }) as typeof fetch;
  return { fetchImpl, orders };
}

describe('billing: free allowance, extra cameras, live minutes, credits, Cashfree, admin', () => {
  let h: Harness;
  let now = Date.parse('2026-10-24T05:00:00Z');
  const cf = fakeCashfree();
  let owner: { token: string; orgId: string; userId: string };
  let adminToken: string;
  let directorToken: string;
  let tid: string;
  let director: TestSocket;
  let engine: TestSocket;
  const advance = async (seconds: number) => {
    // The meter runs every few seconds in production; step it in 30 s slices.
    for (let s = 0; s < seconds; s += 30) {
      now += Math.min(30, seconds - s) * 1000;
      await h.app.billing.tick();
    }
  };
  const balance = async () => (await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/billing`, undefined, owner.token))).balance as number;
  const registerCam = (token: string, device: string, name: string) =>
    api(h, 'POST', `/api/tournaments/${tid}/cameras/register`, { name, deviceId: device, platform: 'android' }, token);
  const setStreaming = (active: boolean) =>
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true, streaming: { active, reconnecting: false } } });
  /** "Go live" that billing should refuse: the engine never hears about it. */
  const refusedGoLive = async (requestId: string) => {
    director.send({ type: 'command', action: 'stream.start', requestId });
    const res = await director.next((m) => m.type === 'command.result' && m.requestId === requestId);
    assert.equal(res.ok, false);
    return res;
  };
  const goLive = async (requestId: string) => {
    director.send({ type: 'command', action: 'stream.start', requestId });
    const cmd = await engine.next((m) => m.type === 'command' && m.action === 'stream.start');
    engine.send({ type: 'command.result', id: cmd.id, ok: true });
    setStreaming(true);
    const res = await director.next((m) => m.type === 'command.result' && m.requestId === requestId);
    await waitFor(() => h.app.hub.streamingTournaments().includes(tid));
    await h.app.billing.tick(); // session starts
    return res;
  };

  before(async () => {
    h = await startHarness({
      env: { BILLING_ENABLED: 'true', CASHFREE_CLIENT_ID: 'cf-app', CASHFREE_CLIENT_SECRET: 'cf-secret', CASHFREE_API_BASE: 'https://cf.fake/pg' },
      cashfreeFetch: cf.fetchImpl,
      billingClock: () => now,
    });
    const a = await signup(h, 'staff@cogolfers.test', 'CoGolfers');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [a.userId]);
    adminToken = a.token;
    owner = await signup(h, 'owner@club.test', 'DLF Golf Club');
    directorToken = await addStaff(h, owner.token, owner.orgId, 'dir@club.test', 'director');
    tid = await createTournament(h, directorToken, owner.orgId, { name: 'Monsoon Open' });
  });
  after(async () => {
    director?.close();
    engine?.close();
    await h.close();
  });

  it('only CoGolfers admins reach the admin API; admin sets pricing and credit packs', async () => {
    assert.equal((await api(h, 'GET', '/api/admin/overview', undefined, owner.token)).status, 403);
    assert.equal((await api(h, 'GET', '/api/admin/overview')).status, 401);
    const s = await expectOk(api(h, 'GET', '/api/admin/settings', undefined, adminToken));
    assert.deepEqual(s.pricing, { freeCameras: 2, freeMinutes: 10, cameraPrice: 100, minutePrice: 5, graceMinutes: 5, freeDestinations: 1, destinationPrice: 50, viewershipPrice: 500, viewershipMessages: 500, messagePrice: 1 });
    const bad = await api(h, 'PUT', '/api/admin/settings', { packs: [{ id: 'a', label: 'A', priceInr: 100, credits: 100 }, { id: 'a', label: 'B', priceInr: 200, credits: 200 }] }, adminToken);
    assert.equal(bad.body.error.code, 'duplicate_pack');
    await expectOk(
      api(h, 'PUT', '/api/admin/settings', {
        pricing: { freeCameras: 2, freeMinutes: 10, cameraPrice: 100, minutePrice: 2.5, graceMinutes: 5 },
        packs: [{ id: 'p500', label: 'Starter', priceInr: 500, credits: 500 }, { id: 'p1000', label: 'Club', priceInr: 1000, credits: 1100 }],
      }, adminToken),
    );
    const b = await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/billing`, undefined, directorToken));
    assert.equal(b.pricing.minutePrice, 2.5);
    assert.equal(b.packs.length, 2);
    assert.equal(b.balance, 0);
    assert.equal(b.paymentsEnabled, true);
    assert.equal(b.details, null, 'billing details are for the owner only');
  });

  it('2 cameras free per tournament; the third needs a bought slot', async () => {
    const cam = await joinAsGuest(h, directorToken, tid, 'camera', 'cam-device-1');
    await expectOk(registerCam(cam, 'cam-device-1', 'Tee 1'));
    await expectOk(registerCam(directorToken, 'cam-device-2', 'Green 1'));
    const third = await registerCam(directorToken, 'cam-device-3', 'Fairway 9');
    assert.equal(third.status, 402);
    assert.equal(third.body.error.code, 'camera_limit');
    await expectOk(registerCam(cam, 'cam-device-1', 'Tee 1 (renamed)'), 200); // same phone again: still its slot

    const poor = await api(h, 'POST', `/api/tournaments/${tid}/billing/cameras`, { count: 1 }, directorToken);
    assert.equal(poor.status, 402);
    assert.equal(poor.body.error.code, 'insufficient_credits');

    assert.equal((await expectOk(api(h, 'POST', `/api/admin/orgs/${owner.orgId}/credits`, { credits: 150, note: 'Launch offer' }, adminToken))).balance, 150);
    const bought = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/billing/cameras`, { count: 1 }, directorToken));
    assert.deepEqual([bought.billing.cameras.limit, bought.billing.cameras.extra, bought.billing.balance], [3, 1, 50]);
    await expectOk(registerCam(directorToken, 'cam-device-3', 'Fairway 9'));
    assert.equal((await registerCam(directorToken, 'cam-device-4', 'Clubhouse')).status, 402);

    const other = await createTournament(h, directorToken, owner.orgId, { name: 'Next Week' });
    const t2 = await expectOk(api(h, 'GET', `/api/tournaments/${other}/billing`, undefined, directorToken));
    assert.equal(t2.billing.cameras.limit, 2, 'slots are bought per tournament');

    const scorer = await joinAsGuest(h, directorToken, tid, 'scorer', 'scorer-1');
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/billing/cameras`, { count: 1 }, scorer)).status, 403);
  });

  it('10 live minutes free, then each started minute is charged to one ledger line', async () => {
    director = await TestSocket.open(h.wsUrl, directorToken);
    director.send({ type: 'subscribe', tournamentId: tid });
    const snap = await director.type('snapshot');
    assert.equal(snap.billing.minutes.free, 10);
    assert.equal(snap.billing.minutes.remainingSeconds, 600 + 20 * 60, '10 free + 50 credits / 2.5 = 20 paid minutes');
    engine = await TestSocket.open(h.wsUrl, await engineToken(h, tid));
    engine.send({ type: 'engine.hello' });
    await engine.type('engine.config');
    engine.send({ type: 'engine.state', state: { obsConnected: true, studioMode: true } });
    await director.next((m) => m.type === 'engine' && m.engine.obsConnected);

    assert.equal((await goLive('live-1')).ok, true);
    await advance(600);
    assert.equal(await balance(), 50, 'first 10 minutes free');
    await advance(1);
    assert.equal(await balance(), 47.5, 'minute 11 charged when it starts');
    await advance(119);
    assert.equal(await balance(), 45);
    const tx = (await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/billing`, undefined, owner.token))).transactions;
    const minutes = tx.filter((t: any) => t.kind === 'minutes');
    assert.equal(minutes.length, 1, 'one growing line per broadcast');
    assert.deepEqual([minutes[0].quantity, minutes[0].credits, minutes[0].tournamentName], [2, -5, 'Monsoon Open']);
    const msg = await director.next((m) => m.type === 'billing');
    assert.equal(msg.billing.enabled, true);
  });

  it('warns at 10 and 2 minutes left, grace period, then ends the broadcast', async () => {
    await expectOk(api(h, 'POST', `/api/admin/orgs/${owner.orgId}/credits`, { credits: -20, note: 'test' }, adminToken)); // 25 left = 10 minutes
    director.drain();
    await advance(30);
    const w10 = await director.next((m) => m.type === 'alert' && m.level === 'warning');
    assert.match(w10.message, /About 10 minutes of live time left/);
    await advance(8 * 60);
    const w2 = await director.next((m) => m.type === 'alert' && m.level === 'warning');
    assert.match(w2.message, /About 2 minutes/);
    await advance(150);
    const out = await director.next((m) => m.type === 'alert' && m.level === 'error');
    assert.match(out.message, /Credits finished\. The broadcast will end in 5 minutes/);
    assert.equal(await balance(), 0);
    const st = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/billing`, undefined, directorToken));
    assert.equal(st.billing.grace.active, true);

    await advance(5 * 60);
    const stop = await engine.next((m) => m.type === 'command' && m.action === 'stream.stop');
    engine.send({ type: 'command.result', id: stop.id, ok: true });
    assert.match((await director.next((m) => m.type === 'alert' && m.level === 'error')).message, /grace period is over/);
    setStreaming(false);
    await waitFor(() => !h.app.hub.streamingTournaments().includes(tid));
    await h.app.billing.tick();
    const t = (await h.app.repo.tournamentById(tid))!;
    assert.equal(t.live_session_at, null);
    assert.equal(t.grace_seconds, 0);
    assert.equal(await balance(), 0, 'unpaid grace minutes are not taken later');

    const blocked = await refusedGoLive('live-2');
    assert.match(blocked.error, /No live minutes left/);
    const cloud = await api(h, 'POST', `/api/tournaments/${tid}/cloud-engine/start`, undefined, directorToken);
    assert.equal(cloud.body.error.code, 'billing_blocked');
  });

  it('credits added during the grace period pay for it and the broadcast carries on', async () => {
    await expectOk(api(h, 'POST', `/api/admin/orgs/${owner.orgId}/credits`, { credits: 2.5, note: 'one minute' }, adminToken));
    assert.equal((await goLive('live-3')).ok, true);
    director.drain();
    await advance(61);
    assert.match((await director.next((m) => m.type === 'alert' && m.level === 'error')).message, /Credits finished/);
    await advance(60);
    await expectOk(api(h, 'POST', `/api/admin/orgs/${owner.orgId}/credits`, { credits: 100, note: 'top-up' }, adminToken));
    await advance(30);
    assert.match((await director.next((m) => m.type === 'alert' && m.level === 'info')).message, /Credits added/);
    assert.equal(await balance(), 100 - 2 * 2.5, 'the two grace minutes are charged once paid for');
    assert.equal((await expectOk(api(h, 'GET', `/api/tournaments/${tid}/billing`, undefined, directorToken))).billing.grace.active, false);
  });

  it('a suspended club cannot go live, and a live broadcast is ended', async () => {
    director.drain();
    await expectOk(api(h, 'PATCH', `/api/admin/orgs/${owner.orgId}/billing`, { suspended: true, suspendedReason: 'Unpaid invoice' }, adminToken));
    const stop = await engine.next((m) => m.type === 'command' && m.action === 'stream.stop');
    engine.send({ type: 'command.result', id: stop.id, ok: true });
    assert.match((await director.next((m) => m.type === 'alert' && m.level === 'error')).message, /suspended.*Unpaid invoice/);
    setStreaming(false);
    await waitFor(() => !h.app.hub.streamingTournaments().includes(tid));
    await h.app.billing.tick();
    const r = await refusedGoLive('live-4');
    assert.match(r.error, /suspended by CoGolfers: Unpaid invoice/);
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/billing/cameras`, { count: 1 }, directorToken)).body.error.code, 'club_suspended');
    await expectOk(api(h, 'PATCH', `/api/admin/orgs/${owner.orgId}/billing`, { suspended: false, suspendedReason: null }, adminToken));
  });

  it('custom pricing for one club overrides the platform price', async () => {
    const r = await expectOk(api(h, 'PATCH', `/api/admin/orgs/${owner.orgId}/billing`, { overrides: { freeCameras: 4, minutePrice: 0 } }, adminToken));
    assert.deepEqual([r.pricing.freeCameras, r.pricing.minutePrice, r.pricing.freeMinutes], [4, 0, 10]);
    const s = (await expectOk(api(h, 'GET', `/api/tournaments/${tid}/billing`, undefined, directorToken))).billing;
    assert.deepEqual([s.cameras.limit, s.minutes.remainingSeconds], [5, null]);
    await expectOk(api(h, 'PATCH', `/api/admin/orgs/${owner.orgId}/billing`, { overrides: {} }, adminToken));
  });

  it('Cashfree: checkout → hosted page → paid order adds credits exactly once', async () => {
    const noPhone = await api(h, 'POST', `/api/orgs/${owner.orgId}/billing/checkout`, { packId: 'p1000' }, owner.token);
    assert.equal(noPhone.body.error.code, 'phone_required');
    assert.equal((await api(h, 'POST', `/api/orgs/${owner.orgId}/billing/checkout`, { packId: 'nope', phone: '9876543210' }, owner.token)).status, 404);
    const before = await balance();
    const c = await expectOk(api(h, 'POST', `/api/orgs/${owner.orgId}/billing/checkout`, { packId: 'p1000', phone: '98765 43210' }, owner.token));
    assert.match(c.checkoutUrl, new RegExp(`^https://live\\.example\\.com/pay/${c.payment.id}$`));
    assert.deepEqual([c.payment.amountInr, c.payment.credits, c.payment.status], [1000, 1100, 'created']);
    const order = cf.orders.get(c.payment.orderId)!;
    assert.equal(order.headers['x-api-version'], '2025-01-01');
    assert.equal(order.body.customer_details.customer_phone, '9876543210');
    assert.equal(order.body.order_meta.return_url, `https://live.example.com/pay/${c.payment.id}/done`);
    assert.equal(order.body.order_meta.notify_url, 'https://live.example.com/api/payments/cashfree/webhook');
    assert.equal((await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/billing`, undefined, owner.token))).details.phone, '9876543210', 'phone remembered');

    const pay = await fetch(`${h.baseUrl}/pay/${c.payment.id}`).then((r) => r.text());
    assert.ok(pay.includes(`session_${c.payment.orderId}`) && pay.includes('sdk.cashfree.com/js/v3/cashfree.js') && pay.includes('₹1,000'));
    let done = await fetch(`${h.baseUrl}/pay/${c.payment.id}/done`).then((r) => r.text());
    assert.match(done, /not completed yet/);
    assert.equal(await balance(), before);

    order.status = 'PAID';
    done = await fetch(`${h.baseUrl}/pay/${c.payment.id}/done`).then((r) => r.text());
    assert.match(done, /1,100 credits added/);
    await fetch(`${h.baseUrl}/pay/${c.payment.id}/done`);
    const polled = await expectOk(api(h, 'GET', `/api/payments/${c.payment.id}`, undefined, directorToken));
    assert.equal(polled.payment.status, 'paid');
    assert.equal(await balance(), before + 1100, 'credited once');

    // Webhook: bad signature refused; good one accepted and still idempotent.
    const body = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: c.payment.orderId } } });
    const ts = String(Math.floor(now / 1000));
    const sig = crypto.createHmac('sha256', 'cf-secret').update(ts + body).digest('base64');
    const post = (s: string) => fetch(`${h.baseUrl}/api/payments/cashfree/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-timestamp': ts, 'x-webhook-signature': s }, body });
    assert.equal((await post('bad')).status, 401);
    assert.equal((await post(sig)).status, 200);
    assert.equal(await balance(), before + 1100);
  });

  it('webhook alone credits a payment, and a wrong amount is refused', async () => {
    const before = await balance();
    const c = await expectOk(api(h, 'POST', `/api/orgs/${owner.orgId}/billing/checkout`, { packId: 'p500' }, owner.token));
    const order = cf.orders.get(c.payment.orderId)!;
    order.status = 'PAID';
    order.amount = 1; // tampered
    const body = JSON.stringify({ data: { order: { order_id: c.payment.orderId } } });
    const ts = '1761282000';
    const sig = crypto.createHmac('sha256', 'cf-secret').update(ts + body).digest('base64');
    const send = () => fetch(`${h.baseUrl}/api/payments/cashfree/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-timestamp': ts, 'x-webhook-signature': sig }, body });
    await send();
    assert.equal(await balance(), before, 'amount mismatch: no credits');
    order.amount = 500;
    await send();
    assert.equal(await balance(), before + 500);
    const admin = await expectOk(api(h, 'GET', '/api/admin/payments?status=paid', undefined, adminToken));
    assert.equal(admin.payments.length, 2);
    assert.equal(admin.payments[0].orgName, 'DLF Golf Club');
  });

  it('admin overview, clubs list, club detail and live view', async () => {
    const o = await expectOk(api(h, 'GET', '/api/admin/overview', undefined, adminToken));
    assert.equal(o.clubs, 2);
    assert.equal(o.revenueTotalInr, 1500);
    assert.ok(o.paidMinutesThisMonth >= 13);
    const list = await expectOk(api(h, 'GET', '/api/admin/orgs?q=owner@club', undefined, adminToken));
    assert.deepEqual(list.orgs.map((x: any) => x.name), ['DLF Golf Club']);
    assert.equal(list.orgs[0].paidInr, 1500);
    const d = await expectOk(api(h, 'GET', `/api/admin/orgs/${owner.orgId}`, undefined, adminToken));
    assert.equal(d.tournaments.find((t: any) => t.name === 'Monsoon Open').extraCameras, 1);
    assert.ok(d.transactions.some((t: any) => t.kind === 'admin' && t.note === 'Launch offer' && t.by === 'admin:staff@cogolfers.test'));

    assert.equal((await goLive('live-5')).ok, true);
    const live = await expectOk(api(h, 'GET', '/api/admin/live', undefined, adminToken));
    assert.deepEqual(live.live.map((l: any) => [l.tournamentName, l.orgName, l.cameras, l.cameraLimit]), [['Monsoon Open', 'DLF Golf Club', 3, 3]]);

    await expectOk(api(h, 'POST', '/api/admin/admins', { email: 'owner@club.test' }, adminToken));
    const admins = await expectOk(api(h, 'GET', '/api/admin/admins', undefined, owner.token));
    assert.equal(admins.admins.length, 2);
    await expectOk(api(h, 'DELETE', `/api/admin/admins/${owner.userId}`, undefined, adminToken));
    assert.equal((await api(h, 'GET', '/api/admin/overview', undefined, owner.token)).status, 403, 'revoked at once');
  });
});

async function waitFor(pred: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}
