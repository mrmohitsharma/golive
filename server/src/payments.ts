import crypto from 'node:crypto';
import type pg from 'pg';
import type { Config } from './config.js';
import type { Repo } from './repo.js';
import { HttpError } from './errors.js';
import { BillingService, fromCc, toCc } from './billing.js';
import { constantTimeEqual } from './crypto.js';
import type { PlatformSecrets } from './secrets.js';
import type { InvoiceService } from './invoices.js';

/** Payment gateway keys: from Admin > Money (stored encrypted) or, if not set there, the server config. */
export interface CashfreeCreds {
  clientId: string;
  clientSecret: string;
  env: 'sandbox' | 'production';
  enabled: boolean;
}

export interface CouponRow {
  code: string;
  kind: 'percent_off' | 'bonus_credits';
  value: string;
  description: string | null;
  max_uses: number | null;
  once_per_club: boolean;
  min_inr: string | null;
  valid_from: Date | null;
  valid_to: Date | null;
  active: boolean;
  created_at: Date;
  uses?: number;
}

export interface RefundRow {
  id: string;
  payment_id: string;
  org_id: string;
  refund_id: string;
  amount_inr: string;
  credits_cc: string;
  status: 'pending' | 'success' | 'failed' | 'cancelled';
  note: string | null;
  provider_ref: string | null;
  error: string | null;
  created_by: string | null;
  created_at: Date;
  processed_at: Date | null;
  order_id?: string;
  org_name?: string;
}

export function refundDto(r: RefundRow) {
  return {
    id: r.id,
    paymentId: r.payment_id,
    orgId: r.org_id,
    orgName: r.org_name ?? null,
    orderId: r.order_id ?? null,
    refundId: r.refund_id,
    amountInr: Number(r.amount_inr),
    credits: fromCc(r.credits_cc),
    status: r.status,
    note: r.note,
    error: r.error,
    by: r.created_by,
    createdAt: new Date(r.created_at).toISOString(),
    processedAt: r.processed_at ? new Date(r.processed_at).toISOString() : null,
  };
}

export function couponDto(c: CouponRow) {
  return {
    code: c.code,
    kind: c.kind,
    value: Number(c.value),
    description: c.description,
    maxUses: c.max_uses,
    oncePerClub: c.once_per_club,
    minInr: c.min_inr == null ? null : Number(c.min_inr),
    validFrom: c.valid_from ? new Date(c.valid_from).toISOString() : null,
    validTo: c.valid_to ? new Date(c.valid_to).toISOString() : null,
    active: c.active,
    uses: c.uses ?? 0,
    createdAt: new Date(c.created_at).toISOString(),
  };
}

export interface PaymentRow {
  id: string;
  org_id: string;
  provider: string;
  order_id: string;
  pack_id: string | null;
  amount_inr: string;
  credits_cc: string;
  status: 'created' | 'paid' | 'failed' | 'expired';
  session_id: string | null;
  provider_ref: string | null;
  created_by: string | null;
  created_at: Date;
  paid_at: Date | null;
  list_inr?: string | null;
  coupon_code?: string | null;
  discount_inr?: string;
  bonus_cc?: string;
  org_name?: string;
  refunded_inr?: string | null;
  invoice_id?: string | null;
  invoice_number?: string | null;
}

export function paymentDto(p: PaymentRow) {
  return {
    id: p.id,
    orgId: p.org_id,
    orgName: p.org_name ?? null,
    orderId: p.order_id,
    packId: p.pack_id,
    amountInr: Number(p.amount_inr),
    credits: fromCc(p.credits_cc),
    status: p.status,
    createdAt: p.created_at.toISOString(),
    paidAt: p.paid_at?.toISOString() ?? null,
    listInr: p.list_inr == null ? Number(p.amount_inr) : Number(p.list_inr),
    couponCode: p.coupon_code ?? null,
    discountInr: Number(p.discount_inr ?? 0),
    bonusCredits: fromCc(p.bonus_cc ?? 0),
    refundedInr: Number(p.refunded_inr ?? 0),
    invoiceId: p.invoice_id ?? null,
    invoiceNumber: p.invoice_number ?? null,
  };
}

/** Payments with their refunded total and invoice (for lists). */
export const PAYMENT_SELECT = `SELECT p.*, o.name AS org_name,
  (SELECT COALESCE(sum(r.amount_inr), 0) FROM refunds r WHERE r.payment_id = p.id AND r.status IN ('pending', 'success'))::text AS refunded_inr,
  (SELECT i.id FROM invoices i WHERE i.payment_id = p.id AND i.kind = 'invoice') AS invoice_id,
  (SELECT i.number FROM invoices i WHERE i.payment_id = p.id AND i.kind = 'invoice') AS invoice_number
  FROM payments p JOIN orgs o ON o.id = p.org_id`;

