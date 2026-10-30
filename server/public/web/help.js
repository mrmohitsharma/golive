import { state, get, post, el, table, when, toast, guard, go } from './core.js';
import { CATEGORY, PRIORITY, statusPill, priorityPill, readFiles, fileInput, thread } from './tickets-ui.js';

export const title = 'Help';

export async function render(view, { key }) {
  if (key) return one(view, key);
  const [{ tickets }, { tournaments }] = await Promise.all([get('/api/support/mine'), get('/api/tournaments').catch(() => ({ tournaments: [] }))]);
  const f = {
    subject: el('input', { name: 'subject', maxlength: 140, placeholder: 'e.g. Camera 3 keeps disconnecting' }),
    category: el('select', { name: 'category' }, Object.entries(CATEGORY).map(([v, t]) => el('option', { value: v, text: t }))),
    priority: el('select', { name: 'priority' }, Object.entries(PRIORITY).map(([v, t]) => el('option', { value: v, selected: v === 'normal' || undefined, text: v === 'urgent' ? 'Urgent: a live event is affected' : t }))),
    event: el('select', { name: 'eventId' }, el('option', { value: '', text: 'Not about one event' }), tournaments.filter((t) => !t.archived).map((t) => el('option', { value: t.id, text: `${t.name}${t.orgName ? ' · ' + t.orgName : ''}` }))),
    message: el('textarea', { name: 'message', rows: 5, maxlength: 10000, placeholder: 'What happened, what you expected, and when' }),
    files: fileInput(),
  };
  view.append(
    el('h2', { text: 'Raise a ticket' }),
    el('div', { class: 'card' },
      el('div', { class: 'form' }, el('div', {}, el('label', { text: 'Subject' }), f.subject), el('div', {}, el('label', { text: 'About' }), f.category), el('div', {}, el('label', { text: 'How urgent' }), f.priority), el('div', {}, el('label', { text: 'Event' }), f.event)),
      el('div', { style: 'margin-top:12px' }, el('label', { text: 'Details' }), f.message),
      el('div', { style: 'margin-top:12px' }, el('label', { text: 'Screenshots or PDFs (up to 5, 5 MB each)' }), f.files),
      el('div', { class: 'row', style: 'margin-top:12px' }, el('button', { class: 'btn primary', onclick: guard(async () => {
        if (f.subject.value.trim().length < 3 || f.message.value.trim().length < 5) throw new Error('Add a subject and some details.');
        const r = await post('/api/support/tickets', { subject: f.subject.value.trim(), category: f.category.value, priority: f.priority.value, eventId: f.event.value || null, message: f.message.value.trim(), files: await readFiles(f.files) });
        toast(`Ticket #${r.number} sent. We will reply by email.`); go('/web/help/' + r.key);
      }), type: 'submit', text: 'Send' }), el('span', { class: 'small muted', text: `Replies go to ${state.me.email}.` }))),
    el('h2', { text: 'Your tickets' }),
    table(['#', 'Subject', 'Event', 'Priority', 'Status', 'Updated'], tickets.map((t) => [t.number, el('strong', { text: t.subject }), t.event ?? '–', priorityPill(t.priority), statusPill(t.status), when(t.updatedAt)]),
      { onclick: (i) => go('/web/help/' + tickets[i].key), empty: 'No tickets yet.' }));
}

async function one(view, key) {
  const d = await get('/api/support/t/' + key);
  const t = d.ticket;
  document.getElementById('title').textContent = `#${t.number} ${t.subject}`;
  const body = el('textarea', { rows: 4, maxlength: 10000, placeholder: 'Add details or answer our question' });
  const files = fileInput();
  view.append(
    el('div', { class: 'row', style: 'margin-bottom:10px' }, statusPill(t.status), priorityPill(t.priority), el('span', { class: 'small muted', text: `${CATEGORY[t.category]}${t.event ? ' · ' + t.event : ''} · opened ${when(t.createdAt)}` }), el('div', { class: 'sp' }),
      el('a', { class: 'btn small', href: '/web/help', onclick: (e) => { e.preventDefault(); go('/web/help'); }, text: 'All tickets' })),
    thread(d.messages, (f) => `/api/support/t/${key}/files/${f.id}`),
    t.status !== 'closed' ? el('div', { class: 'card', style: 'margin-top:14px' }, body, el('div', { style: 'margin-top:8px' }, files),
      el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn primary', onclick: guard(async () => {
        if (!body.value.trim()) return;
        await post(`/api/support/t/${key}/messages`, { body: body.value.trim(), files: await readFiles(files) });
        toast('Reply sent'); go('/web/help/' + key);
      }), text: 'Send reply' }))) : el('p', { class: 'muted', text: 'This ticket is closed. Raise a new one if you need more help.' }));
}
