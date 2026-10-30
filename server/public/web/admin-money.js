import { state, get, post, put, patch, del, el, stat, table, inr, num, when, day, dialog, confirmBox, toast, guard, go, download } from './core.js';
import { PRICING_LABELS, TX_LABELS } from './labels.js';

export const title = 'Money';

const TABS = [['transactions', 'Transactions'], ['refunds', 'Refunds'], ['ledger', 'Wallets & ledger'], ['coupons', 'Coupons'], ['invoices', 'GST invoices'], ['pricing', 'Pricing & packs'], ['gateway', 'Payment gateway'], ['webhooks', 'Gateway log']];
const pill = (s) => el('span', { class: 'pill ' + ({ paid: 'ok', success: 'ok', failed: 'bad', cancelled: 'bad', expired: 'bad' }[s] ?? 'warn'), text: s });
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

export async function render(view, { tab = 'transactions' }) {
  view.append(el('nav', { class: 'tabs' }, TABS.map(([k, t]) => el('a', { href: '/web/admin/money/' + k, class: k === tab ? 'on' : null, onclick: (e) => { e.preventDefault(); go('/web/admin/money/' + k); }, text: t }))));
  const body = el('div');
  view.append(body);
  await ({ transactions, refunds, ledger, coupons, invoices, pricing, gateway, webhooks }[tab] ?? transactions)(body);
}

// ------------------------------------------------------------------ transactions
async function paymentDialog(id, reload) {
  const d = await get('/api/admin/payments/' + id);
  const p = d.payment;
  const left = Math.round((p.amountInr - p.refundedInr) * 100) / 100;
  const box = el('dialog', { style: 'width:min(720px,94vw)' },
    el('h3', { text: `Payment ${p.orderId}` }),
    el('div', { class: 'grid' }, stat(inr(p.amountInr), 'Paid'), stat(num(p.credits + p.bonusCredits), 'Credits given'), stat(inr(p.refundedInr), 'Refunded'), stat(num(d.balance), 'Club balance now')),
    el('p', { class: 'small muted' }, `${p.orgName} · ${p.status} · created ${when(p.createdAt)}${p.paidAt ? ' · paid ' + when(p.paidAt) : ''}${p.couponCode ? ` · coupon ${p.couponCode} (−${inr(p.discountInr)})` : ''}${p.invoiceNumber ? ' · invoice ' + p.invoiceNumber : ''}`),
    el('h2', { text: 'Refunds' }),
    table(['When', { t: 'Amount', n: true }, { t: 'Credits back', n: true }, 'Status', 'Note', ''], d.refunds.map((r) => [when(r.createdAt), inr(r.amountInr), num(r.credits), pill(r.status), r.note ?? '',
      r.status === 'pending' ? el('button', { class: 'btn small', onclick: guard(async () => { await post(`/api/admin/refunds/${r.id}/refresh`); box.close(); paymentDialog(id, reload); }), text: 'Check status' }) : (r.error ?? '')]), { empty: 'No refunds.' }),
    el('h2', { text: 'Gateway messages' }),
    table(['When', 'Type', 'Signed', 'Result'], d.events.map((e) => [when(e.at), e.type ?? '–', e.signatureOk ? 'Yes' : 'No', e.result ?? '']), { empty: 'No webhooks for this order.' }),
    el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px' },
      p.status === 'created' ? el('button', { class: 'btn', onclick: guard(async () => { await post(`/api/admin/payments/${id}/recheck`); toast('Asked Cashfree again'); box.close(); reload(); }), text: 'Ask Cashfree again' }) : null,
      p.status === 'paid' && left > 0 ? el('button', { class: 'btn danger', onclick: guard(async () => {
        const v = await dialog({ title: 'Refund', text: `Up to ${inr(left)} can be refunded. Credits you enter are taken from the club's wallet now and returned if the refund fails.`, ok: 'Refund', danger: true, fields: [
          { name: 'amountInr', label: 'Amount to refund (₹)', type: 'number', step: '0.01', value: left, required: true },
          { name: 'credits', label: 'Credits to take back', type: 'number', step: '0.01', value: Math.min(d.balance, Math.round((p.credits + p.bonusCredits) * (left / p.amountInr))), required: true },
          { name: 'note', label: 'Reason', required: true, placeholder: 'Event cancelled' }] });
        if (!v) return;
        const r = await post(`/api/admin/payments/${id}/refund`, v);
        toast(r.refund.status === 'failed' ? `Refund failed: ${r.refund.error}` : 'Refund sent to Cashfree', r.refund.status === 'failed');
        box.close(); reload();
      }), text: 'Refund' }) : null,
      el('button', { class: 'btn primary', onclick: () => box.close(), text: 'Close' })));
  box.addEventListener('close', () => box.remove());
  document.body.append(box); box.showModal();
}

