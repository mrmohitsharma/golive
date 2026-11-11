import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';
import { giftSplit, DEFAULT_GIFT_SETTINGS, mergeGiftSettings } from '../src/gifts.js';

function fakeCashfree() {
  const orders = new Map<string, { amount: number; status: string; body: any }>();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (status: number, d: unknown) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/pg/orders' && init?.method === 'POST') {
      const b = JSON.parse(String(init.body));
      orders.set(b.order_id, { amount: b.order_amount, status: 'ACTIVE', body: b });
      return json(200, { payment_session_id: 'sess_' + b.order_id, cf_order_id: 7 });
    }
    const m = url.pathname.match(/^\/pg\/orders\/([^/]+)$/);
    if (m) { const o = orders.get(m[1]); return o ? json(200, { order_status: o.status, order_amount: o.amount, order_currency: 'INR' }) : json(404, {}); }
    return json(404, {});
  }) as typeof fetch;
  return { fetchImpl, orders };
}

describe('V9 gift split', () => {
  it('takes GST out of the gift first, then the share, fee and TDS', () => {
    const s = giftSplit(101, DEFAULT_GIFT_SETTINGS);
    assert.deepEqual([s.gst, s.share, s.fee, s.tds, s.net], [15.41, 12.84, 2.02, 0.1, 70.63]);
    const o = giftSplit(101, { ...DEFAULT_GIFT_SETTINGS, gstMode: 'share_only', feePaidBy: 'platform', tdsPct: 0 });
    assert.deepEqual([o.share, o.gst, o.net], [15.15, 2.31, 85.85]);
    assert.equal(mergeGiftSettings({ sharePct: 500, label: '' }).sharePct, 90);
    assert.equal(mergeGiftSettings({}).label, 'Gift credits');
  });
});

