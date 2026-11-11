// V9 Admin > Gifts & payouts: every gift setting (name, share, GST method, TDS, gateway fee,
// hold, fraud limits, payer phone, default stickers, blocked words) with a live split preview;
// clubs (verify payout details, per-club overrides); payout runs (bank file, UTR); all gifts.
import { get, put, post, el, stat, table, inr, when, day, dialog, confirmBox, toast, guard, go, download } from './core.js';

export const title = 'Gifts & payouts';

const TABS = [['settings', 'Settings'], ['clubs', 'Clubs & verification'], ['payouts', 'Payouts'], ['gifts', 'All gifts']];
const OV_LABELS = { enabled: 'Gifts on (true/false)', sharePct: 'Go Live share %', minGiftInr: 'Smallest gift ₹', maxGiftInr: 'Largest gift ₹', perDeviceDailyInr: 'Per phone per day ₹', clubDailyInr: 'Per club per day ₹' };

export async function render(view, { tab = 'settings' }) {
  view.append(el('nav', { class: 'tabs' }, TABS.map(([k, t]) => el('a', { href: '/web/admin/gifts/' + k, class: k === tab ? 'on' : null, onclick: (e) => { e.preventDefault(); go('/web/admin/gifts/' + k); }, text: t }))));
  const body = el('div');
  view.append(body);
  await ({ settings, clubs, payouts, gifts }[tab] ?? settings)(body);
}