async function transactions(body) {
  const f = { status: el('select', {}, [['', 'Any status'], ['paid', 'Paid'], ['created', 'Started, not paid'], ['failed', 'Failed'], ['expired', 'Expired']].map(([v, t]) => el('option', { value: v, text: t }))),
    q: el('input', { placeholder: 'Order id, club or coupon' }), from: el('input', { type: 'date' }), to: el('input', { type: 'date' }) };
  const out = el('div');
  const params = () => qs({ status: f.status.value, q: f.q.value.trim(), from: f.from.value, to: f.to.value });
  const load = async () => {
    const { payments, totals } = await get('/api/admin/transactions?' + params());
    out.replaceChildren(
      el('div', { class: 'grid' }, stat(inr(totals.paidInr), 'Paid'), stat(totals.paid, 'Paid payments'), stat(inr(totals.refundedInr), 'Refunded'), stat(inr(totals.discountInr), 'Coupon discounts'), stat(num(totals.credits), 'Credits sold')),
      el('div', { style: 'height:12px' }),
      table(['When', 'Club', 'Order', { t: 'Amount', n: true }, { t: 'Credits', n: true }, 'Coupon', { t: 'Refunded', n: true }, 'Status', 'Invoice'], payments.map((p) => [
        when(p.createdAt), p.orgName, el('span', { class: 'mono small', text: p.orderId }), inr(p.amountInr), num(p.credits + p.bonusCredits), p.couponCode ?? '–',
        p.refundedInr ? inr(p.refundedInr) : '–', pill(p.status),
        p.invoiceId ? el('a', { href: '/admin/invoices/' + p.invoiceId + '?token=' + encodeURIComponent(state.token), target: '_blank', onclick: (e) => e.stopPropagation(), text: p.invoiceNumber }) : '–']),
      { onclick: (i) => paymentDialog(payments[i].id, load).catch((e) => toast(e.message, true)), empty: 'No payments match.' }));
  };
  for (const i of Object.values(f)) i.onchange = load;
  let t; f.q.oninput = () => { clearTimeout(t); t = setTimeout(load, 300); };
  body.append(el('div', { class: 'form', style: 'margin-bottom:12px' },
    el('div', {}, el('label', { text: 'Status' }), f.status), el('div', {}, el('label', { text: 'Search' }), f.q), el('div', {}, el('label', { text: 'From' }), f.from), el('div', {}, el('label', { text: 'To' }), f.to),
    el('div', {}, el('button', { class: 'btn', onclick: guard(() => download('/api/admin/transactions.csv?' + params(), 'payments.csv')), text: 'Download CSV' }))), out);
  await load();
}

// ------------------------------------------------------------------ refunds
async function refunds(body) {
  const { refunds } = await get('/api/admin/refunds');
  body.append(el('p', { class: 'muted', text: 'To refund, open a payment under Transactions. Refunds take a few days to reach the payer; pending ones update when Cashfree tells us.' }),
    table(['When', 'Club', 'Order', { t: 'Amount', n: true }, { t: 'Credits taken', n: true }, 'Status', 'Note', 'By'], refunds.map((r) => [
      when(r.createdAt), r.orgName, el('span', { class: 'mono small', text: r.orderId }), inr(r.amountInr), num(r.credits), pill(r.status), r.note ?? '', el('span', { class: 'small muted', text: r.by ?? '' })]),
    { onclick: (i) => paymentDialog(refunds[i].paymentId, () => go('/web/admin/money/refunds')), empty: 'No refunds yet.' }));
}

