import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { api, expectOk, signup, startHarness, type Harness } from './helpers.js';
import { financialYear, gstSplit, DEFAULT_INVOICE_SETTINGS } from '../src/invoices.js';

/** Fake Cashfree: orders and refunds; accepts the keys the test says are valid. */
function fakeCashfree() {
  const keys = { id: 'cf-live-id', secret: 'cf-live-secret' };
  const orders = new Map<string, { amount: number; status: string }>();
  const refunds = new Map<string, { amount: number; status: string; order: string }>();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const h = (init?.headers ?? {}) as Record<string, string>;
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (h['x-client-id'] !== keys.id || h['x-client-secret'] !== keys.secret) return json(401, { message: 'authentication Failed' });
    if (url.pathname === '/pg/orders' && init?.method === 'POST') {
      const b = JSON.parse(String(init.body));
      orders.set(b.order_id, { amount: b.order_amount, status: 'ACTIVE' });
      return json(200, { cf_order_id: 1, payment_session_id: 's_' + b.order_id });
    }
    let m = url.pathname.match(/^\/pg\/orders\/([^/]+)\/refunds$/);
    if (m && init?.method === 'POST') {
      const b = JSON.parse(String(init.body));
      refunds.set(b.refund_id, { amount: b.refund_amount, status: 'PENDING', order: m[1] });
      return json(200, { cf_refund_id: 77, refund_status: 'PENDING' });
    }
    m = url.pathname.match(/^\/pg\/orders\/([^/]+)\/refunds\/([^/]+)$/);
    if (m) return json(200, { refund_status: refunds.get(m[2])?.status ?? 'PENDING' });
    m = url.pathname.match(/^\/pg\/orders\/([^/]+)$/);
    if (m) {
      const o = orders.get(m[1]);
      return o ? json(200, { order_status: o.status, order_amount: o.amount, order_currency: 'INR' }) : json(404, { message: 'order not found' });
    }
    return json(404, { message: 'no route' });
  }) as typeof fetch;
  return { fetchImpl, orders, refunds, keys };
}

