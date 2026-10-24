import crypto from 'node:crypto';
import type { Config } from './config.js';
import { cashfreeBase, cashfreeEnabled } from './config.js';
import type { Repo } from './repo.js';
import { HttpError } from './errors.js';
import { BillingService, fromCc, toCc } from './billing.js';
import { constantTimeEqual } from './crypto.js';

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
  org_name?: string;
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
  };
}

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
  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
    private readonly billing: BillingService,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return cashfreeEnabled(this.config) && this.billing.enabled;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-api-version': this.config.CASHFREE_API_VERSION,
      'x-client-id': this.config.CASHFREE_CLIENT_ID ?? '',
      'x-client-secret': this.config.CASHFREE_CLIENT_SECRET ?? '',
    };
  }

  private async call<T>(method: string, path: string, body?: object, idempotencyKey?: string): Promise<T> {
    const res = await this.fetchImpl(`${cashfreeBase(this.config)}${path}`, {
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

  async checkout(orgId: string, user: { id: string; email: string; name: string }, packId: string, phone: string): Promise<{ payment: PaymentRow; checkoutUrl: string }> {
    if (!this.enabled) throw new HttpError(501, 'payments_off', 'Online payment is not set up on this server yet. Contact CoGolfers to add credits.');
    await this.billing.checkNotSuspended(orgId);
    const { packs } = await this.billing.settings();
    const pack = packs.find((p) => p.id === packId);
    if (!pack) throw new HttpError(404, 'pack_not_found', 'That credit pack is no longer offered. Refresh and pick again.');
    const org = await this.repo.orgById(orgId);
    const orderId = `cg_${crypto.randomBytes(12).toString('hex')}`;
    const payment = (
      await this.repo.db.query<PaymentRow>(
        'INSERT INTO payments (org_id, order_id, pack_id, amount_inr, credits_cc, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [orgId, orderId, pack.id, pack.priceInr.toFixed(2), toCc(pack.credits), user.id],
      )
    ).rows[0];
    const base = this.config.PUBLIC_BASE_URL.replace(/\/$/, '');
    try {
      const order = await this.call<{ payment_session_id?: string; cf_order_id?: string | number }>(
        'POST',
        '/orders',
        {
          order_id: orderId,
          order_amount: Number(pack.priceInr.toFixed(2)),
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
          await this.billing.credit(p.org_id, Number(p.credits_cc), { kind: 'purchase', ref: p.order_id, note: `Bought ${fromCc(p.credits_cc)} credits (₹${Number(p.amount_inr)})`, by: (await c.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [p.created_by])).rows[0]?.email ?? null }, c);
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
    const expected = crypto.createHmac('sha256', this.config.CASHFREE_CLIENT_SECRET!).update(timestamp + rawBody).digest('base64');
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
      await this.repo.db.query<PaymentRow>(
        `SELECT p.*, o.name AS org_name FROM payments p JOIN orgs o ON o.id = p.org_id ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
         ORDER BY p.created_at DESC LIMIT $${vals.length}`,
        vals,
      )
    ).rows;
  }
}