// ------------------------------------------------------------------ ledger
async function ledger(body) {
  const f = { kind: el('select', {}, [['', 'Everything'], ...Object.entries(TX_LABELS)].map(([v, t]) => el('option', { value: v, text: t }))), from: el('input', { type: 'date' }), to: el('input', { type: 'date' }) };
  const out = el('div');
  const params = () => qs({ kind: f.kind.value, from: f.from.value, to: f.to.value });
  const load = async () => {
    const l = await get('/api/admin/ledger?' + params());
    out.replaceChildren(
      el('div', { class: 'grid' }, stat(num(l.creditsHeldByClubs), 'Credits held by clubs now'), ...l.totalsByKind.map((k) => stat(num(k.credits), TX_LABELS[k.kind] ?? k.kind))),
      el('div', { style: 'height:12px' }),
      table(['When', 'Club', 'What', 'Event', { t: 'Qty', n: true }, { t: 'Credits', n: true }, 'Note', 'By'], l.entries.map((t) => [
        when(t.at), el('a', { href: '/web/admin/clubs/' + t.orgId, onclick: (e) => { e.preventDefault(); go('/web/admin/clubs/' + t.orgId); }, text: t.orgName }), TX_LABELS[t.kind] ?? t.kind, t.tournamentName ?? '–', t.quantity ?? '',
        el('span', { style: `color:${t.credits < 0 ? 'var(--bad)' : '#7ee0a6'}`, text: num(t.credits) }), t.note ?? '', el('span', { class: 'small muted', text: t.by ?? '' })]), { empty: 'No wallet activity.' }));
  };
  for (const i of Object.values(f)) i.onchange = load;
  body.append(el('p', { class: 'muted', text: 'Every credit movement in every club. To add or deduct credits for a club, open it under Clubs.' }),
    el('div', { class: 'form', style: 'margin-bottom:12px' }, el('div', {}, el('label', { text: 'Type' }), f.kind), el('div', {}, el('label', { text: 'From' }), f.from), el('div', {}, el('label', { text: 'To' }), f.to),
      el('div', {}, el('button', { class: 'btn', onclick: guard(() => download('/api/admin/ledger.csv?' + params(), 'wallet-ledger.csv')), text: 'Download CSV' }))), out);
  await load();
}

