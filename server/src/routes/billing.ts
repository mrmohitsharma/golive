import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';
import { requireAuth, userOf } from '../auth.js';
import { requireOrg, requireTournament } from '../authz.js';
import { fromCc, txDto } from '../billing.js';
import { paymentDto, type PaymentRow } from '../payments.js';
import { invoiceDto, invoiceHtml } from '../invoices.js';

const uuid = z.string().uuid();
const idParam = (req: { params: unknown }) => uuid.parse((req.params as { id: string }).id);
/** Indian mobile number as Cashfree wants it: 10 digits, optionally +91. */
const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => /^(\+91)?[6-9]\d{9}$/.test(v) || /^\+\d{8,15}$/.test(v), 'Enter a 10-digit mobile number');

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

let brand = 'Go Live';

function page(reply: FastifyReply, title: string, body: string, head = '') {
  reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store');
  return reply.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${head}<style>
body{margin:0;background:#0b0e10;color:#f3f5f4;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
.card{box-sizing:border-box;background:#15191c;border:1px solid #252b30;border-radius:14px;padding:24px;max-width:420px;width:100%}
.brand{font-weight:800;letter-spacing:.06em;font-size:12px;color:#c9a227;text-transform:uppercase}
h1{font-size:22px;margin:6px 0 4px}.sub{color:#9aa5a0;font-size:14px}.amt{font-size:34px;font-weight:800;margin:16px 0 4px}
button{margin-top:18px;width:100%;padding:14px;border:0;border-radius:10px;background:#2e7d4f;color:#fff;font:inherit;font-weight:700;cursor:pointer}
.ok{color:#7ddc9e;font-weight:700}.bad{color:#ff6b6b;font-weight:700}
</style></head><body><div class="card"><div class="brand">${esc(brand)}</div>${body}</div></body></html>`);
}

export function registerBillingRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, billing, payments, hub } = ctx;
  brand = config.BRAND_NAME;
  const user = requireAuth(config, 'user');

  // ---------------------------------------------------------------- club wallet
  app.get('/api/orgs/:id/billing', { preHandler: user }, async (req) => {
    const orgId = idParam(req);
    const role = await requireOrg(repo, req.principal!, orgId, 'create');
    const b = await billing.orgBilling(orgId);
    const [pricing, { packs }, txs] = await Promise.all([billing.pricingFor(orgId, b), billing.settings(), billing.transactions(orgId, 50)]);
    return {
      enabled: billing.enabled,
      balance: fromCc(b.balance_cc),
      pricing,
      packs,
      paymentsEnabled: payments.enabled,
      suspended: b.suspended,
      suspendedReason: b.suspended_reason,
      details: role === 'owner' ? { name: b.billing_name, phone: b.billing_phone, email: b.billing_email, gstin: b.gstin } : null,
      transactions: txs.map(txDto),
    };
  });

  app.put('/api/orgs/:id/billing/details', { preHandler: user }, async (req) => {
    const orgId = idParam(req);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    const body = z
      .object({
        name: z.string().trim().max(120).nullable().optional(),
        phone: phone.nullable().optional(),
        email: z.string().trim().email().nullable().optional(),
        gstin: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'GSTIN must be 15 characters, like 07ABCDE1234F1Z5')
          .nullable()
          .optional(),
      })
      .parse(req.body);
    const b = await billing.updateOrgBilling(orgId, body);
    return { details: { name: b.billing_name, phone: b.billing_phone, email: b.billing_email, gstin: b.gstin } };
  });

  /** Starts a credit purchase: returns a checkout page on this server to open in the browser. */
  app.post('/api/orgs/:id/billing/checkout', { preHandler: user }, async (req, reply) => {
    const orgId = idParam(req);
    await requireOrg(repo, req.principal!, orgId, 'create');
    const u = userOf(req);
    const body = z
      .object({
        packId: z.string().min(1).max(32),
        phone: phone.optional(),
        coupon: z.string().trim().max(40).nullish(),
        // Where to go back to after paying: only web app pages on this site.
        returnTo: z.string().regex(/^\/web(\/[\w-]+)*\/?$/).nullish(),
      })
      .parse(req.body);
    const b = await billing.orgBilling(orgId);
    const mobile = body.phone ?? b.billing_phone;
    if (!mobile) throw new HttpError(400, 'phone_required', 'Enter a mobile number for the payment receipt.');
    if (body.phone && !b.billing_phone) await billing.updateOrgBilling(orgId, { phone: body.phone });
    const r = await payments.checkout(orgId, u, body.packId, mobile, body.coupon, body.returnTo);
    reply.status(201);
    return { payment: paymentDto(r.payment), checkoutUrl: r.checkoutUrl };
  });

  /** Checks a coupon against a pack before paying: the price and credits it gives. */
  app.post('/api/orgs/:id/billing/coupon', { preHandler: user }, async (req) => {
    const orgId = idParam(req);
    await requireOrg(repo, req.principal!, orgId, 'create');
    const body = z.object({ packId: z.string().min(1).max(32), coupon: z.string().trim().min(1).max(40) }).parse(req.body);
    const q = await payments.quote(orgId, body.packId, body.coupon);
    return { listInr: q.listInr, amountInr: q.amountInr, discountInr: q.discountInr, credits: q.credits, bonusCredits: q.bonusCredits, description: q.coupon?.description ?? null };
  });

  /** GST invoices and credit notes of the club (owners). */
  app.get('/api/orgs/:id/invoices', { preHandler: user }, async (req) => {
    const orgId = idParam(req);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    return { invoices: (await ctx.invoices.list({ orgId, limit: 200 })).map(invoiceDto) };
  });

  /** A printable invoice. Opened in a browser tab, so the session token may come as ?token=. */
  app.get('/invoices/:id', { preHandler: user }, async (req, reply) => {
    const inv = await ctx.invoices.byId(idParam(req));
    if (!inv) throw new HttpError(404, 'not_found', 'Invoice not found.');
    await requireOrg(repo, req.principal!, inv.org_id, 'admin');
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store');
    return invoiceHtml(inv);
  });

  /** The app polls this after the browser checkout, to refresh the balance. */
  app.get('/api/payments/:id', { preHandler: user }, async (req) => {
    let p = await payments.byId(idParam(req));
    if (!p) throw new HttpError(404, 'payment_not_found', 'Payment not found.');
    await requireOrg(repo, req.principal!, p.org_id, 'create');
    if (p.status === 'created') p = await payments.confirm(p).catch(() => p!);
    return { payment: paymentDto(p), balance: fromCc((await billing.orgBilling(p.org_id)).balance_cc) };
  });

  // ---------------------------------------------------------------- tournament
  app.get('/api/tournaments/:id/billing', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'manage');
    return { billing: await billing.tournamentState(t) };
  });

  app.post('/api/tournaments/:id/billing/cameras', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'manage');
    const body = z.object({ count: z.number().int().min(1).max(20) }).parse(req.body);
    const state = await billing.buyCameras(t, body.count, userOf(req).email);
    hub.billingChanged(t.id, state);
    return { billing: state };
  });

  // ---------------------------------------------------------------- Cashfree pages
  app.get('/pay/:id', async (req, reply) => {
    const p = await payments.byId(idParam(req));
    if (!p) return page(reply.status(404), 'Payment', '<h1>Payment not found</h1>');
    const org = await repo.orgById(p.org_id);
    const summary = `<h1>Buy credits</h1><div class="sub">${esc(org?.name ?? '')}</div><div class="amt">₹${Number(p.amount_inr).toLocaleString('en-IN')}</div><div class="sub">${fromCc(p.credits_cc).toLocaleString('en-IN')} credits</div>`;
    if (p.status === 'paid') return page(reply, 'Paid', `${summary}<p class="ok">Already paid. You can close this page.</p>`);
    if (p.status !== 'created' || !p.session_id) return page(reply, 'Payment', `${summary}<p class="bad">This payment link has expired. Start again from the app.</p>`);
    const mode = payments.mode;
    return page(
      reply,
      'Buy credits',
      `${summary}<button id="pay">Pay ₹${Number(p.amount_inr).toLocaleString('en-IN')}</button><p class="sub" id="msg">Secure payment by Cashfree: UPI, cards, net banking.</p>
<script>
document.getElementById('pay').onclick = function () {
  try { Cashfree({ mode: ${JSON.stringify(mode)} }).checkout({ paymentSessionId: ${JSON.stringify(p.session_id)}, redirectTarget: '_self' }); }
  catch (e) { document.getElementById('msg').textContent = 'Could not open the payment page. Check your connection and try again.'; }
};
</script>`,
      `<script src="${esc(config.CASHFREE_SDK_URL)}"></script>`,
    );
  });

  /** Cashfree sends the payer back here; we confirm with Cashfree before showing success. */
  app.get('/pay/:id/done', async (req, reply) => {
    let p = await payments.byId(idParam(req));
    if (!p) return page(reply.status(404), 'Payment', '<h1>Payment not found</h1>');
    let error: string | null = null;
    p = await payments.confirm(p).catch((err: Error) => {
      error = err.message;
      return p as PaymentRow;
    });
    const balance = fromCc((await billing.orgBilling(p.org_id)).balance_cc);
    const back = p.return_path ? `${p.return_path}?paid=${p.id}` : null;
    if (p.status === 'paid') {
      const credits = fromCc(Number(p.credits_cc) + Number(p.bonus_cc ?? 0)).toLocaleString('en-IN');
      return page(
        reply,
        'Payment received',
        back
          ? `<h1>Payment received</h1><p class="ok">${credits} credits added.</p><p class="sub">Balance: ${balance.toLocaleString('en-IN')} credits. Taking you back…</p><button onclick="location.href='${esc(back)}'">Back to ${esc(brand)}</button><script>setTimeout(function(){location.href=${JSON.stringify(back)}},2500)</script>`
          : `<h1>Payment received</h1><p class="ok">${credits} credits added.</p><p class="sub">Balance: ${balance.toLocaleString('en-IN')} credits. Go back to the ${esc(brand)} app.</p>`,
      );
    }
    if (back && p.status !== 'created') {
      return page(reply, 'Payment', `<h1>Payment not completed</h1><p class="bad">${p.status === 'expired' ? 'The payment expired.' : 'The payment failed.'}</p><button onclick="location.href='${esc(back)}'">Back to ${esc(brand)}</button>`);
    }
    if (p.status === 'expired') return page(reply, 'Payment', '<h1>Payment not completed</h1><p class="bad">The payment expired. Start again from the app.</p>');
    return page(
      reply,
      'Payment',
      `<h1>Payment not completed yet</h1><p class="sub">${error ? esc(error) : 'If money left your account, the credits are added automatically within a few minutes.'}</p><button onclick="location.reload()">Check again</button>`,
    );
  });

  // Webhook needs the exact bytes Cashfree signed, so JSON is parsed here by hand.
  app.register(async (inst) => {
    inst.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    inst.post('/api/payments/cashfree/webhook', async (req, reply) => {
      const raw = typeof req.body === 'string' ? req.body : '';
      const h = req.headers;
      let parsed: any = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      const type: string | null = parsed?.type ?? null;
      const orderId: string | undefined = parsed?.data?.order?.order_id ?? parsed?.data?.refund?.order_id;
      const sigOk = payments.verifyWebhook(raw, h['x-webhook-timestamp'] as string | undefined, h['x-webhook-signature'] as string | undefined);
      // Every webhook is logged, signed or not, so support can see what Cashfree sent.
      const log = (result: string) =>
        repo.db
          .query('INSERT INTO payment_events (type, order_id, signature_ok, result, body) VALUES ($1, $2, $3, $4, $5)', [type, orderId ?? null, sigOk, result, parsed ? JSON.stringify(parsed) : null])
          .catch((err) => req.log.warn({ err }, 'payment event log failed'));
      if (!sigOk) {
        req.log.warn('cashfree webhook with a bad signature');
        await log('rejected: bad signature');
        return reply.status(401).send({ ok: false });
      }
      let result = 'ignored';
      try {
        const refundId: string | undefined = parsed?.data?.refund?.refund_id;
        if (refundId) {
          const r = await payments.refundByRefundId(refundId);
          if (r) result = `refund ${(await payments.refreshRefund(r)).status}`;
        } else {
          const p = orderId ? await payments.byOrder(orderId) : null;
          if (p) result = `payment ${(await payments.confirm(p)).status}`;
          else result = 'unknown order';
        }
      } catch (err) {
        result = `error: ${(err as Error).message}`;
        req.log.warn({ err: (err as Error).message, orderId }, 'payment confirm failed');
      }
      await log(result);
      return { ok: true };
    });
  });
}
