import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';

function fakeCashfree() {
  const orders = new Map<string, { amount: number; status: string }>();
  const refunds = new Map<string, string>();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (status: number, d: unknown) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/pg/orders' && init?.method === 'POST') {
      const b = JSON.parse(String(init.body));
      orders.set(b.order_id, { amount: b.order_amount, status: 'ACTIVE' });
      return json(200, { payment_session_id: 's', cf_order_id: 1 });
    }
    let m = url.pathname.match(/\/refunds$/);
    if (m && init?.method === 'POST') { const b = JSON.parse(String(init.body)); refunds.set(b.refund_id, 'SUCCESS'); return json(200, { refund_status: 'SUCCESS' }); }
    m = url.pathname.match(/^\/pg\/orders\/([^/]+)$/);
    if (m) { const o = orders.get(m[1]); return o ? json(200, { order_status: o.status, order_amount: o.amount, order_currency: 'INR' }) : json(404, { message: 'order not found' }); }
    return json(404, { message: 'no route' });
  }) as typeof fetch;
  return { fetchImpl, orders };
}

describe('V7 web billing: slots, back to the web after paying, billing emails', () => {
  let h: Harness;
  const cf = fakeCashfree();
  let admin: { token: string; userId: string; orgId: string };
  let owner: { token: string; orgId: string; userId: string };
  let tid: string;
  const mails = (kind: string, to = 'rahul@dlf.test') => h.app.mailer.outbox.filter((e) => e.kind === kind && e.to === to);

  before(async () => {
    h = await startHarness({ env: { BILLING_ENABLED: 'true', CASHFREE_CLIENT_ID: 'id', CASHFREE_CLIENT_SECRET: 'secret', CASHFREE_API_BASE: 'https://cf.fake/pg' }, cashfreeFetch: cf.fetchImpl });
    admin = await signup(h, 'boss@golive.test', 'Go Live HQ');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [admin.userId]);
    owner = await signup(h, 'rahul@dlf.test', 'DLF Golf Club');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'Monsoon Open' });
    await expectOk(api(h, 'PUT', '/api/admin/settings', { packs: [{ id: 'p500', label: 'Starter', priceInr: 500, credits: 500 }] }, admin.token));
  });
  after(async () => h.close());

  it('after paying on Cashfree, the payer goes back to the web wallet; a receipt is emailed once', async () => {
    assert.equal((await api(h, 'POST', `/api/orgs/${owner.orgId}/billing/checkout`, { packId: 'p500', phone: '9876543210', returnTo: 'https://evil.test' }, owner.token)).status, 400);
    const c = await expectOk(api(h, 'POST', `/api/orgs/${owner.orgId}/billing/checkout`, { packId: 'p500', phone: '9876543210', returnTo: '/web/wallet' }, owner.token), 201);
    cf.orders.get(c.payment.orderId)!.status = 'PAID';
    const done = await fetch(`${h.baseUrl}/pay/${c.payment.id}/done`).then((r) => r.text());
    assert.match(done, new RegExp(`/web/wallet\\?paid=${c.payment.id}`));
    await fetch(`${h.baseUrl}/pay/${c.payment.id}/done`);
    await new Promise((r) => setTimeout(r, 100));
    const r = mails('receipt');
    assert.equal(r.length, 1, 'once');
    assert.match(r[0].text, /₹500 for DLF Golf Club/);
  });

  it('low credits: one email when the balance drops under 100, again only after a top-up', async () => {
    // 500 credits now; extra cameras cost 100 each by default.
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/billing/cameras`, { count: 4 }, owner.token));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(mails('low_balance').length, 0, '100 left: not low yet');
    await expectOk(api(h, 'POST', `/api/admin/orgs/${owner.orgId}/credits`, { credits: -50, note: 'test' }, admin.token));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(mails('low_balance').length, 1);
    assert.match(mails('low_balance')[0].text, /has 50 credits left/);
    await expectOk(api(h, 'POST', `/api/admin/orgs/${owner.orgId}/credits`, { credits: -10, note: 'test' }, admin.token));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(mails('low_balance').length, 1, 'not again the same day');
    await expectOk(api(h, 'POST', `/api/admin/orgs/${owner.orgId}/credits`, { credits: 500, note: 'top-up' }, admin.token));
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/billing/cameras`, { count: 5 }, owner.token));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(mails('low_balance').length, 2, 'after a top-up it can warn again');
  });

  it('refund done and suspension are emailed to the owner', async () => {
    await expectOk(api(h, 'POST', `/api/admin/orgs/${owner.orgId}/credits`, { credits: 500, note: 'for refund' }, admin.token));
    const p = (await expectOk(api(h, 'GET', '/api/admin/transactions?status=paid', undefined, admin.token))).payments[0];
    await expectOk(api(h, 'POST', `/api/admin/payments/${p.id}/refund`, { amountInr: 100, credits: 100, note: 'Rain' }, admin.token));
    await new Promise((r) => setTimeout(r, 100));
    assert.match(mails('refund')[0].text, /refunded ₹100/);
    await expectOk(api(h, 'PATCH', `/api/admin/orgs/${owner.orgId}/billing`, { suspended: true, suspendedReason: 'Unpaid dues' }, admin.token));
    await new Promise((r) => setTimeout(r, 100));
    assert.match(mails('suspended')[0].text, /Unpaid dues/);
  });
});
