import { state, get, post, put, el, stat, table, num, inr, when, day, dialog, toast, guard, go } from './core.js';
import { TX_LABELS } from './labels.js';

export const title = 'Wallet';

export async function render(view) {
  const id = state.orgId;
  const org = state.orgs.find((o) => o.id === id);
  const owner = org?.role === 'owner' || state.me.platformAdmin;
  const [b, inv] = await Promise.all([get(`/api/orgs/${id}/billing`), owner ? get(`/api/orgs/${id}/invoices`).catch(() => ({ invoices: [] })) : { invoices: [] }]);
  const buy = (pack) => guard(async () => {
    const v = await dialog({ title: `Buy ${num(pack.credits)} credits`, text: `${pack.label}: ${inr(pack.priceInr)}. You pay on Cashfree (UPI, cards, net banking).`, ok: 'Continue to payment', fields: [
      { name: 'phone', label: 'Mobile number for the receipt', value: b.details?.phone ?? '', required: !b.details?.phone, placeholder: '98123 45678' },
      { name: 'coupon', label: 'Coupon code (optional)' }] });
    if (!v) return;
    if (v.coupon) {
      const q = await post(`/api/orgs/${id}/billing/coupon`, { packId: pack.id, coupon: v.coupon });
      toast(`Coupon applied: pay ${inr(q.amountInr)}${q.bonusCredits ? `, +${num(q.bonusCredits)} bonus credits` : ''}`);
    }
    const r = await post(`/api/orgs/${id}/billing/checkout`, { packId: pack.id, phone: v.phone || undefined, coupon: v.coupon || null });
    location.href = r.checkoutUrl;
  });
  const p = b.pricing;
  view.append(
    b.suspended ? el('div', { class: 'banner bad', text: `Your club is suspended: ${b.suspendedReason ?? ''}. Contact Go Live support.` }) : null,
    el('div', { class: 'grid' }, stat(num(b.balance), 'Credits'), stat(`${p.freeCameras} cameras · ${p.freeMinutes} min`, 'Free with every event'), stat(`${num(p.minutePrice)} / min`, 'Live minutes after that'), stat(`${num(p.cameraPrice)}`, 'Each extra camera')),
    el('h2', { text: 'Buy credits' }),
    !b.enabled ? el('p', { class: 'muted', text: 'Billing is off on this server: everything is free.' })
    : !b.paymentsEnabled ? el('div', { class: 'banner warn', text: 'Online payment is not available yet. Contact Go Live support to add credits.' })
    : el('div', { class: 'grid' }, b.packs.map((k) => el('div', { class: 'card' }, el('div', { class: 'small muted', text: k.label }), el('div', { style: 'font-size:24px;font-weight:800', text: inr(k.priceInr) }),
        el('div', { class: 'small', text: `${num(k.credits)} credits` }), el('button', { class: 'btn primary small', style: 'margin-top:10px', onclick: buy(k), text: 'Buy' })))),
    el('h2', { text: 'History' }),
    table(['When', 'What', 'Event', { t: 'Qty', n: true }, { t: 'Credits', n: true }, 'Note'], b.transactions.map((t) => [when(t.at), TX_LABELS[t.kind] ?? t.kind, t.tournamentName ?? '–', t.quantity ?? '',
      el('span', { style: `color:${t.credits < 0 ? 'var(--bad)' : '#7ee0a6'}`, text: num(t.credits) }), t.note ?? '']), { empty: 'No activity yet.' }),
    owner ? el('div', {},
      el('h2', { text: 'Invoices' }),
      table(['Number', 'Type', 'Date', { t: 'Total', n: true }, ''], inv.invoices.map((i) => [el('span', { class: 'mono', text: i.number }), i.kind === 'invoice' ? 'Tax invoice' : 'Credit note', day(i.issuedAt), inr(i.totalInr),
        el('a', { class: 'btn small', href: `/invoices/${i.id}?token=${encodeURIComponent(state.token)}`, target: '_blank', text: 'Open / PDF' })]), { empty: 'No invoices yet.' }),
      el('h2', { text: 'Billing details' }),
      el('form', { class: 'card form', onsubmit: guard(async (e) => {
        e.preventDefault(); const x = e.target.elements;
        await put(`/api/orgs/${id}/billing/details`, { name: x.name.value.trim() || null, email: x.email.value.trim() || null, phone: x.phone.value.trim() || null, gstin: x.gstin.value.trim() || null });
        toast('Billing details saved');
      }) },
        ['name:Name on invoices', 'email:Billing email', 'phone:Mobile', 'gstin:GSTIN (optional)'].map((f) => { const [k, l] = f.split(':'); return el('div', {}, el('label', { text: l }), el('input', { name: k, value: b.details?.[k] ?? '' })); }),
        el('div', {}, el('button', { class: 'btn primary', text: 'Save' })))) : null);
}