// ------------------------------------------------------------------ coupons
async function coupons(body) {
  const { coupons } = await get('/api/admin/coupons');
  const reload = () => go('/web/admin/money/coupons');
  const local = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
  body.append(
    el('div', { class: 'row', style: 'margin-bottom:12px' }, el('div', { class: 'sp' }), el('button', { class: 'btn primary', onclick: guard(async () => {
      const v = await dialog({ title: 'New coupon', ok: 'Create', fields: [
        { name: 'code', label: 'Code (what clubs type)', required: true, placeholder: 'LAUNCH20' },
        { name: 'kind', label: 'Type', type: 'select', value: 'percent_off', options: [{ value: 'percent_off', label: '% off the pack price' }, { value: 'bonus_credits', label: 'Bonus credits on top' }] },
        { name: 'value', label: 'Value (% or credits)', type: 'number', step: 'any', required: true },
        { name: 'description', label: 'Description (shown to clubs)' },
        { name: 'maxUses', label: 'Total uses allowed (empty = unlimited)', type: 'number' },
        { name: 'minInr', label: 'Smallest pack price it works on (₹, optional)', type: 'number' },
        { name: 'validTo', label: 'Valid until (optional)', type: 'date' },
        { name: 'oncePerClub', label: 'Once per club', type: 'checkbox', value: true }] });
      if (!v) return;
      await post('/api/admin/coupons', { ...v, description: v.description || null, validTo: v.validTo ? new Date(v.validTo + 'T23:59:59+05:30').toISOString() : null });
      toast('Coupon created'); reload();
    }), text: 'New coupon' })),
    table(['Code', 'Offer', 'Description', { t: 'Used', n: true }, 'Limits', 'Valid until', 'Status', ''], coupons.map((c) => [
      el('strong', { class: 'mono', text: c.code }), c.kind === 'percent_off' ? `${c.value}% off` : `+${num(c.value)} credits`, c.description ?? '–', c.uses,
      [c.maxUses ? `${c.maxUses} uses` : 'Unlimited', c.oncePerClub ? 'once per club' : null, c.minInr ? `packs ≥ ${inr(c.minInr)}` : null].filter(Boolean).join(' · '),
      c.validTo ? day(c.validTo) : '–', el('span', { class: 'pill ' + (c.active ? 'ok' : ''), text: c.active ? 'Active' : 'Off' }),
      el('span', { class: 'row' },
        el('button', { class: 'btn small', onclick: guard(async () => { await patch('/api/admin/coupons/' + c.code, { active: !c.active }); reload(); }), text: c.active ? 'Turn off' : 'Turn on' }),
        el('button', { class: 'btn small', onclick: guard(async () => {
          const v = await dialog({ title: 'Edit ' + c.code, fields: [{ name: 'description', label: 'Description', value: c.description ?? '' }, { name: 'maxUses', label: 'Total uses allowed (empty = unlimited)', type: 'number', value: c.maxUses ?? '' }, { name: 'validTo', label: 'Valid until', type: 'date', value: local(c.validTo) }] });
          if (!v) return;
          await patch('/api/admin/coupons/' + c.code, { description: v.description || null, maxUses: v.maxUses, validTo: v.validTo ? new Date(v.validTo + 'T23:59:59+05:30').toISOString() : null }); reload();
        }), text: 'Edit' }))]), { empty: 'No coupons yet.' }));
}

// ------------------------------------------------------------------ invoices
async function invoices(body) {
  const s = await get('/api/admin/invoice-settings');
  const f = (name, label, value, attrs = {}) => el('div', {}, el('label', { text: label }), el(attrs.textarea ? 'textarea' : 'input', { name, value: value ?? '', rows: 2, ...attrs }));
  const on = el('input', { type: 'checkbox', name: 'enabled' }); on.checked = s.enabled;
  const inc = el('input', { type: 'checkbox', name: 'pricesIncludeGst' }); inc.checked = s.pricesIncludeGst;
  const form = el('form', { class: 'card', onsubmit: guard(async (e) => {
    e.preventDefault();
    const x = e.target.elements;
    await put('/api/admin/invoice-settings', { enabled: on.checked, legalName: x.legalName.value.trim(), address: x.address.value.trim(), gstin: x.gstin.value.trim(), pan: x.pan.value.trim(),
      stateCode: x.stateCode.value.trim(), sac: x.sac.value.trim(), gstRate: Number(x.gstRate.value), pricesIncludeGst: inc.checked, prefix: x.prefix.value.trim().toUpperCase(), email: x.email.value.trim() });
    toast('Invoice settings saved'); go('/web/admin/money/invoices');
  }) },
    el('div', { class: 'form' }, f('legalName', 'Legal name', s.legalName), f('gstin', 'Your GSTIN', s.gstin), f('pan', 'PAN', s.pan), f('email', 'Billing email', s.email),
      f('stateCode', 'State code (2 digits, e.g. 06 Haryana)', s.stateCode), f('sac', 'SAC code', s.sac), f('gstRate', 'GST rate %', s.gstRate, { type: 'number', step: 'any' }), f('prefix', 'Invoice number prefix', s.prefix)),
    el('div', { style: 'margin-top:12px' }, f('address', 'Registered address', s.address, { textarea: true })),
    el('div', { class: 'row', style: 'margin-top:12px' }, el('label', { class: 'check' }, inc, 'Pack prices already include GST'), el('label', { class: 'check' }, on, 'Issue invoices automatically'), el('div', { class: 'sp' }), el('button', { class: 'btn primary', text: 'Save' })));
  const list = (await get('/api/admin/invoices')).invoices;
  body.append(
    el('p', { class: 'muted', text: 'An invoice is issued for every paid credit purchase, and a credit note for every successful refund. Numbers run per financial year (April–March). Check the SAC code and rate with your accountant.' }),
    form,
    el('div', { class: 'row', style: 'margin:16px 0 8px' }, el('h2', { style: 'margin:0', text: 'Issued' }), el('div', { class: 'sp' }),
      el('button', { class: 'btn', onclick: guard(async () => { const r = await post('/api/admin/invoices/backfill'); toast(`${r.created} invoice${r.created === 1 ? '' : 's'} issued for earlier payments`); go('/web/admin/money/invoices'); }), text: 'Issue for earlier payments' }),
      el('button', { class: 'btn', onclick: guard(() => download('/api/admin/invoices.csv', 'gst-register.csv')), text: 'GST register (CSV)' })),
    table(['Number', 'Type', 'Date', 'Club', 'Buyer GSTIN', { t: 'Taxable', n: true }, { t: 'GST', n: true }, { t: 'Total', n: true }, ''], list.map((i) => [
      el('span', { class: 'mono', text: i.number }), i.kind === 'invoice' ? 'Invoice' : 'Credit note', day(i.issuedAt), i.orgName, i.buyer.gstin ?? '–', inr(i.taxableInr), inr(i.cgstInr + i.sgstInr + i.igstInr), inr(i.totalInr),
      el('a', { class: 'btn small', href: '/admin/invoices/' + i.id + '?token=' + encodeURIComponent(state.token), target: '_blank', text: 'Open' })]), { empty: 'No invoices yet.' }));
}

