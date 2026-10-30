import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';
import { userOf } from '../auth.js';
import { fromCc, txDto, type WalletTxRow } from '../billing.js';
import { PAYMENT_SELECT, couponDto, paymentDto, refundDto, type CashfreeCreds, type CouponRow, type PaymentRow } from '../payments.js';
import { invoiceDto, invoiceHtml } from '../invoices.js';
import { maskSecret } from '../secrets.js';
import { adminGuard } from './web.js';

const uuid = z.string().uuid();
const idOf = (req: { params: unknown }) => uuid.parse((req.params as { id: string }).id);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const cell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};
function sendCsv(reply: FastifyReply, name: string, head: string[], rows: unknown[][]) {
  reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}.csv"`);
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

/**
 * V7 super admin: money. Payment gateway keys (stored encrypted, test button), every payment
 * with filters and CSV, refunds through Cashfree (credits taken back), the wallet ledger of all
 * clubs, coupons, GST invoices and credit notes, and the log of gateway webhooks.
 */
export function registerAdminMoneyRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, payments, secrets, invoices, billing } = ctx;
  const admin = adminGuard(ctx);
  const q = repo.db;
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, '');

  // ---------------------------------------------------------------- gateway
  const gatewayDto = async () => {
    const c = payments.creds;
    return {
      provider: 'cashfree',
      source: payments.source,
      enabled: payments.enabled,
      env: c?.env ?? config.CASHFREE_ENV,
      clientId: c?.clientId ?? null,
      secret: maskSecret(c?.clientSecret),
      billingEnabled: billing.enabled,
      savedAt: (await secrets.updatedAt('cashfree'))?.toISOString() ?? null,
      webhookUrl: `${base}/api/payments/cashfree/webhook`,
      returnUrlExample: `${base}/pay/<payment>/done`,
      httpsOk: base.startsWith('https://'),
    };
  };
  app.get('/api/admin/gateway', { preHandler: admin }, gatewayDto);

  const credsBody = z.object({
    clientId: z.string().trim().min(4).max(200),
    clientSecret: z.string().trim().max(400).optional(), // blank = keep the saved one
    env: z.enum(['sandbox', 'production']),
    enabled: z.boolean().default(true),
  });
  const withSecret = (b: z.infer<typeof credsBody>): CashfreeCreds => {
    const secret = b.clientSecret || (payments.creds?.clientId === b.clientId ? payments.creds.clientSecret : '');
    if (!secret) throw new HttpError(400, 'secret_required', 'Enter the client secret.');
    return { clientId: b.clientId, clientSecret: secret, env: b.env, enabled: b.enabled };
  };

  app.post('/api/admin/gateway/test', { preHandler: admin }, async (req) => {
    const b = req.body && Object.keys(req.body as object).length ? withSecret(credsBody.parse(req.body)) : payments.creds;
    if (!b) throw new HttpError(400, 'not_set', 'No payment gateway keys are set yet.');
    return payments.testConnection(b);
  });

  app.put('/api/admin/gateway', { preHandler: admin }, async (req) => {
    const creds = withSecret(credsBody.parse(req.body));
    const test = await payments.testConnection(creds);
    if (!test.ok && creds.enabled) throw new HttpError(400, 'gateway_test_failed', `${test.message} Keys not saved.`);
    await secrets.set('cashfree', creds, userOf(req).id);
    await payments.reload();
    return { ...(await gatewayDto()), test };
  });

  /** Back to the keys in the server config (if any). */
  app.delete('/api/admin/gateway', { preHandler: admin }, async () => {
    await secrets.remove('cashfree');
    await payments.reload();
    return gatewayDto();
  });

  // ---------------------------------------------------------------- transactions
  const txFilter = z.object({
    status: z.enum(['created', 'paid', 'failed', 'expired']).optional(),
    org: uuid.optional(),
    q: z.string().trim().max(100).optional(),
    from: dateStr.optional(),
    to: dateStr.optional(),
    refunded: z.enum(['yes']).optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(500),
  });
  const findPayments = async (f: z.infer<typeof txFilter>) => {
    const w: string[] = [];
    const v: unknown[] = [];
    if (f.status) (v.push(f.status), w.push(`p.status = $${v.length}`));
    if (f.org) (v.push(f.org), w.push(`p.org_id = $${v.length}`));
    if (f.q) (v.push(`%${f.q}%`), w.push(`(p.order_id ILIKE $${v.length} OR o.name ILIKE $${v.length} OR p.coupon_code ILIKE $${v.length})`));
    if (f.from) (v.push(f.from), w.push(`p.created_at >= $${v.length}::date`));
    if (f.to) (v.push(f.to), w.push(`p.created_at < $${v.length}::date + 1`));
    if (f.refunded) w.push(`EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = p.id)`);
    v.push(f.limit);
    return (await q.query<PaymentRow>(`${PAYMENT_SELECT} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY p.created_at DESC LIMIT $${v.length}`, v)).rows;
  };

  app.get('/api/admin/transactions', { preHandler: admin }, async (req) => {
    const f = txFilter.parse(req.query);
    const rows = await findPayments(f);
    const list = rows.map(paymentDto);
    const paid = list.filter((p) => p.status === 'paid');
    return {
      payments: list,
      totals: {
        count: list.length,
        paid: paid.length,
        paidInr: Math.round(paid.reduce((s, p) => s + p.amountInr, 0) * 100) / 100,
        refundedInr: Math.round(list.reduce((s, p) => s + p.refundedInr, 0) * 100) / 100,
        discountInr: Math.round(paid.reduce((s, p) => s + p.discountInr, 0) * 100) / 100,
        credits: paid.reduce((s, p) => s + p.credits + p.bonusCredits, 0),
      },
    };
  });

  app.get('/api/admin/transactions.csv', { preHandler: admin }, async (req, reply) => {
    const rows = (await findPayments(txFilter.parse(req.query))).map(paymentDto);
    return sendCsv(reply, 'payments', ['Created', 'Paid', 'Club', 'Order', 'Status', 'List price (INR)', 'Coupon', 'Discount (INR)', 'Paid (INR)', 'Credits', 'Bonus credits', 'Refunded (INR)', 'Invoice'], rows.map((p) => [
      p.createdAt, p.paidAt ?? '', p.orgName, p.orderId, p.status, p.listInr, p.couponCode ?? '', p.discountInr, p.amountInr, p.credits, p.bonusCredits, p.refundedInr, p.invoiceNumber ?? '',
    ]));
  });

  app.get('/api/admin/payments/:id', { preHandler: admin }, async (req) => {
    const p = (await q.query<PaymentRow>(`${PAYMENT_SELECT} WHERE p.id = $1`, [idOf(req)])).rows[0];
    if (!p) throw new HttpError(404, 'payment_not_found', 'Payment not found.');
    const events = (await q.query('SELECT id, at, type, signature_ok, result FROM payment_events WHERE order_id = $1 ORDER BY id DESC LIMIT 50', [p.order_id])).rows;
    return {
      payment: paymentDto(p),
      refunds: (await payments.refunds({ paymentId: p.id })).map(refundDto),
      events: events.map((e) => ({ id: Number(e.id), at: new Date(e.at).toISOString(), type: e.type, signatureOk: e.signature_ok, result: e.result })),
      balance: fromCc((await billing.orgBilling(p.org_id)).balance_cc),
    };
  });

  // ---------------------------------------------------------------- refunds
  app.post('/api/admin/payments/:id/refund', { preHandler: admin }, async (req) => {
    const b = z.object({ amountInr: z.number().positive().max(10_000_000), credits: z.number().min(0).max(10_000_000), note: z.string().trim().min(2).max(200) }).parse(req.body);
    return { refund: refundDto(await payments.refund(idOf(req), b, `admin:${userOf(req).email}`)) };
  });

  app.get('/api/admin/refunds', { preHandler: admin }, async (req) => {
    const f = z.object({ status: z.enum(['pending', 'success', 'failed', 'cancelled']).optional() }).parse(req.query);
    return { refunds: (await payments.refunds({ status: f.status, limit: 500 })).map(refundDto) };
  });

  app.post('/api/admin/refunds/:id/refresh', { preHandler: admin }, async (req) => {
    const r = (await q.query('SELECT * FROM refunds WHERE id = $1', [idOf(req)])).rows[0];
    if (!r) throw new HttpError(404, 'not_found', 'Refund not found.');
    return { refund: refundDto(await payments.refreshRefund(r)) };
  });

  // ---------------------------------------------------------------- wallet ledger (all clubs)
  const ledgerFilter = z.object({
    kind: z.enum(['purchase', 'cameras', 'minutes', 'admin', 'refund', 'destinations', 'viewership', 'messages']).optional(),
    org: uuid.optional(),
    from: dateStr.optional(),
    to: dateStr.optional(),
    limit: z.coerce.number().int().min(1).max(10000).default(500),
  });
  const ledger = async (f: z.infer<typeof ledgerFilter>) => {
    const w: string[] = [];
    const v: unknown[] = [];
    if (f.kind) (v.push(f.kind), w.push(`w.kind = $${v.length}`));
    if (f.org) (v.push(f.org), w.push(`w.org_id = $${v.length}`));
    if (f.from) (v.push(f.from), w.push(`w.created_at >= $${v.length}::date`));
    if (f.to) (v.push(f.to), w.push(`w.created_at < $${v.length}::date + 1`));
    v.push(f.limit);
    return (
      await q.query<WalletTxRow & { org_name: string; org_id: string }>(
        `SELECT w.*, t.name AS tournament_name, o.name AS org_name FROM wallet_tx w JOIN orgs o ON o.id = w.org_id LEFT JOIN tournaments t ON t.id = w.tournament_id
         ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY w.created_at DESC, w.id DESC LIMIT $${v.length}`,
        v,
      )
    ).rows;
  };
  app.get('/api/admin/ledger', { preHandler: admin }, async (req) => {
    const rows = await ledger(ledgerFilter.parse(req.query));
    const sums = (
      await q.query<{ kind: string; cc: string }>(`SELECT kind, sum(amount_cc)::text AS cc FROM wallet_tx GROUP BY kind`)
    ).rows.map((r) => ({ kind: r.kind, credits: fromCc(r.cc) }));
    const held = fromCc((await q.query<{ cc: string }>('SELECT COALESCE(sum(balance_cc), 0)::text AS cc FROM org_billing')).rows[0].cc);
    return { entries: rows.map((r) => ({ ...txDto(r), orgId: r.org_id, orgName: r.org_name })), totalsByKind: sums, creditsHeldByClubs: held };
  });
  app.get('/api/admin/ledger.csv', { preHandler: admin }, async (req, reply) => {
    const rows = await ledger(ledgerFilter.parse(req.query));
    return sendCsv(reply, 'wallet-ledger', ['When', 'Club', 'Kind', 'Event', 'Quantity', 'Credits', 'Note', 'By'], rows.map((r) => {
      const t = txDto(r);
      return [t.at, r.org_name, t.kind, t.tournamentName ?? '', t.quantity ?? '', t.credits, t.note ?? '', t.by ?? ''];
    }));
  });

  // ---------------------------------------------------------------- coupons
  const couponBody = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/, 'Use 3–30 letters, numbers, - or _'),
    kind: z.enum(['percent_off', 'bonus_credits']),
    value: z.number().positive().max(1_000_000),
    description: z.string().trim().max(200).nullish(),
    maxUses: z.number().int().min(1).max(1_000_000).nullish(),
    oncePerClub: z.boolean().default(true),
    minInr: z.number().min(0).max(10_000_000).nullish(),
    validFrom: z.string().datetime({ offset: true }).nullish(),
    validTo: z.string().datetime({ offset: true }).nullish(),
    active: z.boolean().default(true),
  });
  app.get('/api/admin/coupons', { preHandler: admin }, async () => ({
    coupons: (
      await q.query<CouponRow>('SELECT c.*, (SELECT count(*)::int FROM coupon_redemptions r WHERE r.code = c.code) AS uses FROM coupons c ORDER BY c.created_at DESC')
    ).rows.map(couponDto),
  }));
  app.post('/api/admin/coupons', { preHandler: admin }, async (req, reply) => {
    const b = couponBody.parse(req.body);
    if (b.kind === 'percent_off' && b.value > 100) throw new HttpError(400, 'bad_value', 'A discount cannot be more than 100%.');
    const r = await q.query<CouponRow>(
      `INSERT INTO coupons (code, kind, value, description, max_uses, once_per_club, min_inr, valid_from, valid_to, active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (code) DO NOTHING RETURNING *`,
      [b.code, b.kind, b.value, b.description ?? null, b.maxUses ?? null, b.oncePerClub, b.minInr ?? null, b.validFrom ?? null, b.validTo ?? null, b.active, userOf(req).id],
    );
    if (!r.rows[0]) throw new HttpError(409, 'coupon_exists', 'A coupon with that code already exists.');
    reply.status(201);
    return { coupon: couponDto(r.rows[0]) };
  });
  app.patch('/api/admin/coupons/:code', { preHandler: admin }, async (req) => {
    const code = z.string().max(30).parse((req.params as { code: string }).code).toUpperCase();
    const b = couponBody.omit({ code: true, kind: true, value: true }).partial().parse(req.body);
    const sets: string[] = [];
    const v: unknown[] = [code];
    const add = (col: string, val: unknown) => (v.push(val), sets.push(`${col} = $${v.length}`));
    if (b.description !== undefined) add('description', b.description);
    if (b.maxUses !== undefined) add('max_uses', b.maxUses);
    if (b.oncePerClub !== undefined) add('once_per_club', b.oncePerClub);
    if (b.minInr !== undefined) add('min_inr', b.minInr);
    if (b.validFrom !== undefined) add('valid_from', b.validFrom);
    if (b.validTo !== undefined) add('valid_to', b.validTo);
    if (b.active !== undefined) add('active', b.active);
    if (!sets.length) throw new HttpError(400, 'nothing', 'Nothing to change.');
    const r = await q.query<CouponRow>(`UPDATE coupons SET ${sets.join(', ')} WHERE code = $1 RETURNING *`, v);
    if (!r.rows[0]) throw new HttpError(404, 'not_found', 'Coupon not found.');
    return { coupon: couponDto(r.rows[0]) };
  });

  // ---------------------------------------------------------------- invoices
  const invoiceSettings = z.object({
    enabled: z.boolean(),
    legalName: z.string().trim().max(200),
    address: z.string().trim().max(500),
    gstin: z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'GSTIN must be 15 characters, like 06ABCDE1234F1Z5').nullish().or(z.literal('').transform(() => null)),
    pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'PAN must be 10 characters, like ABCDE1234F').nullish().or(z.literal('').transform(() => null)),
    stateCode: z.string().regex(/^\d{2}$/, 'State code is 2 digits, e.g. 06 for Haryana'),
    sac: z.string().trim().regex(/^\d{4,8}$/, 'SAC is 4 to 8 digits'),
    gstRate: z.number().min(0).max(28),
    pricesIncludeGst: z.boolean(),
    prefix: z.string().trim().regex(/^[A-Z0-9]{1,6}$/, 'Prefix: 1–6 capital letters or numbers'),
    email: z.string().trim().email().nullish().or(z.literal('').transform(() => null)),
  });
  app.get('/api/admin/invoice-settings', { preHandler: admin }, async () => invoices.settings());
  app.put('/api/admin/invoice-settings', { preHandler: admin }, async (req) => {
    const s = invoiceSettings.parse(req.body);
    if (s.enabled && (!s.legalName || !s.address)) throw new HttpError(400, 'incomplete', 'Enter the legal name and address before switching invoices on.');
    if (s.enabled && s.gstin && s.gstin.slice(0, 2) !== s.stateCode) throw new HttpError(400, 'state_mismatch', `Your GSTIN is registered in state ${s.gstin.slice(0, 2)}; set the state code to match.`);
    await invoices.saveSettings({ ...s, gstin: s.gstin ?? null, pan: s.pan ?? null, email: s.email ?? null });
    return invoices.settings();
  });
  app.get('/api/admin/invoices', { preHandler: admin }, async (req) => {
    const f = z.object({ org: uuid.optional(), from: dateStr.optional(), to: dateStr.optional() }).parse(req.query);
    return { invoices: (await invoices.list({ orgId: f.org, from: f.from, to: f.to, limit: 1000 })).map(invoiceDto) };
  });
  app.get('/api/admin/invoices.csv', { preHandler: admin }, async (req, reply) => {
    const f = z.object({ org: uuid.optional(), from: dateStr.optional(), to: dateStr.optional() }).parse(req.query);
    const rows = (await invoices.list({ orgId: f.org, from: f.from, to: f.to, limit: 100000 })).map(invoiceDto);
    return sendCsv(reply, 'gst-register', ['Number', 'Type', 'Date', 'Club', 'Buyer', 'Buyer GSTIN', 'Place of supply', 'Taxable (INR)', 'CGST', 'SGST', 'IGST', 'Total (INR)'], rows.map((i) => [
      i.number, i.kind === 'invoice' ? 'Invoice' : 'Credit note', i.issuedAt.slice(0, 10), i.orgName, i.buyer.name, i.buyer.gstin ?? '', i.buyer.stateCode ?? '', i.taxableInr, i.cgstInr, i.sgstInr, i.igstInr, i.kind === 'credit_note' ? -i.totalInr : i.totalInr,
    ]));
  });
  app.get('/admin/invoices/:id', { preHandler: admin }, async (req, reply) => {
    const inv = await invoices.byId(idOf(req));
    if (!inv) throw new HttpError(404, 'not_found', 'Invoice not found.');
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store');
    return invoiceHtml(inv);
  });
  app.post('/api/admin/invoices/backfill', { preHandler: admin }, async () => ({ created: await invoices.backfill() }));

  // ---------------------------------------------------------------- gateway webhooks
  app.get('/api/admin/payment-events', { preHandler: admin }, async (req) => {
    const f = z.object({ order: z.string().max(80).optional() }).parse(req.query);
    const rows = (
      await q.query(
        `SELECT id, at, provider, type, order_id, signature_ok, result, body FROM payment_events ${f.order ? 'WHERE order_id = $1' : ''} ORDER BY id DESC LIMIT 200`,
        f.order ? [f.order] : [],
      )
    ).rows;
    return { events: rows.map((e) => ({ id: Number(e.id), at: new Date(e.at).toISOString(), provider: e.provider, type: e.type, orderId: e.order_id, signatureOk: e.signature_ok, result: e.result, body: e.body })) };
  });
}