// ------------------------------------------------------------------ settings
async function settings(body) {
  const d = await get('/api/admin/gifts/settings');
  const s = structuredClone(d.settings);
  const preview = el('div', { class: 'card' });
  const amount = el('input', { type: 'number', min: '1', value: '101', style: 'width:120px' });
  let t = null;
  const refresh = () => { clearTimeout(t); t = setTimeout(guard(async () => {
    const x = await post('/api/admin/gifts/preview', { amount: Number(amount.value) || 101, settings: s });
    preview.replaceChildren(
      el('div', { class: 'row' }, el('strong', { text: 'Split preview for a gift of ₹' }), amount),
      table(['Line', { t: 'Amount', n: true }], [
        ['Viewer pays', inr(x.gross)],
        [`GST ${x.gstPct}% (${x.mode === 'gift_first' ? 'taken out of the gift first' : 'inside Go Live share'})`, inr(x.gst)],
        [`Go Live share ${x.sharePct}% ${x.mode === 'gift_first' ? '(of the amount after GST)' : '(of the gift)'}`, inr(x.share)],
        [`Gateway fee ${x.feePct}% (paid by ${x.feePaidBy === 'organiser' ? 'organiser' : 'Go Live'})`, inr(x.fee)],
        [`TDS ${x.tdsPct}%`, inr(x.tds)],
        [el('strong', { text: 'Organiser receives' }), el('strong', { text: inr(x.net) })],
      ]));
  }), 250); };
  amount.addEventListener('input', refresh);
  const field = (k, label, type = 'number', extra = {}) => {
    let input;
    if (type === 'select') input = el('select', { onchange: (e) => { s[k] = e.target.value; refresh(); } }, extra.options.map(([v, l]) => el('option', { value: v, selected: s[k] === v || undefined, text: l })));
    else if (type === 'check') { input = el('input', { type: 'checkbox', onchange: (e) => { s[k] = e.target.checked; refresh(); } }); input.checked = Boolean(s[k]); return el('label', { class: 'check' }, input, label); }
    else input = el('input', { type, step: 'any', value: s[k], ...extra, oninput: (e) => { s[k] = type === 'number' ? Number(e.target.value) : e.target.value; refresh(); } });
    return el('div', {}, el('label', { text: label }), input);
  };
  let stickers = s.stickers.map((x) => ({ ...x }));
  const stBox = el('div');
  const drawSt = () => { s.stickers = stickers; stBox.replaceChildren(table(['', 'Name', { t: '₹', n: true }, ''], stickers.map((x, i) => [
    el('input', { value: x.emoji, maxlength: '4', style: 'width:56px;text-align:center;font-size:20px', oninput: (e) => (x.emoji = e.target.value) }),
    el('input', { value: x.name, maxlength: '24', oninput: (e) => (x.name = e.target.value) }),
    el('input', { type: 'number', value: x.amount, style: 'width:100px', oninput: (e) => (x.amount = Number(e.target.value)) }),
    el('button', { class: 'btn small ghost', onclick: () => { stickers.splice(i, 1); drawSt(); }, text: 'Remove' })])),
    el('button', { class: 'btn small', style: 'margin-top:8px', onclick: () => { stickers.push({ emoji: '🎁', name: 'New', amount: 51 }); drawSt(); }, text: 'Add sticker' })); };
  drawSt();
  const words = el('textarea', { rows: 3, placeholder: 'One word or phrase per line', value: s.blockedWords.join('\n'), oninput: (e) => (s.blockedWords = e.target.value.split('\n').map((w) => w.trim()).filter(Boolean)) });
  body.append(
    !d.gatewayOn ? el('div', { class: 'banner warn', text: 'The payment gateway is off, so viewers cannot pay for gifts yet (Admin > Money > Payment gateway).' }) : null,
    el('h2', { text: 'Name and switch' }),
    el('div', { class: 'card form' }, field('enabled', 'Gifts on for the platform', 'check'), field('label', 'Feature name (viewers and clubs see it)', 'text', { maxlength: '30' }), field('button', 'Button on the watch page', 'text', { maxlength: '20' })),
    el('h2', { text: 'Money and tax' }),
    el('div', { class: 'card form' },
      field('sharePct', 'Go Live share %'),
      field('gstMode', 'GST method', 'select', { options: [['gift_first', 'GST out of the gift first, then the share'], ['share_only', 'GST only on Go Live share']] }),
      field('gstPct', 'GST %'),
      field('tdsPct', 'TDS % (194-O: 0.1%)'),
      field('tdsBase', 'TDS on', 'select', { options: [['gross', 'The gross gift'], ['net', 'The payout before TDS']] }),
      field('feePct', 'Gateway fee %'),
      field('feePaidBy', 'Gateway fee paid by', 'select', { options: [['organiser', 'Organiser'], ['platform', 'Go Live']] }),
      field('holdDays', 'Days before a gift is payable'),
      field('minPayoutInr', 'Minimum payout ₹')),
    preview,
    el('h2', { text: 'Fraud limits (for every club; override per club in Clubs)' }),
    el('div', { class: 'card form' },
      field('minGiftInr', 'Smallest gift ₹'), field('maxGiftInr', 'Largest gift ₹'),
      field('perDeviceDailyInr', 'Per phone per day ₹'), field('perDeviceHourlyCount', 'Gifts per phone per hour'),
      field('perIpHourlyCount', 'Gifts per network per hour'), field('clubDailyInr', 'Per club per day ₹'),
      field('onlyWhileLive', 'Only while the event is live', 'check')),
    el('h2', { text: 'Payment' }),
    el('div', { class: 'card form' }, field('payerPhone', 'Phone sent to Cashfree (viewers are not asked)', 'text', { maxlength: '14', inputmode: 'numeric' })),
    el('h2', { text: 'Default stickers (clubs can change them per event)' }), el('div', { class: 'card' }, stBox),
    el('h2', { text: 'Blocked words in gift messages' }), el('div', { class: 'card' }, words, el('p', { class: 'small muted', text: 'Common abuse is masked automatically, like chat. Messages with these words are refused.' })),
    el('div', { class: 'row', style: 'margin:16px 0 30px' }, el('button', { class: 'btn primary', onclick: guard(async () => { const r = await put('/api/admin/gifts/settings', s); Object.assign(s, r.settings); toast('Gift settings saved'); }), text: 'Save settings' })));
  refresh();
}