// ------------------------------------------------------------------ pricing & packs
async function pricing(body) {
  const s = await get('/api/admin/settings');
  const pf = el('form', { class: 'card form', onsubmit: guard(async (e) => {
    e.preventDefault();
    const pricing = Object.fromEntries(Object.keys(PRICING_LABELS).map((k) => [k, Number(e.target.elements[k].value)]));
    await put('/api/admin/settings', { pricing }); toast('Prices saved');
  }) }, Object.entries(PRICING_LABELS).map(([k, label]) => el('div', {}, el('label', { text: label }), el('input', { name: k, type: 'number', step: 'any', min: 0, value: s.pricing[k] ?? '' }))),
    el('div', {}, el('button', { class: 'btn primary', text: 'Save prices' })));
  let packs = s.packs.map((p) => ({ ...p }));
  const packBox = el('div');
  const drawPacks = () => packBox.replaceChildren(
    table(['Id', 'Label', { t: 'Price (₹)', n: true }, { t: 'Credits', n: true }, ''], packs.map((p, i) => [
      el('input', { value: p.id, oninput: (e) => (p.id = e.target.value.trim()) }), el('input', { value: p.label, oninput: (e) => (p.label = e.target.value) }),
      el('input', { type: 'number', value: p.priceInr, oninput: (e) => (p.priceInr = Number(e.target.value)) }), el('input', { type: 'number', value: p.credits, oninput: (e) => (p.credits = Number(e.target.value)) }),
      el('button', { class: 'btn small danger', onclick: () => { packs.splice(i, 1); drawPacks(); }, text: 'Remove' })])),
    el('div', { class: 'row', style: 'margin-top:8px' },
      el('button', { class: 'btn small', onclick: () => { packs.push({ id: 'p' + (packs.length + 1), label: 'New pack', priceInr: 1000, credits: 1000 }); drawPacks(); }, text: 'Add pack' }),
      el('button', { class: 'btn primary small', onclick: guard(async () => { await put('/api/admin/settings', { packs }); toast('Packs saved'); }), text: 'Save packs' })));
  drawPacks();
  body.append(el('h2', { text: 'Platform prices (credits)' }), el('p', { class: 'small muted', text: 'One credit is about ₹1 when bought in the base pack. Per-club prices are set on the club page.' }), pf,
    el('h2', { text: 'Credit packs' }), packBox);
}

