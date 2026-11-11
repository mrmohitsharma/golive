// V9 gift credits on an event: switch on, the stickers viewers pick from (name, emoji, amount),
// custom amounts, the card in the video, top supporters, a goal, holding messages for approval,
// and the live list of gifts with Approve and Hide.
import { get, patch, post, el, toast, guard, go, inr, when, stat, table } from './core.js';

const split = (x) => `${inr(x.gross)} gift → GST ${inr(x.gst)} · Go Live ${x.sharePct}% ${inr(x.share)} · gateway ${inr(x.fee)}${x.feePaidBy === 'platform' ? ' (paid by Go Live)' : ''} · TDS ${inr(x.tds)} → you get ${inr(x.net)}`;

export async function render(body, id) {
  let v = await get(`/api/tournaments/${id}/gifts`);
  let timer = null;
  const save = (p, msg) => guard(async () => { const r = await patch(`/api/tournaments/${id}/gifts`, p); v.config = r.config; if (msg) toast(msg); draw(); });

  const draw = () => {
    const c = v.config;
    let stickers = c.stickers.map((s) => ({ ...s }));
    const rows = el('div');
    const drawRows = () => rows.replaceChildren(
      table(['', 'Name', { t: 'Amount (₹)', n: true }, ''], stickers.map((s, i) => [
        el('input', { value: s.emoji, maxlength: '4', style: 'width:56px;text-align:center;font-size:20px', oninput: (e) => (s.emoji = e.target.value) }),
        el('input', { value: s.name, maxlength: '24', oninput: (e) => (s.name = e.target.value) }),
        el('input', { type: 'number', min: String(v.limits.min), max: String(v.limits.max), value: s.amount, style: 'width:110px', oninput: (e) => (s.amount = Number(e.target.value)) }),
        el('button', { class: 'btn small ghost', onclick: () => { stickers.splice(i, 1); drawRows(); }, text: 'Remove' })]), { empty: 'No stickers.' }),
      el('div', { class: 'row', style: 'margin-top:8px' },
        stickers.length < 12 ? el('button', { class: 'btn small', onclick: () => { stickers.push({ emoji: '🎁', name: 'New', amount: Math.max(v.limits.min, 51) }); drawRows(); }, text: 'Add sticker' }) : null,
        el('button', { class: 'btn small ghost', onclick: () => { stickers = v.defaults.map((s) => ({ ...s })); drawRows(); }, text: 'Use the Go Live set' }),
        el('div', { class: 'sp' }),
        el('button', { class: 'btn primary small', onclick: save({ stickers }, 'Stickers saved'), text: 'Save stickers' })));
    drawRows();

    const check = (k, label, hint) => el('label', { class: 'check', style: 'align-items:flex-start' },
      el('input', { type: 'checkbox', checked: c[k] || undefined, onchange: (e) => save({ [k]: e.target.checked })() }),
      el('span', {}, label, hint ? el('div', { class: 'small muted', text: hint }) : null));
    const goalAmt = el('input', { type: 'number', min: '0', placeholder: 'e.g. 50000', value: c.goal.amount ?? '' });
    const goalText = el('input', { maxlength: '80', placeholder: 'e.g. Team kit for the season', value: c.goal.text });
    const btnText = el('input', { maxlength: '20', placeholder: `${v.button} (default)`, value: c.button ?? '' });

    const pending = v.gifts.filter((g) => !g.approved && !g.hidden);
    body.replaceChildren(
      v.notReady && !c.enabled ? el('div', { class: 'banner warn row' }, el('span', { style: 'flex:1', text: `${v.label} cannot be switched on yet: ${v.notReady}` }),
        el('a', { class: 'btn small primary', href: '/web/payouts', onclick: (e) => { e.preventDefault(); go('/web/payouts'); }, text: 'Set up payouts' })) : null,
      el('div', { class: 'grid' }, stat(inr(v.totals.raised), `${v.label} received`), stat(String(v.totals.count), 'Gifts'), stat(c.enabled ? 'On' : 'Off', 'For this event'), stat(c.goal.amount ? inr(c.goal.amount) : '–', 'Goal')),
      el('div', { class: 'card', style: 'margin-top:14px' },
        el('div', { class: 'row' }, el('strong', { text: v.label }), el('div', { class: 'sp' }),
          el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: c.enabled || undefined, disabled: (!c.enabled && v.notReady) || undefined, onchange: (e) => save({ enabled: e.target.checked }, e.target.checked ? `${v.label} on` : `${v.label} off`)() }), 'Viewers can send gifts')),
        el('p', { class: 'small muted', style: 'margin:6px 0 0', text: `Viewers tap ${c.button || v.button} on the watch page while you are live, pick a sticker, add their name and a message, and pay by UPI. Example for a ₹101 gift: ${split(v.example)}. Paid to your bank 7 days later.` })),
      el('div', { class: 'card', style: 'margin-top:14px' }, el('strong', { text: 'Stickers' }), el('p', { class: 'small muted', style: 'margin:4px 0 10px', text: `Names and amounts are yours to choose (₹${v.limits.min} to ₹${v.limits.max.toLocaleString('en-IN')}). Up to 12.` }), rows),
      el('div', { class: 'card', style: 'margin-top:14px;display:grid;gap:12px' },
        el('strong', { text: 'Options' }),
        check('allowCustom', 'Viewers can type their own amount'),
        check('inVideo', 'Show each gift in the video', 'A card with the name, amount and message appears for a few seconds, also on YouTube and Facebook. The director can hide one.'),
        check('topSupporters', 'Show top supporters on the watch page'),
        check('approval', 'Hold messages until I approve them', 'The money is the same; the gift appears in chat and the video only after you approve it.'),
        el('div', { class: 'form' },
          el('div', {}, el('label', { text: 'Button text' }), btnText),
          el('div', {}, el('label', { text: 'Goal (₹, optional)' }), goalAmt),
          el('div', {}, el('label', { text: 'Goal text' }), goalText),
          el('div', {}, el('button', { class: 'btn primary', onclick: save({ button: btnText.value.trim() || null, goal: { amount: goalAmt.value ? Number(goalAmt.value) : null, text: goalText.value } }, 'Saved'), text: 'Save' })))),
      pending.length ? el('div', { class: 'banner warn', text: `${pending.length} gift message${pending.length > 1 ? 's' : ''} waiting for your approval.` }) : null,
      el('h2', { text: 'Gifts received' }),
      table(['When', 'From', 'Message', { t: 'Gift', n: true }, { t: 'You get', n: true }, 'Shown', ''], v.gifts.map((g) => [
        when(g.at), `${g.emoji} ${g.name}`, g.message ?? '', inr(g.amount), g.net == null ? '–' : inr(g.net),
        g.status === 'refunded' ? 'Refunded' : g.hidden ? 'Hidden' : g.approved ? 'Yes' : 'Waiting',
        el('div', { class: 'row' },
          !g.approved && !g.hidden ? el('button', { class: 'btn small primary', onclick: guard(async () => { await post(`/api/tournaments/${id}/gifts/${g.id}`, { approve: true }); await reload(); }), text: 'Approve' }) : null,
          el('button', { class: 'btn small ghost', onclick: guard(async () => { await post(`/api/tournaments/${id}/gifts/${g.id}`, { hidden: !g.hidden }); await reload(); }), text: g.hidden ? 'Show' : 'Hide' }))]), { empty: 'No gifts yet.' }),
      v.top.length ? el('div', {}, el('h2', { text: 'Top supporters' }), table(['Name', { t: 'Gifts', n: true }, { t: 'Total', n: true }], v.top.map((t) => [t.name, String(t.count), inr(t.total)]))) : null);
  };
  const reload = async () => { v = await get(`/api/tournaments/${id}/gifts`); draw(); };
  draw();
  timer = setInterval(() => { if (body.isConnected && !document.hidden && !body.contains(document.activeElement)) reload().catch(() => {}); }, 15000);
  return () => clearInterval(timer);
}
