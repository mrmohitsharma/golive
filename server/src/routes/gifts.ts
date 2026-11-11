import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import type { GiftService } from '../gift-service.js';
import { requireAuth, userOf } from '../auth.js';
import { requireOrg, requireTournament } from '../authz.js';
import { HttpError } from '../errors.js';
import { agreementDto, cleanStickers, eventGifts, giftSplit, giftStaffDto, OVERRIDABLE, payeeDto, payoutDto, type GiftRow } from '../gifts.js';
import { adminGuard } from './web.js';
import { esc, page } from './billing.js';

const uuid = z.string().uuid();
const pid = (req: FastifyRequest, k = 'id') => uuid.parse((req.params as Record<string, string>)[k]);
const cell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};
const csv = (reply: FastifyReply, name: string, head: string[], rows: unknown[][]) => {
  reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}.csv"`);
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
};
const ist = (d: Date | null) => (d ? d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '');

/**
 * V9 gift credits. Viewers: what is offered, start a gift (UPI on Cashfree), the hosted pay and
 * return pages. Organisers: the event's gift set-up and moderation. Clubs: payout details, the
 * emailed agreement, statements. Admin: settings, per-club overrides, verification, payout runs.
 */
export function registerGiftRoutes(app: FastifyInstance, ctx: Ctx & { gifts: GiftService }) {
  const { config, repo, gifts, payments, sealer } = ctx;
  const any = requireAuth(config);
  const user = requireAuth(config, 'user');
  const admin = adminGuard(ctx);
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, '');
  const publicEvent = async (id: string) => {
    const t = await repo.tournamentById(id);
    if (!t || t.archived || !t.public_watch) throw new HttpError(404, 'not_found', 'Event not found.');
    return t;
  };
  const by = (req: FastifyRequest) => {
    const p = req.principal!;
    return p.kind === 'user' ? p.email : p.name;
  };
  const example = (s: Awaited<ReturnType<GiftService['settings']>>) => giftSplit(101, s);

  // ---------------------------------------------------------------- viewers
  app.get('/api/public/tournaments/:id/gifts', async (req, reply) => {
    const id = pid(req);
    reply.header('Cache-Control', 'no-store');
    return gifts.publicViewById(id, () => publicEvent(id));
  });

  app.post('/api/public/tournaments/:id/gifts', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const t = await publicEvent(pid(req));
    const b = z
      .object({
        name: z.string().max(60),
        message: z.string().max(300).nullish(),
        stickerId: z.string().max(40).nullish(),
        amount: z.number().positive().max(10_000_000).nullish(),
        device: z.string().min(8).max(100),
      })
      .parse(req.body);
    const r = await gifts.create(t, { ...b, ip: req.ip });
    reply.status(201);
    return { giftId: r.gift.id, checkoutUrl: r.checkoutUrl };
  });

  app.get('/api/public/gifts/:id', async (req) => {
    const g = await gifts.byId(pid(req));
    if (!g) throw new HttpError(404, 'gift_not_found', 'Gift not found.');
    return { status: g.status, amount: Number(g.amount_inr), approved: g.approved };
  });

  app.get('/gift/:id', async (req, reply) => {
    const g = await gifts.byId(pid(req));
    if (!g) return page(reply.status(404), 'Gift', '<h1>Gift not found</h1>');
    const t = await repo.tournamentById(g.tournament_id);
    const s = await gifts.forOrg(g.org_id);
    const amt = `₹${Number(g.amount_inr).toLocaleString('en-IN')}`;
    const summary = `<h1>${esc(g.sticker?.emoji ?? '🎁')} ${esc(s.label)}</h1><div class="sub">${esc(t?.name ?? '')}</div><div class="amt">${amt}</div><div class="sub">From ${esc(g.sender_name)}${g.message ? `: “${esc(g.message)}”` : ''}</div>`;
    if (g.status === 'paid') return page(reply, 'Thank you', `${summary}<p class="ok">Sent. Thank you!</p><p><a style="color:#c9a227" href="/watch/${g.tournament_id}">Back to the broadcast</a></p>`);
    if (g.status !== 'created' || !g.session_id) return page(reply, 'Gift', `${summary}<p class="bad">This payment has expired. Go back and send the gift again.</p>`);
    return page(
      reply,
      s.label,
      `${summary}<button id="pay">Pay ${amt} by UPI</button><p class="sub" id="msg">Secure UPI payment by Cashfree. Gifts are voluntary and not refunded once sent.</p>
<script>
document.getElementById('pay').onclick = function () {
  try { Cashfree({ mode: ${JSON.stringify(payments.mode)} }).checkout({ paymentSessionId: ${JSON.stringify(g.session_id)}, redirectTarget: '_self' }); }
  catch (e) { document.getElementById('msg').textContent = 'Could not open the payment page. Check your connection and try again.'; }
};
</script>`,
      `<script src="${esc(config.CASHFREE_SDK_URL)}"></script>`,
    );
  });

  /** Cashfree sends the viewer back here: confirm, then back to the broadcast. */
  app.get('/gift/:id/done', async (req, reply) => {
    let g = await gifts.byId(pid(req));
    if (!g) return page(reply.status(404), 'Gift', '<h1>Gift not found</h1>');
    g = await gifts.confirm(g).catch(() => g as GiftRow);
    if (g.status === 'paid') return reply.redirect(`/watch/${g.tournament_id}?gift=${g.id}`);
    const pending = g.status === 'created';
    return page(
      reply,
      'Gift',
      `<h1>${pending ? 'Waiting for your bank' : 'Payment not completed'}</h1><p class="${pending ? 'sub' : 'bad'}">${pending ? 'We have not heard from your bank yet. This page checks again in a few seconds.' : 'Nothing was charged. You can go back and try again.'}</p><p><a style="color:#c9a227" href="/watch/${g.tournament_id}">Back to the broadcast</a></p>${pending ? '<script>setTimeout(function(){location.reload()},4000)</script>' : ''}`,
    );
  });

  // ---------------------------------------------------------------- organisers (event)
  app.get('/api/tournaments/:id/gifts', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, pid(req), 'direct');
    const { s, e } = await gifts.eventConfig(t);
    return {
      config: e,
      label: s.label,
      button: s.button,
      limits: { min: s.minGiftInr, max: s.maxGiftInr },
      defaults: s.stickers,
      notReady: await gifts.notReady(t.org_id),
      totals: await gifts.totals(t.id),
      example: example(s),
      gifts: (await gifts.forEvent(t.id)).map(giftStaffDto),
      top: await gifts.top(t.id, 10),
    };
  });

  app.patch('/api/tournaments/:id/gifts', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, pid(req), 'manage');
    const body = z.record(z.string(), z.unknown()).parse(req.body);
    const { s, e } = await gifts.eventConfig(t);
    const next = { ...e } as Record<string, unknown>;
    for (const k of ['enabled', 'allowCustom', 'inVideo', 'topSupporters', 'approval'] as const) if (typeof body[k] === 'boolean') next[k] = body[k];
    if (body.button === null || typeof body.button === 'string') next.button = body.button;
    if (body.stickers !== undefined) {
      const st = cleanStickers(body.stickers, []);
      if (!st.length) throw new HttpError(400, 'no_stickers', 'Add at least one sticker with a name and an amount.');
      const bad = st.find((x) => x.amount < s.minGiftInr || x.amount > s.maxGiftInr);
      if (bad) throw new HttpError(400, 'sticker_amount', `Sticker amounts must be between ₹${s.minGiftInr} and ₹${s.maxGiftInr.toLocaleString('en-IN')} (${bad.name}).`);
      next.stickers = st;
    }
    if (body.goal && typeof body.goal === 'object') next.goal = body.goal;
    const clean = eventGifts({ gifts: next }, s);
    if (clean.enabled && !e.enabled) {
      const nr = await gifts.notReady(t.org_id);
      if (nr) throw new HttpError(409, 'gifts_not_ready', nr);
    }
    await repo.setTournamentJson(t.id, 'gifts', clean);
    gifts.eventChanged(t.id);
    return { config: clean };
  });

  app.post('/api/tournaments/:id/gifts/:gid', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, pid(req), 'direct');
    const g = await gifts.byId(pid(req, 'gid'));
    if (!g || g.tournament_id !== t.id) throw new HttpError(404, 'gift_not_found', 'Gift not found.');
    const b = z.object({ approve: z.boolean().optional(), hidden: z.boolean().optional() }).parse(req.body);
    return { gift: giftStaffDto(await gifts.moderate(g, b)) };
  });

  // ---------------------------------------------------------------- clubs (owners)
  const clubView = async (orgId: string) => {
    const s = await gifts.forOrg(orgId);
    return {
      label: s.label,
      terms: { sharePct: s.sharePct, gstPct: s.gstPct, gstMode: s.gstMode, tdsPct: s.tdsPct, feePct: s.feePct, feePaidBy: s.feePaidBy, holdDays: s.holdDays, minPayoutInr: s.minPayoutInr },
      example: example(s),
      payee: payeeDto(await gifts.payee(orgId)),
      agreement: agreementDto(await gifts.agreement(orgId)),
      notReady: await gifts.notReady(orgId),
      summary: await gifts.clubSummary(orgId),
      payouts: (await gifts.payouts({ orgId })).map(payoutDto),
    };
  };

  app.get('/api/orgs/:id/gift-account', { preHandler: user }, async (req) => {
    const orgId = pid(req);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    return clubView(orgId);
  });

  app.put('/api/orgs/:id/gift-account', { preHandler: user }, async (req) => {
    const orgId = pid(req);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    const b = z
      .object({
        legalName: z.string().trim().min(2).max(120),
        pan: z.string().trim().min(10).max(12),
        accountHolder: z.string().trim().min(2).max(120),
        account: z.string().trim().min(6).max(24),
        ifsc: z.string().trim().min(11).max(12),
        gstin: z.string().trim().max(15).nullish(),
        email: z.string().trim().email().max(200),
      })
      .parse(req.body);
    await gifts.savePayee(orgId, b);
    await ctx.mailer.toTeam({ subject: 'Gift payout details to verify', body: [`${(await repo.orgById(orgId))?.name ?? orgId} saved payout details for ${b.legalName}. Verify them in Admin > Money > Gifts.`], kind: 'gift_payee', ref: `${orgId}:${Date.now()}` });
    return clubView(orgId);
  });

  app.post('/api/orgs/:id/gift-account/agreement', { preHandler: user }, async (req) => {
    const orgId = pid(req);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    await gifts.sendAgreement(orgId, userOf(req).email);
    return clubView(orgId);
  });

  app.get('/api/orgs/:id/gifts.csv', { preHandler: user }, async (req, reply) => {
    const orgId = pid(req);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    const rows = await gifts.clubGifts(orgId, 20000);
    return csv(reply, 'gifts', ['Paid at (IST)', 'Event', 'From', 'Message', 'Gift (INR)', 'GST', 'Gateway fee', 'Go Live share', 'TDS', 'Net to you', 'Payable from', 'Status', 'Paid out'],
      rows.map((g) => [ist(g.paid_at), g.event_name, g.sender_name, g.message ?? '', g.amount_inr, g.gst_inr, g.fee_inr, g.share_inr, g.tds_inr, g.net_inr, ist(g.payable_at), g.status, g.payout_id ? 'yes' : 'no']));
  });

  app.get('/api/orgs/:id/gift-payouts/:pid/statement.csv', { preHandler: user }, async (req, reply) => {
    const orgId = pid(req);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    const p = await gifts.payoutById(pid(req, 'pid'));
    if (!p || p.org_id !== orgId) throw new HttpError(404, 'payout_not_found', 'Payout not found.');
    const rows = await gifts.payoutGifts(p.id);
    return csv(reply, `payout-${p.created_at.toISOString().slice(0, 10)}`, ['Paid at (IST)', 'Event', 'From', 'Gift (INR)', 'GST', 'Gateway fee', 'Go Live share', 'TDS', 'Net'],
      [...rows.map((g) => [ist(g.paid_at), g.event_name, g.sender_name, g.amount_inr, g.gst_inr, g.fee_inr, g.share_inr, g.tds_inr, g.net_inr]), ['Total', '', `${p.gift_count} gifts`, p.gross_inr, p.gst_inr, p.fee_inr, p.share_inr, p.tds_inr, p.net_inr], ['Status', p.status, p.utr ? `UTR ${p.utr}` : '', '', '', '', '', '', '']]);
  });

  // ---------------------------------------------------------------- the agreement link
  app.get('/agreement/:token', async (req, reply) => {
    const token = String((req.params as { token: string }).token).slice(0, 80);
    const a = await gifts.agreementByToken(token);
    if (!a || a.revoked_at) return page(reply.status(404), 'Agreement', '<h1>Link not valid</h1><p class="sub">This link was replaced or withdrawn. Ask for a new one from Club &gt; Gifts &amp; payouts.</p>');
    const paras = a.text.split('\n\n').map((p, i) => (i === 0 ? `<h1 style="font-size:19px">${esc(p)}</h1>` : `<p style="font-size:14px">${esc(p)}</p>`)).join('');
    const wide = '<style>.card{max-width:720px!important}input{box-sizing:border-box;width:100%;padding:12px;border-radius:10px;border:1px solid #33393f;background:#0b0e10;color:#fff;font:inherit}label{display:block;margin-top:14px}</style>';
    if (a.signed_at) return page(reply, 'Signed', `${paras}<p class="ok">Signed by ${esc(a.signer_name ?? '')} on ${esc(ist(a.signed_at))} IST.</p><p class="sub">Fingerprint ${esc(a.text_hash)}</p>`, wide);
    if (a.expires_at.getTime() < Date.now()) return page(reply, 'Expired', '<h1>Link expired</h1><p class="sub">Send a new one from Club &gt; Gifts &amp; payouts.</p>');
    return page(
      reply,
      'Sign the payout agreement',
      `${paras}<form id="f"><label>Type your full name to sign<input id="n" autocomplete="name" required minlength="3" maxlength="120"></label><label style="display:flex;gap:10px;align-items:flex-start"><input id="c" type="checkbox" style="width:auto;margin-top:4px" required> <span class="sub">I have read this agreement and agree to it for the Organiser named above. I am authorised to sign for it.</span></label><button type="submit">Sign agreement</button><p class="sub" id="msg"></p></form>
<script>
document.getElementById('f').onsubmit = async function (e) {
  e.preventDefault();
  var m = document.getElementById('msg');
  m.textContent = 'Signing…';
  try {
    var r = await fetch(location.pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('n').value, agree: document.getElementById('c').checked }) });
    var j = await r.json();
    if (!r.ok) throw new Error(j.error && j.error.message);
    location.reload();
  } catch (err) { m.textContent = err.message || 'Could not sign. Try again.'; }
};
</script>`,
      wide,
    );
  });

  app.post('/agreement/:token', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const token = String((req.params as { token: string }).token).slice(0, 80);
    const b = z.object({ name: z.string().max(200), agree: z.literal(true) }).parse(req.body);
    const a = await gifts.sign(token, { name: b.name, ip: req.ip, agent: String(req.headers['user-agent'] ?? '') });
    return { signedAt: a.signed_at };
  });

  // ---------------------------------------------------------------- admin
  app.get('/api/admin/gifts/settings', { preHandler: admin }, async () => {
    const s = await gifts.settings();
    return { settings: s, example: example(s), gatewayOn: payments.enabled };
  });

  app.put('/api/admin/gifts/settings', { preHandler: admin }, async (req) => {
    const s = await gifts.saveSettings(z.record(z.string(), z.unknown()).parse(req.body));
    return { settings: s, example: example(s), gatewayOn: payments.enabled };
  });

  /** Live preview of the split for any amount and settings (the admin form). */
  app.post('/api/admin/gifts/preview', { preHandler: admin }, async (req) => {
    const b = z.object({ amount: z.number().positive(), settings: z.record(z.string(), z.unknown()) }).parse(req.body);
    const { mergeGiftSettings } = await import('../gifts.js');
    return giftSplit(b.amount, mergeGiftSettings(b.settings));
  });

  app.get('/api/admin/gifts/clubs', { preHandler: admin }, async () => {
    const rows = (
      await repo.db.query<{ org_id: string; name: string; payee: boolean; status: string | null; legal_name: string | null; ifsc: string | null; account_last4: string | null; pan_last4: string | null; email: string | null; signed: Date | null; overrides: Record<string, unknown> | null; gross: string | null; payable: string | null }>(
        `SELECT o.id AS org_id, o.name, p.org_id IS NOT NULL AS payee, p.status, p.legal_name, p.ifsc, p.account_last4, p.pan_last4, p.email,
           (SELECT max(signed_at) FROM payout_agreements a WHERE a.org_id = o.id AND a.revoked_at IS NULL) AS signed,
           b.gift_overrides AS overrides,
           (SELECT sum(amount_inr) FROM gifts g WHERE g.org_id = o.id AND g.status = 'paid') AS gross,
           (SELECT sum(net_inr) FROM gifts g WHERE g.org_id = o.id AND g.status = 'paid' AND g.payout_id IS NULL) AS payable
         FROM orgs o LEFT JOIN payee_accounts p ON p.org_id = o.id LEFT JOIN org_billing b ON b.org_id = o.id
         WHERE p.org_id IS NOT NULL OR (b.gift_overrides IS NOT NULL AND b.gift_overrides <> '{}') OR EXISTS (SELECT 1 FROM gifts g WHERE g.org_id = o.id)
         ORDER BY (p.status = 'pending') DESC NULLS LAST, o.name`,
      )
    ).rows;
    return {
      clubs: rows.map((r) => ({
        orgId: r.org_id,
        name: r.name,
        payee: r.payee ? { status: r.status, legalName: r.legal_name, ifsc: r.ifsc, account: `••••${r.account_last4}`, pan: `••••••${r.pan_last4}`, email: r.email } : null,
        signedAt: r.signed?.toISOString() ?? null,
        overrides: r.overrides ?? {},
        gross: Number(r.gross ?? 0),
        payable: Number(r.payable ?? 0),
      })),
      overridable: OVERRIDABLE,
    };
  });

  app.post('/api/admin/gifts/clubs/:id/verify', { preHandler: admin }, async (req) => {
    const b = z.object({ ok: z.boolean(), note: z.string().max(300).nullish() }).parse(req.body);
    const p = await gifts.verifyPayee(pid(req), b.ok, b.note ?? null, userOf(req).email);
    const s = await gifts.settings();
    await ctx.mailer.send({
      to: p.email,
      subject: b.ok ? `${s.label}: payout details verified` : `${s.label}: please check your payout details`,
      body: b.ok
        ? ['Your payout details are verified.', (await gifts.signedAgreement(p.org_id)) ? 'You can switch gifts on for your events.' : 'Next, sign the payout agreement (Club > Gifts & payouts > Send agreement).']
        : [`We could not verify your payout details${b.note ? `: ${b.note}` : '.'}`, 'Correct them in Club > Gifts & payouts and save again.'],
      kind: 'gift_payee_status',
      ref: `${p.org_id}:${Date.now()}`,
      orgId: p.org_id,
    });
    return { payee: payeeDto(p) };
  });

  app.put('/api/admin/gifts/clubs/:id/overrides', { preHandler: admin }, async (req) => {
    const b = z.record(z.string(), z.unknown()).parse(req.body);
    const clean = Object.fromEntries(Object.entries(b).filter(([k, v]) => (OVERRIDABLE as readonly string[]).includes(k) && v !== null && v !== ''));
    await gifts.saveOverrides(pid(req), clean);
    return { overrides: clean };
  });

  app.get('/api/admin/gifts/list', { preHandler: admin }, async () => {
    const rows = (
      await repo.db.query<GiftRow & { org_name: string; event_name: string }>(
        "SELECT g.*, o.name AS org_name, t.name AS event_name FROM gifts g JOIN orgs o ON o.id = g.org_id JOIN tournaments t ON t.id = g.tournament_id WHERE g.status IN ('paid', 'refunded') ORDER BY g.paid_at DESC LIMIT 300",
      )
    ).rows;
    return { gifts: rows.map((g) => ({ ...giftStaffDto(g), org: g.org_name, event: g.event_name, orderId: g.order_id, gst: Number(g.gst_inr), share: Number(g.share_inr), fee: Number(g.fee_inr), tds: Number(g.tds_inr) })) };
  });

  app.post('/api/admin/gifts/:id/refunded', { preHandler: admin }, async (req) => {
    const g = await gifts.byId(pid(req));
    if (!g) throw new HttpError(404, 'gift_not_found', 'Gift not found.');
    return { gift: giftStaffDto(await gifts.markRefunded(g)) };
  });

  app.post('/api/admin/gift-payouts/run', { preHandler: admin }, async (req) => ({ created: (await gifts.runPayouts(userOf(req).email)).map(payoutDto) }));

  app.get('/api/admin/gift-payouts', { preHandler: admin }, async (req) => {
    const q = z.object({ status: z.enum(['due', 'paid', 'cancelled']).optional() }).parse(req.query);
    return { payouts: (await gifts.payouts({ status: q.status })).map(payoutDto) };
  });

  /** A bank upload file of the payouts that are due (full account numbers: admin only). */
  app.get('/api/admin/gift-payouts/bank.csv', { preHandler: admin }, async (_req, reply) => {
    const due = await gifts.payouts({ status: 'due' }, 1000);
    const rows: unknown[][] = [];
    for (const p of due) {
      const payee = await gifts.payee(p.org_id);
      if (!payee) continue;
      const u = gifts.unsealed(payee);
      rows.push([payee.account_holder, u.account, payee.ifsc, Number(p.net_inr).toFixed(2), `GL GIFTS ${p.id.slice(0, 8)}`, payee.email, p.org_name, p.id]);
    }
    void sealer;
    return csv(reply, `gift-payouts-${new Date().toISOString().slice(0, 10)}`, ['Beneficiary name', 'Account number', 'IFSC', 'Amount (INR)', 'Narration', 'Email', 'Club', 'Payout id'], rows);
  });

  app.get('/api/admin/gift-payouts/:id', { preHandler: admin }, async (req) => {
    const p = await gifts.payoutById(pid(req));
    if (!p) throw new HttpError(404, 'payout_not_found', 'Payout not found.');
    return { payout: payoutDto(p), gifts: (await gifts.payoutGifts(p.id)).map((g) => ({ ...giftStaffDto(g), event: g.event_name })) };
  });

  app.post('/api/admin/gift-payouts/:id/paid', { preHandler: admin }, async (req) => {
    const b = z.object({ utr: z.string().trim().min(4).max(40) }).parse(req.body);
    return { payout: payoutDto(await gifts.markPaid(pid(req), b.utr, userOf(req).email)) };
  });

  app.post('/api/admin/gift-payouts/:id/cancel', { preHandler: admin }, async (req) => {
    await gifts.cancelPayout(pid(req));
    return { ok: true };
  });

  void by;
  void base;
}