// ------------------------------------------------------------------ gateway
async function gateway(body) {
  const g = await get('/api/admin/gateway');
  const id = el('input', { name: 'clientId', value: g.clientId ?? '', placeholder: 'Cashfree App ID' });
  const secret = el('input', { name: 'clientSecret', type: 'password', placeholder: g.secret ? `Saved (${g.secret}); leave empty to keep` : 'Cashfree Secret Key' });
  const env = el('select', {}, [['sandbox', 'Sandbox (testing)'], ['production', 'Production (real money)']].map(([v, t]) => el('option', { value: v, selected: v === g.env || undefined, text: t })));
  const on = el('input', { type: 'checkbox' }); on.checked = g.source === 'none' ? true : g.enabled || !g.clientId;
  const val = () => ({ clientId: id.value.trim(), clientSecret: secret.value.trim() || undefined, env: env.value, enabled: on.checked });
  body.append(
    !g.billingEnabled ? el('div', { class: 'banner warn', text: 'Billing is switched off on this server (BILLING_ENABLED), so payments stay off whatever is set here.' }) : null,
    el('div', { class: 'grid' }, stat(g.enabled ? 'On' : 'Off', 'Online payments'), stat(g.env === 'production' ? 'Production' : 'Sandbox', 'Mode'),
      stat({ admin: 'This panel', 'server config': 'Server config', none: 'Not set' }[g.source], 'Keys from'), stat(g.savedAt ? day(g.savedAt) : '–', 'Last saved')),
    el('h2', { text: 'Cashfree keys' }),
    el('div', { class: 'card' },
      el('div', { class: 'form' }, el('div', {}, el('label', { text: 'App ID (client id)' }), id), el('div', {}, el('label', { text: 'Secret key' }), secret), el('div', {}, el('label', { text: 'Mode' }), env)),
      el('label', { class: 'check', style: 'margin-top:12px' }, on, 'Accept payments'),
      el('p', { class: 'small muted', text: 'Keys are tested with Cashfree before they are saved, stored encrypted, and never shown again in full or written to the audit log.' }),
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: guard(async () => { const r = await post('/api/admin/gateway/test', val()); toast(r.message, !r.ok); }), text: 'Test connection' }),
        el('button', { class: 'btn primary', onclick: guard(async () => { const r = await put('/api/admin/gateway', val()); toast(r.test.message); go('/web/admin/money/gateway'); }), text: 'Save' }),
        g.source === 'admin' ? el('button', { class: 'btn danger', onclick: guard(async () => { if (!(await confirmBox('Remove saved keys?', 'Payments fall back to the keys in the server config, if any.', 'Remove'))) return; await del('/api/admin/gateway'); go('/web/admin/money/gateway'); }), text: 'Remove saved keys' }) : null)),
    el('h2', { text: 'Set up in the Cashfree dashboard' }),
    el('div', { class: 'card' },
      el('p', { class: 'small', text: 'Add this webhook URL (Developers > Webhooks), for payment and refund events:' }),
      el('div', { class: 'mono card', style: 'user-select:all', text: g.webhookUrl }),
      !g.httpsOk ? el('div', { class: 'banner warn small', text: 'Your PUBLIC_BASE_URL is not https, so Cashfree cannot send webhooks; payments are still confirmed when the payer returns.' }) : null,
      el('p', { class: 'small muted', text: `Payers return to ${g.returnUrlExample}. Whitelist your domain in Cashfree before going to production.` })));
}

// ------------------------------------------------------------------ webhooks
async function webhooks(body) {
  const { events } = await get('/api/admin/payment-events');
  body.append(el('p', { class: 'muted', text: 'Every message Cashfree sent us, newest first. Unsigned or forged messages are rejected and shown here too.' }),
    table(['When', 'Type', 'Order', 'Signed', 'Result', ''], events.map((e) => [when(e.at), e.type ?? '–', el('span', { class: 'mono small', text: e.orderId ?? '–' }),
      el('span', { class: 'pill ' + (e.signatureOk ? 'ok' : 'bad'), text: e.signatureOk ? 'Yes' : 'No' }), e.result ?? '',
      el('details', { class: 'json' }, el('summary', { text: 'Body' }), el('pre', { text: JSON.stringify(e.body, null, 2) }))]), { empty: 'No webhooks received yet.' }));
}