// ------------------------------------------------------------------ clubs
async function clubs(body) {
  const d = await get('/api/admin/gifts/clubs');
  const pill = (st) => el('span', { class: 'pill ' + ({ verified: 'ok', rejected: 'bad' }[st] ?? 'warn'), text: st ?? 'none' });
  body.append(
    el('div', { class: 'grid' }, stat(String(d.clubs.filter((c) => c.payee?.status === 'pending').length), 'Waiting for verification', d.clubs.some((c) => c.payee?.status === 'pending')), stat(String(d.clubs.filter((c) => c.payee?.status === 'verified').length), 'Verified'), stat(String(d.clubs.filter((c) => c.signedAt).length), 'Agreements signed')),
    el('p', { class: 'small muted', text: 'Check the name, PAN and account match (e.g. a ₹1 transfer or the bank\'s name lookup) before verifying.' }),
    table(['Club', 'Payee', 'Bank', 'Status', 'Agreement', { t: 'Gifts', n: true }, { t: 'Unpaid', n: true }, 'Overrides', ''], d.clubs.map((c) => [
      c.name, c.payee ? `${c.payee.legalName} · PAN ${c.payee.pan}` : '–', c.payee ? `${c.payee.account} · ${c.payee.ifsc}` : '–', c.payee ? pill(c.payee.status) : '–',
      c.signedAt ? `Signed ${day(c.signedAt)}` : '–', inr(c.gross), inr(c.payable),
      Object.keys(c.overrides).length ? Object.entries(c.overrides).map(([k, v]) => `${k}: ${v}`).join(', ') : '–',
      el('div', { class: 'row' },
        c.payee && c.payee.status !== 'verified' ? el('button', { class: 'btn small primary', onclick: guard(async () => { if (!(await confirmBox(`Verify ${c.payee.legalName}?`, `${c.payee.account} · ${c.payee.ifsc} · PAN ${c.payee.pan}`, 'Verify', false))) return; await post(`/api/admin/gifts/clubs/${c.orgId}/verify`, { ok: true }); toast('Verified'); go('/web/admin/gifts/clubs'); }), text: 'Verify' }) : null,
        c.payee && c.payee.status !== 'rejected' ? el('button', { class: 'btn small ghost', onclick: guard(async () => { const v = await dialog({ title: 'Not accepted', text: 'Tell the club what to fix.', ok: 'Send', danger: true, fields: [{ name: 'note', label: 'Reason', required: true, placeholder: 'Name on PAN does not match the account holder' }] }); if (!v) return; await post(`/api/admin/gifts/clubs/${c.orgId}/verify`, { ok: false, note: v.note }); go('/web/admin/gifts/clubs'); }), text: 'Reject' }) : null,
        el('button', { class: 'btn small ghost', onclick: guard(async () => {
          const v = await dialog({ title: `Overrides for ${c.name}`, text: 'Leave empty to use the platform setting.', fields: d.overridable.map((k) => ({ name: k, label: OV_LABELS[k] ?? k, value: c.overrides[k] ?? '' })) });
          if (!v) return;
          const out = {};
          for (const [k, x] of Object.entries(v)) if (x !== '') out[k] = k === 'enabled' ? x === 'true' : Number(x);
          await put(`/api/admin/gifts/clubs/${c.orgId}/overrides`, out); toast('Overrides saved'); go('/web/admin/gifts/clubs');
        }), text: 'Overrides' }))]), { empty: 'No club has set up payouts yet.' }));
}