/**
 * Credit purchases through Cashfree Payment Gateway (hosted checkout):
 *  1. The app asks for a checkout: we create a Cashfree order and a `payments` row, and
 *     return /pay/<id> on this server.
 *  2. That page opens Cashfree's checkout with the order's payment_session_id.
 *  3. Cashfree redirects back to /pay/<id>/done and also calls the webhook. Either way the
 *     server asks Cashfree for the order: only an order Cashfree reports as PAID, for the
 *     right amount, adds credits, and only once (wallet_tx ref = order id).
 */
export class PaymentsService {
  /** Keys in use; set from the database at start and whenever an admin saves new ones. */
  creds: CashfreeCreds | null = null;
  /** Where the keys came from. */
  source: 'admin' | 'server config' | 'none' = 'none';
  invoices: InvoiceService | null = null;

  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
    private readonly billing: BillingService,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly secrets: PlatformSecrets | null = null,
  ) {
    this.useConfig();
  }

  private useConfig(): void {
    const c = this.config;
    if (c.CASHFREE_CLIENT_ID && c.CASHFREE_CLIENT_SECRET) {
      this.creds = { clientId: c.CASHFREE_CLIENT_ID, clientSecret: c.CASHFREE_CLIENT_SECRET, env: c.CASHFREE_ENV, enabled: true };
      this.source = 'server config';
    } else {
      this.creds = null;
      this.source = 'none';
    }
  }

  /** Loads keys saved in the admin panel (they win over the server config). */
  async reload(): Promise<void> {
    const saved = this.secrets ? await this.secrets.get<CashfreeCreds>('cashfree') : null;
    if (saved && saved.clientId && saved.clientSecret) {
      this.creds = saved;
      this.source = 'admin';
    } else this.useConfig();
  }

  get enabled(): boolean {
    return Boolean(this.creds?.enabled && this.creds.clientId && this.creds.clientSecret) && this.billing.enabled;
  }

  get mode(): 'sandbox' | 'production' {
    return this.creds?.env ?? this.config.CASHFREE_ENV;
  }

  base(env = this.mode): string {
    return (this.config.CASHFREE_API_BASE ?? (env === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg')).replace(/\/$/, '');
  }

  private headers(creds = this.creds): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-api-version': this.config.CASHFREE_API_VERSION,
      'x-client-id': creds?.clientId ?? '',
      'x-client-secret': creds?.clientSecret ?? '',
    };
  }

  /**
   * Checks keys with Cashfree without charging anything: asks for an order that does not
   * exist. "Not found" means the keys work; "authentication failed" means they do not.
   */
  async testConnection(creds: CashfreeCreds): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await this.fetchImpl(`${this.base(creds.env)}/orders/golive_connection_test_${Date.now()}`, { method: 'GET', headers: this.headers(creds) });
      const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
      if (res.status === 404) return { ok: true, message: `Connected to Cashfree (${creds.env}).` };
      if (res.status === 401 || res.status === 403) return { ok: false, message: `Cashfree refused the keys: ${body.message ?? 'authentication failed'}.` };
      return { ok: res.ok, message: body.message ?? `Cashfree answered HTTP ${res.status}.` };
    } catch (err) {
      return { ok: false, message: `Could not reach Cashfree: ${(err as Error).message}` };
    }
  }

  private async call<T>(method: string, path: string, body?: object, idempotencyKey?: string): Promise<T> {
    const res = await this.fetchImpl(`${this.base()}${path}`, {
      method,
      headers: { ...this.headers(), ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const msg = typeof json.message === 'string' ? json.message : `HTTP ${res.status}`;
      throw new HttpError(502, 'payment_gateway', `Cashfree: ${msg}`);
    }
    return json as T;
  }

  async byId(id: string): Promise<PaymentRow | null> {
    return (await this.repo.db.query<PaymentRow>('SELECT * FROM payments WHERE id = $1', [id])).rows[0] ?? null;
  }

  async byOrder(orderId: string): Promise<PaymentRow | null> {
    return (await this.repo.db.query<PaymentRow>('SELECT * FROM payments WHERE order_id = $1', [orderId])).rows[0] ?? null;
  }

  // ------------------------------------------------------------------ coupons
  /** What a coupon does to a pack for this club, or why it cannot be used. */
  async quote(orgId: string, packId: string, code: string | null | undefined) {
    const { packs } = await this.billing.settings();
    const pack = packs.find((p) => p.id === packId);
    if (!pack) throw new HttpError(404, 'pack_not_found', 'That credit pack is no longer offered. Refresh and pick again.');
    const out = { pack, listInr: pack.priceInr, amountInr: pack.priceInr, discountInr: 0, credits: pack.credits, bonusCredits: 0, coupon: null as CouponRow | null };
    if (!code) return out;
    const c = (await this.repo.db.query<CouponRow>('SELECT * FROM coupons WHERE code = $1', [code.trim().toUpperCase()])).rows[0];
    const bad = (m: string) => new HttpError(400, 'coupon_invalid', m);
    if (!c || !c.active) throw bad('That coupon code is not valid.');
    const now = Date.now();
    if (c.valid_from && new Date(c.valid_from).getTime() > now) throw bad('That coupon is not active yet.');
    if (c.valid_to && new Date(c.valid_to).getTime() < now) throw bad('That coupon has expired.');
    if (c.min_inr != null && pack.priceInr < Number(c.min_inr)) throw bad(`That coupon works on packs of ₹${Number(c.min_inr).toLocaleString('en-IN')} or more.`);
    const used = (await this.repo.db.query<{ all: number; club: number }>('SELECT count(*)::int AS all, count(*) FILTER (WHERE org_id = $2)::int AS club FROM coupon_redemptions WHERE code = $1', [c.code, orgId])).rows[0];
    if (c.max_uses != null && used.all >= c.max_uses) throw bad('That coupon has been used up.');
    if (c.once_per_club && used.club > 0) throw bad('Your club has already used that coupon.');
    out.coupon = c;
    if (c.kind === 'percent_off') {
      const pct = Math.min(100, Number(c.value));
      out.discountInr = Math.round(pack.priceInr * pct) / 100;
      out.amountInr = Math.max(1, Math.round((pack.priceInr - out.discountInr) * 100) / 100);
      out.discountInr = Math.round((pack.priceInr - out.amountInr) * 100) / 100;
    } else out.bonusCredits = Number(c.value);
    return out;
  }

  async checkout(orgId: string, user: { id: string; email: string; name: string }, packId: string, phone: string, couponCode?: string | null): Promise<{ payment: PaymentRow; checkoutUrl: string }> {
    if (!this.enabled) throw new HttpError(501, 'payments_off', 'Online payment is not set up on this server yet. Contact Go Live to add credits.');
    await this.billing.checkNotSuspended(orgId);
    const q = await this.quote(orgId, packId, couponCode);
    const pack = q.pack;
    const org = await this.repo.orgById(orgId);
    const orderId = `cg_${crypto.randomBytes(12).toString('hex')}`;
    const payment = (
      await this.repo.db.query<PaymentRow>(
        `INSERT INTO payments (org_id, order_id, pack_id, amount_inr, credits_cc, created_by, list_inr, coupon_code, discount_inr, bonus_cc)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [orgId, orderId, pack.id, q.amountInr.toFixed(2), toCc(pack.credits), user.id, pack.priceInr.toFixed(2), q.coupon?.code ?? null, q.discountInr.toFixed(2), toCc(q.bonusCredits)],
      )
    ).rows[0];
    const base = this.config.PUBLIC_BASE_URL.replace(/\/$/, '');
    try {
      const order = await this.call<{ payment_session_id?: string; cf_order_id?: string | number }>(
        'POST',
        '/orders',
        {
          order_id: orderId,
          order_amount: Number(q.amountInr.toFixed(2)),
          order_currency: 'INR',
          customer_details: {
            customer_id: `org${orgId.replace(/-/g, '')}`,
            customer_phone: phone,
            customer_email: user.email,
            customer_name: user.name.slice(0, 100),
          },
          order_meta: {
            return_url: `${base}/pay/${payment.id}/done`,
            ...(base.startsWith('https://') ? { notify_url: `${base}/api/payments/cashfree/webhook` } : {}),
          },
          order_note: `${pack.label} credits for ${org?.name ?? 'club'}`.slice(0, 200),
          order_tags: { org_id: orgId, pack_id: pack.id },
        },
        payment.id,
      );
      if (!order.payment_session_id) throw new HttpError(502, 'payment_gateway', 'Cashfree did not return a payment session.');
      await this.repo.db.query('UPDATE payments SET session_id = $2, provider_ref = $3 WHERE id = $1', [payment.id, order.payment_session_id, String(order.cf_order_id ?? '')]);
    } catch (err) {
      await this.repo.db.query("UPDATE payments SET status = 'failed' WHERE id = $1", [payment.id]);
      throw err;
    }
    return { payment: (await this.byId(payment.id))!, checkoutUrl: `${base}/pay/${payment.id}` };
  }

  /** Asks Cashfree for the order and applies the result. Safe to call any number of times. */
  async confirm(p: PaymentRow): Promise<PaymentRow> {
    if (p.status === 'paid' || !this.enabled) return p;
    const order = await this.call<{ order_status?: string; order_amount?: number; order_currency?: string }>('GET', `/orders/${encodeURIComponent(p.order_id)}`);
    const status = order.order_status ?? '';
    if (status === 'PAID') {
      if (Math.round(Number(order.order_amount) * 100) !== Math.round(Number(p.amount_inr) * 100) || (order.order_currency && order.order_currency !== 'INR')) {
        throw new HttpError(409, 'amount_mismatch', 'The paid amount does not match the order. Contact CoGolfers support.');
      }
      await this.repo.tx(async (c) => {
        const upd = await c.query("UPDATE payments SET status = 'paid', paid_at = now() WHERE id = $1 AND status <> 'paid' RETURNING id", [p.id]);
        if (upd.rows[0]) {
          const bonus = Number(p.bonus_cc ?? 0);
          const note = `Bought ${fromCc(p.credits_cc)} credits (₹${Number(p.amount_inr)})${bonus ? ` + ${fromCc(bonus)} bonus` : ''}${p.coupon_code ? `, coupon ${p.coupon_code}` : ''}`;
          await this.billing.credit(p.org_id, Number(p.credits_cc) + bonus, { kind: 'purchase', ref: p.order_id, note, by: (await c.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [p.created_by])).rows[0]?.email ?? null }, c);
          if (p.coupon_code) await c.query('INSERT INTO coupon_redemptions (code, org_id, payment_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [p.coupon_code, p.org_id, p.id]);
          if (this.invoices) await this.invoices.forPayment(p.id, c);
        }
      });
    } else if (status === 'EXPIRED' || status === 'TERMINATED') {
      await this.repo.db.query("UPDATE payments SET status = 'expired' WHERE id = $1 AND status = 'created'", [p.id]);
    }
    return (await this.byId(p.id))!;
  }

  /** Cashfree webhook signature: base64(HMAC-SHA256(timestamp + rawBody, client secret)). */
  verifyWebhook(rawBody: string, timestamp: string | undefined, signature: string | undefined): boolean {
    if (!this.enabled || !timestamp || !signature) return false;
    const expected = crypto.createHmac('sha256', this.creds!.clientSecret).update(timestamp + rawBody).digest('base64');
    return constantTimeEqual(expected, signature);
  }

  async list(where: { orgId?: string; status?: string }, limit = 100): Promise<PaymentRow[]> {
    const cond: string[] = [];
    const vals: unknown[] = [];
    if (where.orgId) {
      vals.push(where.orgId);
      cond.push(`p.org_id = $${vals.length}`);
    }
    if (where.status) {
      vals.push(where.status);
      cond.push(`p.status = $${vals.length}`);
    }
    vals.push(limit);
    return (
      await this.repo.db.query<PaymentRow>(`${PAYMENT_SELECT} ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY p.created_at DESC LIMIT $${vals.length}`, vals)
    ).rows;
  }

  // ------------------------------------------------------------------ refunds
  /**
   * Refunds part or all of a paid payment through Cashfree. The credits chosen are taken from
   * the club's wallet straight away (given back if Cashfree reports the refund failed).
   */
  async refund(paymentId: string, v: { amountInr: number; credits: number; note: string }, by: string): Promise<RefundRow> {
    if (!this.enabled) throw new HttpError(501, 'payments_off', 'Set up the payment gateway first (Admin > Money > Gateway).');
    const p = (await this.repo.db.query<PaymentRow>(`${PAYMENT_SELECT} WHERE p.id = $1`, [paymentId])).rows[0];
    if (!p) throw new HttpError(404, 'payment_not_found', 'Payment not found.');
    if (p.status !== 'paid') throw new HttpError(409, 'not_paid', 'Only paid payments can be refunded.');
    const left = Math.round((Number(p.amount_inr) - Number(p.refunded_inr ?? 0)) * 100) / 100;
    const amount = Math.round(v.amountInr * 100) / 100;
    if (amount <= 0 || amount > left) throw new HttpError(400, 'refund_amount', `You can refund up to ₹${left.toLocaleString('en-IN')} on this payment.`);
    const cc = toCc(v.credits);
    const refundId = `rf_${crypto.randomBytes(10).toString('hex')}`;
    const row = await this.repo.tx(async (c) => {
      if (cc > 0) {
        const ok = await this.billing.takeBack(c, p.org_id, cc, { ref: refundId, note: `Refund of ₹${amount} (order ${p.order_id})`, by });
        if (!ok) {
          const bal = fromCc((await this.billing.orgBilling(p.org_id, c)).balance_cc);
          throw new HttpError(409, 'balance_too_low', `The club has only ${bal.toLocaleString('en-IN')} credits left; take back that many or fewer.`);
        }
      }
      return (
        await c.query<RefundRow>(
          `INSERT INTO refunds (payment_id, org_id, refund_id, amount_inr, credits_cc, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [p.id, p.org_id, refundId, amount.toFixed(2), cc, v.note, by],
        )
      ).rows[0];
    });
    if (cc > 0) await this.billing.walletChangedPublic(p.org_id);
    try {
      const r = await this.call<{ refund_status?: string; cf_refund_id?: string | number }>(
        'POST',
        `/orders/${encodeURIComponent(p.order_id)}/refunds`,
        { refund_amount: amount, refund_id: refundId, refund_note: v.note.slice(0, 100) },
        refundId,
      );
      await this.repo.db.query('UPDATE refunds SET provider_ref = $2 WHERE id = $1', [row.id, String(r.cf_refund_id ?? '')]);
      return this.applyRefundStatus(row, r.refund_status ?? 'PENDING', null);
    } catch (err) {
      return this.applyRefundStatus(row, 'FAILED', (err as Error).message);
    }
  }

  /** Asks Cashfree for the refund's status (also called from the refund webhook). */
  async refreshRefund(row: RefundRow): Promise<RefundRow> {
    if (row.status !== 'pending' || !this.enabled) return row;
    const order = (await this.repo.db.query<{ order_id: string }>('SELECT order_id FROM payments WHERE id = $1', [row.payment_id])).rows[0];
    const r = await this.call<{ refund_status?: string; status_description?: string }>('GET', `/orders/${encodeURIComponent(order.order_id)}/refunds/${encodeURIComponent(row.refund_id)}`);
    return this.applyRefundStatus(row, r.refund_status ?? 'PENDING', r.status_description ?? null);
  }

  private async applyRefundStatus(row: RefundRow, status: string, error: string | null): Promise<RefundRow> {
    const s = status.toUpperCase();
    if (s === 'SUCCESS') {
      await this.repo.tx(async (c) => {
        const u = await c.query("UPDATE refunds SET status = 'success', processed_at = now(), error = NULL WHERE id = $1 AND status = 'pending' RETURNING id", [row.id]);
        if (u.rows[0] && this.invoices) await this.invoices.forRefund(row.id, c);
      });
    } else if (s === 'FAILED' || s === 'CANCELLED') {
      await this.repo.tx(async (c: pg.PoolClient) => {
        const u = await c.query(`UPDATE refunds SET status = $2, processed_at = now(), error = $3 WHERE id = $1 AND status = 'pending' RETURNING id`, [row.id, s === 'FAILED' ? 'failed' : 'cancelled', error]);
        // The refund did not happen: give the credits back.
        if (u.rows[0] && Number(row.credits_cc) > 0) {
          await this.billing.credit(row.org_id, Number(row.credits_cc), { kind: 'refund', ref: `${row.refund_id}:back`, note: 'Refund did not go through; credits returned', by: 'system' }, c);
        }
      });
    }
    return (await this.repo.db.query<RefundRow>('SELECT * FROM refunds WHERE id = $1', [row.id])).rows[0];
  }

  async refundByRefundId(refundId: string): Promise<RefundRow | null> {
    return (await this.repo.db.query<RefundRow>('SELECT * FROM refunds WHERE refund_id = $1', [refundId])).rows[0] ?? null;
  }

  async refunds(f: { paymentId?: string; status?: string; limit?: number } = {}): Promise<RefundRow[]> {
    const w: string[] = [];
    const v: unknown[] = [];
    if (f.paymentId) (v.push(f.paymentId), w.push(`r.payment_id = $${v.length}`));
    if (f.status) (v.push(f.status), w.push(`r.status = $${v.length}`));
    v.push(f.limit ?? 200);
    return (
      await this.repo.db.query<RefundRow>(
        `SELECT r.*, p.order_id, o.name AS org_name FROM refunds r JOIN payments p ON p.id = r.payment_id JOIN orgs o ON o.id = r.org_id
         ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY r.created_at DESC LIMIT $${v.length}`,
        v,
      )
    ).rows;
  }
}
