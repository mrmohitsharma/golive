import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, expectOk, signup, startHarness, type Harness } from './helpers.js';
import { DEFAULT_INVOICE_SETTINGS } from '../src/invoices.js';

function fakeCashfree() {
  const orders = new Map<string, { amount: number; status: string }>();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (status: number, d: unknown) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/pg/orders' && init?.method === 'POST') {
      const b = JSON.parse(String(init.body));
      orders.set(b.order_id, { amount: b.order_amount, status: 'ACTIVE' });
      return json(200, { payment_session_id: 's', cf_order_id: 1 });
    }
    const m = url.pathname.match(/^\/pg\/orders\/([^/]+)$/);
    if (m) { const o = orders.get(m[1]); return o ? json(200, { order_status: o.status, order_amount: o.amount, order_currency: 'INR' }) : json(404, {}); }
    return json(404, {});
  }) as typeof fetch;
  return { fetchImpl, orders };
}

describe('Prices plus 18% GST: checkout adds the GST, the invoice splits what was paid', () => {
  let h: Harness;
  const cf = fakeCashfree();
  let admin: { token: string; userId: string; orgId: string };
  let owner: { token: string; orgId: string; userId: string };

  before(async () => {
    h = await startHarness({ env: { BILLING_ENABLED: 'true', CASHFREE_CLIENT_ID: 'id', CASHFREE_CLIENT_SECRET: 'secret', CASHFREE_API_BASE: 'https://cf.fake/pg' }, cashfreeFetch: cf.fetchImpl });
    admin = await signup(h, 'boss@golive.test', 'Go Live HQ');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [admin.userId]);
    owner = await signup(h, 'rahul@dlf.test', 'DLF Golf Club');
    await expectOk(api(h, 'PUT', '/api/admin/settings', { packs: [{ id: 'p500', label: 'Starter', priceInr: 500, credits: 500 }] }, admin.token));
    await expectOk(api(h, 'PUT', '/api/admin/invoice-settings', { ...DEFAULT_INVOICE_SETTINGS, enabled: true, legalName: 'S.R Fairway Ventures', address: 'A402, Sector 6, Gurgaon, Haryana 122103', gstin: '06ABCDE1234F1Z5', stateCode: '06' }, admin.token));
  });
  after(async () => h.close());

  it('charges ₹590 for a ₹500 pack, gives 500 credits, and invoices ₹500 + ₹90 GST', async () => {
    const w = await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/billing`, undefined, owner.token));
    assert.deepEqual(w.gst, { rate: 18, included: false });
    const c = await expectOk(api(h, 'POST', `/api/orgs/${owner.orgId}/billing/checkout`, { packId: 'p500', phone: '9876543210' }, owner.token), 201);
    assert.equal(cf.orders.get(c.payment.orderId)!.amount, 590);
    const page = await fetch(`${h.baseUrl}/pay/${c.payment.id}`).then((r) => r.text());
    assert.match(page, /₹590/);
    assert.match(page, /18% GST/);
    cf.orders.get(c.payment.orderId)!.status = 'PAID';
    await fetch(`${h.baseUrl}/pay/${c.payment.id}/done`);
    assert.equal((await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/billing`, undefined, owner.token))).balance, 500);
    const inv = (await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/invoices`, undefined, owner.token))).invoices[0];
    assert.equal(Number(inv.totalInr), 590);
    assert.equal(Number(inv.taxableInr), 500);
    assert.equal(Number(inv.cgstInr) + Number(inv.sgstInr) + Number(inv.igstInr), 90);
  });

  it('switching to GST-included charges the pack price', async () => {
    await expectOk(api(h, 'PUT', '/api/admin/invoice-settings', { ...DEFAULT_INVOICE_SETTINGS, pricesIncludeGst: true, enabled: true, legalName: 'S.R Fairway Ventures', address: 'Gurgaon', gstin: '06ABCDE1234F1Z5', stateCode: '06' }, admin.token));
    const c = await expectOk(api(h, 'POST', `/api/orgs/${owner.orgId}/billing/checkout`, { packId: 'p500', phone: '9876543210' }, owner.token), 201);
    assert.equal(cf.orders.get(c.payment.orderId)!.amount, 500);
  });
});