describe('V9 gift credits: payout set-up, agreement by email, a UPI gift, chat, payout', () => {
  let h: Harness;
  const cf = fakeCashfree();
  let admin: { token: string; userId: string; orgId: string };
  let owner: { token: string; orgId: string; userId: string };
  let tid: string;

  before(async () => {
    h = await startHarness({ env: { BILLING_ENABLED: 'true', CASHFREE_CLIENT_ID: 'id', CASHFREE_CLIENT_SECRET: 'secret', CASHFREE_API_BASE: 'https://cf.fake/pg' }, cashfreeFetch: cf.fetchImpl });
    admin = await signup(h, 'boss@golive.test', 'Go Live HQ');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [admin.userId]);
    owner = await signup(h, 'rahul@gcl.test', 'Gurgaon Cricket League');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'GCL Final' });
  });
  after(async () => h.close());

  it('cannot switch gifts on until payout details are verified and the agreement is signed', async () => {
    const r = await api(h, 'PATCH', `/api/tournaments/${tid}/gifts`, { enabled: true }, owner.token);
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /payout details/);
    const bad = await api(h, 'PUT', `/api/orgs/${owner.orgId}/gift-account`, { legalName: 'GCL Sports', pan: 'ABCDE1234', accountHolder: 'GCL Sports', account: '123456789012', ifsc: 'HDFC0001234', email: 'pay@gcl.test' }, owner.token);
    assert.equal(bad.status, 400);
    const v = await expectOk(api(h, 'PUT', `/api/orgs/${owner.orgId}/gift-account`, { legalName: 'GCL Sports', pan: 'abcde1234f', accountHolder: 'GCL Sports', account: '1234 5678 9012', ifsc: 'hdfc0001234', email: 'pay@gcl.test' }, owner.token));
    assert.equal(v.payee.account, '••••9012');
    assert.equal(v.payee.status, 'pending');
    const raw = (await h.db.query('SELECT account_enc, pan_enc FROM payee_accounts')).rows[0];
    assert.ok(!String(raw.account_enc).includes('123456789012'), 'account number is sealed');
    // Admin verifies; the club sends itself the agreement and signs it from the email link.
    await expectOk(api(h, 'POST', `/api/admin/gifts/clubs/${owner.orgId}/verify`, { ok: true }, admin.token));
    await expectOk(api(h, 'POST', `/api/orgs/${owner.orgId}/gift-account/agreement`, {}, owner.token));
    const mail = h.app.mailer.outbox.filter((e: any) => e.kind === 'gift_agreement').at(-1)!;
    assert.equal(mail.to, 'pay@gcl.test');
    const link = new URL(mail.button!.url);
    const pageHtml = await fetch(h.baseUrl + link.pathname).then((r) => r.text());
    assert.match(pageHtml, /Payout Agreement/);
    assert.match(pageHtml, /ending 9012/);
    assert.equal((await fetch(h.baseUrl + link.pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Rahul Yadav', agree: false }) })).status, 400);
    const signed = await fetch(h.baseUrl + link.pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Rahul Yadav', agree: true }) });
    assert.equal(signed.status, 200);
    assert.ok(h.app.mailer.outbox.some((e: any) => e.kind === 'gift_agreement_signed' && e.to === 'pay@gcl.test'));
    const acct = await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/gift-account`, undefined, owner.token));
    assert.equal(acct.agreement.state, 'signed');
    assert.equal(acct.notReady, null);
  });

  it('a viewer gifts by UPI with only a name; it shows in chat after payment; limits hold', async () => {
    // Gifts only open while live by default: open them for the test, no hold before payout.
    await expectOk(api(h, 'PUT', '/api/admin/gifts/settings', { onlyWhileLive: false, holdDays: 0, minPayoutInr: 50, label: 'Gift credits', perDeviceHourlyCount: 3 }, admin.token));
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/gifts`, { enabled: true, goal: { amount: 50000, text: 'Team kit' }, stickers: [{ name: 'Six', emoji: '🔥', amount: 51 }, { name: 'Trophy', emoji: '🏆', amount: 101 }] }, owner.token));
    const pub = await expectOk(api(h, 'GET', `/api/public/tournaments/${tid}/gifts`));
    assert.equal(pub.open, true);
    assert.equal(pub.label, 'Gift credits');
    assert.deepEqual(pub.stickers.map((s: any) => s.amount), [51, 101]);
    assert.equal((await api(h, 'POST', `/api/public/tournaments/${tid}/gifts`, { name: 'Amit', amount: 5, device: 'device-aaaa' })).status, 400);
    const c = await expectOk(api(h, 'POST', `/api/public/tournaments/${tid}/gifts`, { name: 'Amit', message: 'Go GCL!', stickerId: 'trophy', device: 'device-aaaa' }), 201);
    const order = [...cf.orders.values()].at(-1)!;
    assert.equal(order.amount, 101);
    assert.equal(order.body.order_meta.payment_methods, 'upi');
    assert.equal(order.body.customer_details.customer_phone, '9664403568');
    assert.match(await fetch(c.checkoutUrl.replace(/^https?:\/\/[^/]+/, h.baseUrl)).then((r) => r.text()), /Pay ₹101 by UPI/);
    // Not shown before payment.
    let chat = await expectOk(api(h, 'GET', `/api/public/tournaments/${tid}/chat?after=0`));
    assert.equal((chat.messages ?? []).length, 0);
    order.status = 'PAID';
    const done = await fetch(`${h.baseUrl}/gift/${c.giftId}/done`, { redirect: 'manual' });
    assert.equal(done.status, 302);
    chat = await expectOk(api(h, 'GET', `/api/public/tournaments/${tid}/chat?after=0`));
    assert.equal(chat.messages[0].author, 'Amit');
    assert.deepEqual(chat.messages[0].gift, { amount: 101, emoji: '🏆', name: 'Trophy' });
    const after = await expectOk(api(h, 'GET', `/api/public/tournaments/${tid}/gifts`));
    assert.equal(after.goal.raised, 101);
    assert.equal(after.top[0].name, 'Amit');
    const staff = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/gifts`, undefined, owner.token));
    assert.equal(staff.gifts[0].net, 70.63);
    // Per-device hourly count limit (3, including the first).
    await expectOk(api(h, 'POST', `/api/public/tournaments/${tid}/gifts`, { name: 'Amit', stickerId: 'six', device: 'device-aaaa' }), 201);
    await expectOk(api(h, 'POST', `/api/public/tournaments/${tid}/gifts`, { name: 'Amit', stickerId: 'six', device: 'device-aaaa' }), 201);
    assert.equal((await api(h, 'POST', `/api/public/tournaments/${tid}/gifts`, { name: 'Amit', stickerId: 'six', device: 'device-aaaa' })).status, 429);
  });

  it('weekly payout: groups payable gifts, bank file, marked paid with UTR, statement', async () => {
    const run = await expectOk(api(h, 'POST', '/api/admin/gift-payouts/run', {}, admin.token));
    assert.equal(run.created.length, 1);
    assert.equal(run.created[0].net, 70.63);
    const bank = await fetch(`${h.baseUrl}/api/admin/gift-payouts/bank.csv`, { headers: { authorization: `Bearer ${admin.token}` } }).then((r) => r.text());
    assert.match(bank, /123456789012/);
    assert.match(bank, /HDFC0001234/);
    assert.equal((await api(h, 'GET', `/api/admin/gift-payouts/bank.csv`, undefined, owner.token)).status, 403);
    await expectOk(api(h, 'POST', `/api/admin/gift-payouts/${run.created[0].id}/paid`, { utr: 'UTR123456' }, admin.token));
    assert.ok(h.app.mailer.outbox.some((e: any) => e.kind === 'gift_payout' && e.to === 'pay@gcl.test'));
    const acct = await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/gift-account`, undefined, owner.token));
    assert.equal(acct.summary.paidOut, 70.63);
    const st = await fetch(`${h.baseUrl}/api/orgs/${owner.orgId}/gift-payouts/${run.created[0].id}/statement.csv`, { headers: { authorization: `Bearer ${owner.token}` } }).then((r) => r.text());
    assert.match(st, /UTR123456/);
    // Nothing left to pay out.
    assert.equal((await expectOk(api(h, 'POST', '/api/admin/gift-payouts/run', {}, admin.token))).created.length, 0);
  });

  it('changing bank details revokes the signed agreement and needs verifying again', async () => {
    await expectOk(api(h, 'PUT', `/api/orgs/${owner.orgId}/gift-account`, { legalName: 'GCL Sports', pan: 'ABCDE1234F', accountHolder: 'GCL Sports', account: '999988887777', ifsc: 'ICIC0001234', email: 'pay@gcl.test' }, owner.token));
    const acct = await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/gift-account`, undefined, owner.token));
    assert.equal(acct.payee.status, 'pending');
    assert.equal(acct.agreement, null);
    assert.match(acct.notReady, /waiting for Go Live/);
  });
});
