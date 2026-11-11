// V9 Club > Gifts & payouts: where gift money goes (bank details, verified by Go Live), the
// payout agreement (emailed, signed from the link), what is held, payable and paid, statements.
import { state, get, put, post, el, stat, table, inr, when, day, toast, guard, download } from './core.js';

export const title = 'Gifts & payouts';

const STEP = { done: '✓', now: '•', todo: '' };

export async function render(view) {
  const id = state.orgId;
  let v = await get(`/api/orgs/${id}/gift-account`);
  const draw = () => {
    const t = v.terms;
    const p = v.payee;
    const a = v.agreement;
    const s1 = p ? (p.status === 'verified' ? 'done' : 'now') : 'now';
    const s2 = a?.state === 'signed' ? 'done' : p ? 'now' : 'todo';
    const s3 = !v.notReady ? 'done' : 'todo';
    const step = (n, st, head, ...kids) => el('li', { class: 'lstep ' + st }, el('span', { class: 'lstep-n', text: STEP[st] || String(n) }), el('div', { class: 'lstep-b' }, el('strong', { text: head }), ...kids));

    const f = (name, label, attrs = {}) => el('div', {}, el('label', { text: label }), el('input', { name, ...attrs }));
    const form = el('form', { class: 'form', onsubmit: guard(async (e) => {
      e.preventDefault();
      const x = Object.fromEntries(new FormData(e.target));
      v = await put(`/api/orgs/${id}/gift-account`, { ...x, gstin: x.gstin || null });
      toast('Saved. Go Live will verify your details, usually within a working day.');
      draw();
    }) },
      f('legalName', 'Legal name (as on PAN)', { required: true, value: p?.legalName ?? '', maxlength: '120' }),
      f('pan', 'PAN', { required: true, placeholder: p ? `Saved ${p.pan}; type again to change` : 'ABCDE1234F', maxlength: '12', style: 'text-transform:uppercase' }),
      f('accountHolder', 'Account holder name', { required: true, value: p?.accountHolder ?? '', maxlength: '120' }),
      f('account', 'Bank account number', { required: true, inputmode: 'numeric', placeholder: p ? `Saved ${p.account}; type again to change` : '', maxlength: '24' }),
      f('ifsc', 'IFSC', { required: true, value: p?.ifsc ?? '', placeholder: 'HDFC0001234', maxlength: '12', style: 'text-transform:uppercase' }),
      f('gstin', 'GSTIN (optional)', { value: p?.gstin ?? '', maxlength: '15', style: 'text-transform:uppercase' }),
      f('email', 'Email for the agreement and statements', { required: true, type: 'email', value: p?.email ?? state.me?.email ?? '' }),
      el('div', {}, el('button', { class: 'btn primary', text: p ? 'Save changes' : 'Save details' })));

    view.replaceChildren(
      el('div', { class: 'grid' }, stat(inr(v.summary.gross), `${v.label} received`), stat(inr(v.summary.held), `On hold (${t.holdDays} days)`), stat(inr(v.summary.payable), 'Ready for next payout'), stat(inr(v.summary.paidOut), 'Paid to your bank')),
      el('div', { class: 'card', style: 'margin-top:14px' },
        el('div', { class: 'row' }, el('strong', { text: `Receive ${v.label} from viewers` }), el('div', { class: 'sp' }), !v.notReady ? el('span', { class: 'pill ok', text: 'Ready' }) : null),
        el('p', { class: 'small muted', style: 'margin:6px 0 0', text: `How a gift is split: ${t.gstMode === 'gift_first' ? `GST ${t.gstPct}% comes out first, then Go Live keeps ${t.sharePct}%` : `Go Live keeps ${t.sharePct}% (GST ${t.gstPct}% included)`}, the payment gateway fee (about ${t.feePct}%) is ${t.feePaidBy === 'organiser' ? 'deducted' : 'paid by Go Live'}, and TDS of ${t.tdsPct}% is deducted in your PAN. For a ₹101 gift you get ${inr(v.example.net)}. Paid to your bank ${t.holdDays} days after each gift, weekly, once you have at least ₹${t.minPayoutInr}.` }),
        el('ol', { class: 'lsteps' },
          step(1, s1, 'Your payout details',
            p ? el('p', { class: 'small' }, `${p.legalName} · ${p.account} · ${p.ifsc} · `, el('span', { class: 'pill ' + (p.status === 'verified' ? 'ok' : p.status === 'rejected' ? 'bad' : 'warn'), text: p.status === 'verified' ? 'Verified' : p.status === 'rejected' ? 'Not accepted' : 'Waiting for Go Live' })) : el('p', { class: 'small muted', text: 'The bank account in your organisation\'s name where gift money is paid.' }),
            p?.status === 'rejected' && p.statusNote ? el('div', { class: 'banner bad', text: p.statusNote }) : null,
            el('details', { open: !p || p.status === 'rejected' || undefined }, el('summary', { class: 'small', text: p ? 'Change details' : 'Add details' }), el('div', { style: 'margin-top:10px' }, form)),
            el('p', { class: 'small muted', text: 'Your PAN and account number are stored encrypted. Changing them needs a new verification and a new agreement.' })),
          step(2, s2, 'Sign the payout agreement',
            a ? el('p', { class: 'small' }, a.state === 'signed' ? `Signed by ${a.signerName} on ${when(a.signedAt)}.` : a.state === 'sent' ? `Sent to ${a.sentTo} on ${when(a.sentAt)}. Open the email and sign from the link (valid until ${day(a.expiresAt)}).` : 'The link expired. Send a new one.') : el('p', { class: 'small muted', text: 'We email the agreement to your payout email. Open the link, read it, type your name and confirm.' }),
            a?.state !== 'signed' ? el('div', {}, el('button', { class: 'btn' + (p ? ' primary' : ''), disabled: !p || undefined, onclick: guard(async () => { v = await post(`/api/orgs/${id}/gift-account/agreement`); toast(`Agreement sent to ${v.agreement.sentTo}`); draw(); }), text: a ? 'Send a new link' : 'Email me the agreement' })) : el('p', { class: 'small muted', text: `Fingerprint ${a.fingerprint}… · version ${a.version}` })),
          step(3, s3, 'Switch gifts on for your events',
            el('p', { class: 'small ' + (v.notReady ? 'muted' : ''), text: v.notReady ? v.notReady : 'Open an event > Gifts and switch it on. Pick your stickers and amounts there.' })))),
      el('div', { class: 'row', style: 'margin-top:18px' }, el('h2', { style: 'margin:0', text: 'Payouts' }), el('div', { class: 'sp' }),
        el('button', { class: 'btn small', onclick: guard(() => download(`/api/orgs/${id}/gifts.csv`, 'gifts.csv')), text: 'Download every gift (CSV)' })),
      table(['Created', { t: 'Gifts', n: true }, { t: 'Total', n: true }, { t: 'GST', n: true }, { t: 'Fees', n: true }, { t: 'Go Live', n: true }, { t: 'TDS', n: true }, { t: 'You get', n: true }, 'Status', ''], v.payouts.map((x) => [
        day(x.createdAt), String(x.gifts), inr(x.gross), inr(x.gst), inr(x.fee), inr(x.share), inr(x.tds), inr(x.net),
        el('span', { class: 'pill ' + (x.status === 'paid' ? 'ok' : x.status === 'due' ? 'warn' : 'bad'), text: x.status === 'paid' ? `Paid ${day(x.paidAt)}${x.utr ? ' · ' + x.utr : ''}` : x.status === 'due' ? 'Being paid' : 'Cancelled' }),
        el('button', { class: 'btn small ghost', onclick: guard(() => download(`/api/orgs/${id}/gift-payouts/${x.id}/statement.csv`, `statement-${x.createdAt.slice(0, 10)}.csv`)), text: 'Statement' })]), { empty: 'No payouts yet.' }));
  };
  draw();
}