describe('V7 money: gateway from admin, transactions, refunds, coupons, GST invoices, webhooks', () => {
  let h: Harness;
  const cf = fakeCashfree();
  let admin: { token: string; userId: string; orgId: string };
  let owner: { token: string; orgId: string; userId: string };
  const balance = async () => (await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/billing`, undefined, owner.token))).balance as number;
  const buy = async (packId: string, coupon?: string) => {
    const c = await expectOk(api(h, 'POST', `/api/orgs/${owner.orgId}/billing/checkout`, { packId, phone: '9876543210', coupon }, owner.token), 201);
    cf.orders.get(c.payment.orderId)!.status = 'PAID';
    await fetch(`${h.baseUrl}/pay/${c.payment.id}/done`);
    return c.payment;
  };

  before(async () => {
    // No Cashfree keys in the server config: they are set from the admin panel.
    h = await startHarness({ env: { BILLING_ENABLED: 'true', CASHFREE_API_BASE: 'https://cf.fake/pg' }, cashfreeFetch: cf.fetchImpl });
    admin = await signup(h, 'boss@golive.test', 'Go Live HQ');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [admin.userId]);
    owner = await signup(h, 'rahul@dlf.test', 'DLF Golf Club');
    await expectOk(api(h, 'PUT', '/api/admin/settings', { packs: [{ id: 'p500', label: 'Starter', priceInr: 500, credits: 500 }, { id: 'p1000', label: 'Club', priceInr: 1000, credits: 1100 }] }, admin.token));
  });
  after(async () => h.close());

  it('GST maths and financial years', () => {
    const s = { ...DEFAULT_INVOICE_SETTINGS, stateCode: '06', gstRate: 18, pricesIncludeGst: true };
    assert.deepEqual(gstSplit(1180, s, null), { taxable: 1000, cgst: 90, sgst: 90, igst: 0, total: 1180 });
    assert.deepEqual(gstSplit(1180, s, '07'), { taxable: 1000, cgst: 0, sgst: 0, igst: 180, total: 1180 });
    assert.deepEqual(gstSplit(1000, { ...s, pricesIncludeGst: false }, '06'), { taxable: 1000, cgst: 90, sgst: 90, igst: 0, total: 1180 });
    assert.equal(financialYear(new Date('2027-03-31T12:00:00Z')), '2026-27');
    assert.equal(financialYear(new Date('2026-03-31T19:00:00Z')), '2026-27', 'already 1 April in India');
  });

  it('gateway keys: tested before saving, stored encrypted, shown masked, used at once', async () => {
    let g = await expectOk(api(h, 'GET', '/api/admin/gateway', undefined, admin.token));
    assert.deepEqual([g.source, g.enabled, g.webhookUrl], ['none', false, 'https://live.example.com/api/payments/cashfree/webhook']);
    assert.equal((await api(h, 'POST', `/api/orgs/${owner.orgId}/billing/checkout`, { packId: 'p500', phone: '9876543210' }, owner.token)).body.error.code, 'payments_off');
    const bad = await api(h, 'PUT', '/api/admin/gateway', { clientId: 'cf-live-id', clientSecret: 'wrong', env: 'production' }, admin.token);
    assert.equal(bad.body.error.code, 'gateway_test_failed');
    assert.equal((await expectOk(api(h, 'POST', '/api/admin/gateway/test', { clientId: 'cf-live-id', clientSecret: 'cf-live-secret', env: 'production' }, admin.token))).ok, true);
    g = await expectOk(api(h, 'PUT', '/api/admin/gateway', { clientId: 'cf-live-id', clientSecret: 'cf-live-secret', env: 'production' }, admin.token));
    assert.deepEqual([g.source, g.enabled, g.env, g.secret], ['admin', true, 'production', 'cf-l…cret']);
    const stored = (await h.db.query("SELECT value_enc FROM platform_secrets WHERE key = 'cashfree'")).rows[0].value_enc;
    assert.ok(!stored.includes('cf-live-secret'), 'encrypted at rest');
    // Saving again without the secret keeps it.
    await expectOk(api(h, 'PUT', '/api/admin/gateway', { clientId: 'cf-live-id', env: 'production' }, admin.token));
    const audit = await expectOk(api(h, 'GET', '/api/admin/audit?q=gateway', undefined, admin.token));
    assert.ok(audit.entries.every((e: any) => !JSON.stringify(e.detail).includes('cf-live-secret')), 'secret never in the audit log');
    // A new app instance loads the saved keys.
    await h.app.payments.reload();
    assert.equal(h.app.payments.enabled, true);
  });

  it('payments appear with totals; the pay page uses the saved mode', async () => {
    const before = await balance();
    const p = await buy('p1000');
    assert.equal(await balance(), before + 1100);
    const page = await fetch(`${h.baseUrl}/pay/${p.id}`).then((r) => r.text());
    assert.match(page, /Already paid/);
    const t = await expectOk(api(h, 'GET', '/api/admin/transactions?status=paid', undefined, admin.token));
    assert.deepEqual([t.totals.paid, t.totals.paidInr, t.totals.credits], [1, 1000, 1100]);
    const csv = await fetch(`${h.baseUrl}/api/admin/transactions.csv`, { headers: { authorization: `Bearer ${admin.token}` } }).then((r) => r.text());
    assert.match(csv, /"DLF Golf Club"/);
  });

  it('coupons: % off lowers the price, bonus credits add credits, limits hold', async () => {
    await expectOk(api(h, 'POST', '/api/admin/coupons', { code: 'launch20', kind: 'percent_off', value: 20, description: 'Launch offer' }, admin.token), 201);
    await expectOk(api(h, 'POST', '/api/admin/coupons', { code: 'BONUS200', kind: 'bonus_credits', value: 200, maxUses: 1, minInr: 1000 }, admin.token), 201);
    assert.equal((await api(h, 'POST', '/api/admin/coupons', { code: 'LAUNCH20', kind: 'percent_off', value: 10 }, admin.token)).body.error.code, 'coupon_exists');
    const quote = await expectOk(api(h, 'POST', `/api/orgs/${owner.orgId}/billing/coupon`, { packId: 'p1000', coupon: 'launch20' }, owner.token));
    assert.deepEqual([quote.amountInr, quote.discountInr, quote.credits], [800, 200, 1100]);
    assert.equal((await api(h, 'POST', `/api/orgs/${owner.orgId}/billing/coupon`, { packId: 'p500', coupon: 'BONUS200' }, owner.token)).body.error.code, 'coupon_invalid');
    assert.equal((await api(h, 'POST', `/api/orgs/${owner.orgId}/billing/coupon`, { packId: 'p1000', coupon: 'NOPE' }, owner.token)).body.error.code, 'coupon_invalid');

    const before = await balance();
    const p = await buy('p1000', 'LAUNCH20');
    assert.equal(cf.orders.get(p.orderId)!.amount, 800, 'Cashfree charged the discounted price');
    assert.equal(await balance(), before + 1100);
    assert.match((await api(h, 'POST', `/api/orgs/${owner.orgId}/billing/coupon`, { packId: 'p1000', coupon: 'LAUNCH20' }, owner.token)).body.error.message, /already used/);
    await buy('p1000', 'BONUS200');
    assert.equal(await balance(), before + 1100 + 1100 + 200);
    const other = await signup(h, 'priya@other.test', 'Other Club');
    assert.match((await api(h, 'POST', `/api/orgs/${other.orgId}/billing/coupon`, { packId: 'p1000', coupon: 'BONUS200' }, other.token)).body.error.message, /used up/);
    const list = await expectOk(api(h, 'GET', '/api/admin/coupons', undefined, admin.token));
    assert.deepEqual(list.coupons.map((c: any) => `${c.code}:${c.uses}`).sort(), ['BONUS200:1', 'LAUNCH20:1']);
    await expectOk(api(h, 'PATCH', '/api/admin/coupons/launch20', { active: false }, admin.token));
    assert.match((await api(h, 'POST', `/api/orgs/${other.orgId}/billing/coupon`, { packId: 'p1000', coupon: 'LAUNCH20' }, other.token)).body.error.message, /not valid/);
  });

  it('GST invoices: settings, backfill, numbering, club access, printable page, register CSV', async () => {
    assert.equal((await api(h, 'POST', '/api/admin/invoices/backfill', {}, admin.token)).body.error.code, 'invoices_off');
    const bad = await api(h, 'PUT', '/api/admin/invoice-settings', { ...DEFAULT_INVOICE_SETTINGS, enabled: true, legalName: 'Go Live Media Pvt Ltd', address: 'Gurugram', gstin: '07ABCDE1234F1Z5', stateCode: '06' }, admin.token);
    assert.equal(bad.body.error.code, 'state_mismatch');
    await expectOk(api(h, 'PUT', '/api/admin/invoice-settings', { ...DEFAULT_INVOICE_SETTINGS, enabled: true, legalName: 'Go Live Media Pvt Ltd', address: 'Sector 44\nGurugram, Haryana', gstin: '06ABCDE1234F1Z5', stateCode: '06', email: 'billing@golive.test' }, admin.token));
    assert.equal((await expectOk(api(h, 'POST', '/api/admin/invoices/backfill', {}, admin.token))).created, 3);
    assert.equal((await expectOk(api(h, 'POST', '/api/admin/invoices/backfill', {}, admin.token))).created, 0, 'once each');
    // New payments get an invoice straight away; a club with a Delhi GSTIN pays IGST.
    await expectOk(api(h, 'PUT', `/api/orgs/${owner.orgId}/billing/details`, { name: 'DLF Golf Club Ltd', gstin: '07AAACD1234E1Z2' }, owner.token));
    await buy('p500');
    const inv = await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/invoices`, undefined, owner.token));
    assert.equal(inv.invoices.length, 4);
    const fy = financialYear(new Date());
    assert.deepEqual(inv.invoices.map((i: any) => i.number).sort(), [1, 2, 3, 4].map((n) => `GL/${fy}/00000${n}`));
    const last = inv.invoices.find((i: any) => i.number.endsWith('4'));
    assert.deepEqual([last.taxableInr, last.igstInr, last.cgstInr, last.totalInr, last.buyer.gstin], [423.73, 76.27, 0, 500, '07AAACD1234E1Z2']);
    const html = await fetch(`${h.baseUrl}/invoices/${last.id}?token=${encodeURIComponent(owner.token)}`).then((r) => r.text());
    assert.match(html, /Tax invoice/);
    assert.match(html, /GSTIN 06ABCDE1234F1Z5/);
    assert.match(html, /IGST 18%/);
    const stranger = await signup(h, 'nosy@x.test', 'Nosy');
    assert.equal((await fetch(`${h.baseUrl}/invoices/${last.id}?token=${encodeURIComponent(stranger.token)}`)).status, 404);
    const reg = await fetch(`${h.baseUrl}/api/admin/invoices.csv`, { headers: { authorization: `Bearer ${admin.token}` } }).then((r) => r.text());
    assert.equal(reg.trim().split('\r\n').length, 5);
  });

  it('refunds: credits taken back, Cashfree asked, credit note on success, credits back on failure', async () => {
    const paid = (await expectOk(api(h, 'GET', '/api/admin/transactions?status=paid', undefined, admin.token))).payments;
    const p = paid.find((x: any) => x.amountInr === 500);
    assert.equal((await api(h, 'POST', `/api/admin/payments/${p.id}/refund`, { amountInr: 600, credits: 0, note: 'Too much' }, admin.token)).body.error.code, 'refund_amount');
    assert.equal((await api(h, 'POST', `/api/admin/payments/${p.id}/refund`, { amountInr: 100, credits: 999999, note: 'x refund' }, admin.token)).body.error.code, 'balance_too_low');
    const before = await balance();
    const r1 = (await expectOk(api(h, 'POST', `/api/admin/payments/${p.id}/refund`, { amountInr: 200, credits: 200, note: 'Event cancelled' }, admin.token))).refund;
    assert.equal(r1.status, 'pending');
    assert.equal(await balance(), before - 200, 'credits taken back at once');
    cf.refunds.get(r1.refundId)!.status = 'SUCCESS';
    assert.equal((await expectOk(api(h, 'POST', `/api/admin/refunds/${r1.id}/refresh`, {}, admin.token))).refund.status, 'success');
    const notes = (await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/invoices`, undefined, owner.token))).invoices.filter((i: any) => i.kind === 'credit_note');
    assert.deepEqual([notes.length, notes[0].number, notes[0].totalInr], [1, `GL/CN/${financialYear(new Date())}/000001`, 200]);

    // Second refund fails at Cashfree (reported by webhook): the credits come back.
    const r2 = (await expectOk(api(h, 'POST', `/api/admin/payments/${p.id}/refund`, { amountInr: 300, credits: 300, note: 'Rest of it' }, admin.token))).refund;
    assert.equal(await balance(), before - 500);
    cf.refunds.get(r2.refundId)!.status = 'FAILED';
    const body = JSON.stringify({ type: 'REFUND_STATUS_WEBHOOK', data: { refund: { refund_id: r2.refundId, order_id: p.orderId } } });
    const ts = '1761282000';
    const sig = crypto.createHmac('sha256', cf.keys.secret).update(ts + body).digest('base64');
    await fetch(`${h.baseUrl}/api/payments/cashfree/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-timestamp': ts, 'x-webhook-signature': sig }, body });
    await fetch(`${h.baseUrl}/api/payments/cashfree/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-timestamp': ts, 'x-webhook-signature': 'forged' }, body });
    assert.equal(await balance(), before - 200, 'failed refund: 300 credits returned');
    const d = await expectOk(api(h, 'GET', `/api/admin/payments/${p.id}`, undefined, admin.token));
    assert.deepEqual(d.refunds.map((r: any) => r.status), ['failed', 'success']);
    assert.equal(d.payment.refundedInr, 200);
    const ev = await expectOk(api(h, 'GET', `/api/admin/payment-events?order=${p.orderId}`, undefined, admin.token));
    assert.deepEqual(ev.events.map((e: any) => `${e.signatureOk}:${e.result}`), ['false:rejected: bad signature', 'true:refund failed']);
  });

  it('ledger across all clubs, with totals and CSV', async () => {
    const l = await expectOk(api(h, 'GET', '/api/admin/ledger', undefined, admin.token));
    assert.ok(l.entries.length >= 6);
    assert.ok(l.totalsByKind.find((k: any) => k.kind === 'refund'));
    assert.equal(l.creditsHeldByClubs, await balance());
    const only = await expectOk(api(h, 'GET', '/api/admin/ledger?kind=refund', undefined, admin.token));
    assert.ok(only.entries.every((e: any) => e.kind === 'refund'));
    const csv = await fetch(`${h.baseUrl}/api/admin/ledger.csv?org=${owner.orgId}`, { headers: { authorization: `Bearer ${admin.token}` } });
    assert.match(await csv.text(), /"DLF Golf Club"/);
  });
});