// ------------------------------------------------------------------ payouts
async function payouts(body) {
  const d = await get('/api/admin/gift-payouts');
  const due = d.payouts.filter((p) => p.status === 'due');
  body.append(
    el('div', { class: 'grid' }, stat(inr(due.reduce((a, p) => a + p.net, 0)), `Due (${due.length})`, due.length > 0), stat(inr(d.payouts.filter((p) => p.status === 'paid').reduce((a, p) => a + p.net, 0)), 'Paid'), stat(inr(d.payouts.reduce((a, p) => a + p.share, 0)), 'Go Live share in payouts'), stat(inr(d.payouts.reduce((a, p) => a + p.tds, 0)), 'TDS to deposit')),
    el('div', { class: 'card row', style: 'margin-top:14px' },
      el('span', { style: 'flex:1', class: 'small', text: 'Weekly: create payouts for every gift older than the hold, download the bank file, pay from your bank, then enter each UTR. Deposit TDS in each organiser\'s PAN and file 26Q.' }),
      el('button', { class: 'btn primary', onclick: guard(async () => { const r = await post('/api/admin/gift-payouts/run'); toast(r.created.length ? `${r.created.length} payout${r.created.length > 1 ? 's' : ''} created` : 'Nothing payable yet'); go('/web/admin/gifts/payouts'); }), text: 'Create payouts now' }),
      due.length ? el('button', { class: 'btn', onclick: guard(() => download('/api/admin/gift-payouts/bank.csv', `gift-payouts-${new Date().toISOString().slice(0, 10)}.csv`)), text: 'Download bank file' }) : null),
    table(['Created', 'Club', { t: 'Gifts', n: true }, { t: 'Gross', n: true }, { t: 'GST', n: true }, { t: 'Share', n: true }, { t: 'TDS', n: true }, { t: 'Net', n: true }, 'Status', ''], d.payouts.map((p) => [
      day(p.createdAt), p.orgName, String(p.gifts), inr(p.gross), inr(p.gst), inr(p.share), inr(p.tds), el('strong', { text: inr(p.net) }),
      el('span', { class: 'pill ' + (p.status === 'paid' ? 'ok' : p.status === 'due' ? 'warn' : 'bad'), text: p.status === 'paid' ? `paid ${day(p.paidAt)} · ${p.utr}` : p.status }),
      p.status === 'due' ? el('div', { class: 'row' },
        el('button', { class: 'btn small primary', onclick: guard(async () => { const v = await dialog({ title: `Mark paid: ${inr(p.net)} to ${p.orgName}`, fields: [{ name: 'utr', label: 'Bank reference (UTR)', required: true }] }); if (!v) return; await post(`/api/admin/gift-payouts/${p.id}/paid`, v); toast('Marked paid; the club was emailed'); go('/web/admin/gifts/payouts'); }), text: 'Mark paid' }),
        el('button', { class: 'btn small ghost', onclick: guard(async () => { if (!(await confirmBox('Cancel this payout?', 'Its gifts go back to payable and join the next run.', 'Cancel payout'))) return; await post(`/api/admin/gift-payouts/${p.id}/cancel`); go('/web/admin/gifts/payouts'); }), text: 'Cancel' })) : '']), { empty: 'No payouts yet.' }));
}

// ------------------------------------------------------------------ all gifts
async function gifts(body) {
  const d = await get('/api/admin/gifts/list');
  body.append(table(['Paid', 'Club', 'Event', 'From', 'Message', { t: 'Gift', n: true }, { t: 'GST', n: true }, { t: 'Share', n: true }, { t: 'Net', n: true }, 'State', ''], d.gifts.map((g) => [
    when(g.at), g.org, g.event, `${g.emoji} ${g.name}`, g.message ?? '', inr(g.amount), inr(g.gst), inr(g.share), g.net == null ? '–' : inr(g.net),
    g.status === 'refunded' ? 'Refunded' : g.paidOut ? 'Paid out' : g.hidden ? 'Hidden' : 'Paid',
    g.status === 'paid' && !g.paidOut ? el('button', { class: 'btn small ghost', onclick: guard(async () => { if (!(await confirmBox('Mark refunded?', `Only after refunding ${inr(g.amount)} in the Cashfree dashboard (order ${g.orderId}). It leaves the payout and chat.`, 'Mark refunded'))) return; await post(`/api/admin/gifts/${g.id}/refunded`); go('/web/admin/gifts/gifts'); }), text: 'Refunded' }) : '']), { empty: 'No gifts yet.' }));
}
