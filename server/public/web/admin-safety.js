import { get, post, patch, el, table, when, day, dialog, toast, guard, go } from './core.js';

export const title = 'Safety';
const TABS = [['chat', 'Chat'], ['bans', 'Banned viewers'], ['requests', 'Data requests']];
const KIND = { delete_account: 'Delete account', delete_club: 'Delete club', export: 'Export data', correct: 'Correct data' };

export async function render(view, { tab = 'chat' }) {
  view.append(el('nav', { class: 'tabs' }, TABS.map(([k, t]) => el('a', { href: '/web/admin/safety/' + k, class: k === tab ? 'on' : null, onclick: (e) => { e.preventDefault(); go('/web/admin/safety/' + k); }, text: t }))));
  const body = el('div'); view.append(body);
  if (tab === 'bans') return bans(body);
  if (tab === 'requests') return requests(body);
  return chat(body);
}

async function chat(body) {
  const q = el('input', { placeholder: 'Search messages or names across all events…' });
  const hidden = el('select', {}, [['', 'All messages'], ['yes', 'Hidden only']].map(([v, t]) => el('option', { value: v, text: t })));
  const out = el('div');
  const load = async () => {
    const p = new URLSearchParams(); if (q.value.trim()) p.set('q', q.value.trim()); if (hidden.value) p.set('hidden', 'yes');
    const { messages } = await get('/api/admin/chat?' + p);
    out.replaceChildren(table(['When', 'Event', 'From', 'Message', 'Status', ''], messages.map((m) => [when(m.at), el('span', { class: 'small', text: `${m.event} · ${m.club}` }), `${m.author} (${m.source})`, m.text,
      el('span', { class: 'row' }, m.hidden ? el('span', { class: 'pill warn', text: 'Hidden' }) : null, m.banned ? el('span', { class: 'pill bad', text: 'Banned' }) : null),
      el('span', { class: 'row' },
        el('button', { class: 'btn small', onclick: guard(async () => { await patch('/api/chat/' + m.id, { hidden: !m.hidden }); load(); }), text: m.hidden ? 'Show' : 'Hide' }),
        !m.banned ? el('button', { class: 'btn small danger', onclick: guard(async () => { await post(`/api/chat/${m.id}/ban`); toast('Banned from this event\'s chat'); load(); }), text: 'Ban' }) : null)]), { empty: 'No messages.' }));
  };
  let t; q.oninput = () => { clearTimeout(t); t = setTimeout(load, 300); }; hidden.onchange = load;
  body.append(el('div', { class: 'form', style: 'margin-bottom:12px' }, el('div', {}, q), el('div', {}, hidden)), out);
  await load();
}

async function bans(body) {
  const { bans } = await get('/api/admin/chat-bans');
  body.append(table(['Since', 'Viewer', 'Source', 'Event', 'Club', 'Banned by', ''], bans.map((b) => [day(b.at), b.author ?? '–', b.source, b.event, b.club, b.by ?? '–',
    el('button', { class: 'btn small', onclick: guard(async () => { await post('/api/admin/chat-bans/remove', { eventId: b.eventId, source: b.source, authorKey: b.authorKey }); toast('Unbanned'); go('/web/admin/safety/bans'); }), text: 'Unban' })]), { empty: 'Nobody is banned.' }));
}

async function requests(body) {
  const { requests } = await get('/api/admin/data-requests');
  body.append(
    el('p', { class: 'muted', text: 'Requests from the “Delete your account” page. Confirm by email that the request came from the account owner, act on it (Users > Delete, or the club page), then mark it done. Due within 30 days.' }),
    table(['Received', 'Email', 'Request', 'Details', 'Due by', 'Status', ''], requests.map((r) => [day(r.at), r.email, KIND[r.kind], r.details ?? '–', day(r.dueBy),
      el('span', { class: 'pill ' + ({ open: Date.parse(r.dueBy) < Date.now() ? 'bad' : 'warn', done: 'ok', rejected: '' }[r.status]), text: r.status }),
      el('span', { class: 'row' },
        r.userId ? el('button', { class: 'btn small', onclick: () => go('/web/admin/users/' + r.userId), text: 'Open user' }) : el('span', { class: 'small muted', text: 'No account' }),
        r.status === 'open' ? el('button', { class: 'btn small', onclick: guard(async () => {
          const v = await dialog({ title: 'Close request', fields: [{ name: 'status', label: 'Outcome', type: 'select', value: 'done', options: [{ value: 'done', label: 'Done' }, { value: 'rejected', label: 'Rejected (could not verify, or not allowed)' }] }, { name: 'note', label: 'Note', type: 'textarea' }] });
          if (!v) return; await patch('/api/admin/data-requests/' + r.id, v); go('/web/admin/safety/requests');
        }), text: 'Close' }) : el('span', { class: 'small muted', text: `${r.doneBy ?? ''} ${r.note ?? ''}` }))]), { empty: 'No requests.' }));
}
