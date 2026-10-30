import { get, post, patch, el, stat, table, when, toast, guard, go } from './core.js';
import { CATEGORY, PRIORITY, STATUS, statusPill, priorityPill, readFiles, fileInput, thread, tokenQ } from './tickets-ui.js';

export const title = 'Support';

export async function render(view, { id }) {
  if (id) return one(view, id);
  const f = {
    status: el('select', {}, [['active', 'Open and waiting'], ...Object.entries(STATUS)].map(([v, t]) => el('option', { value: v, text: t }))),
    priority: el('select', {}, [['', 'Any priority'], ...Object.entries(PRIORITY)].map(([v, t]) => el('option', { value: v, text: t }))),
    category: el('select', {}, [['', 'Any topic'], ...Object.entries(CATEGORY)].map(([v, t]) => el('option', { value: v, text: t }))),
    assigned: el('select', {}, [['any', 'Anyone'], ['me', 'Assigned to me'], ['none', 'Unassigned']].map(([v, t]) => el('option', { value: v, text: t }))),
    q: el('input', { placeholder: 'Search subject, email or #number' }),
  };
  const out = el('div');
  const load = async () => {
    const p = new URLSearchParams(Object.entries({ status: f.status.value, priority: f.priority.value, category: f.category.value, assigned: f.assigned.value, q: f.q.value.trim() }).filter(([, v]) => v));
    const { tickets, counts } = await get('/api/admin/tickets?' + p);
    out.replaceChildren(
      el('div', { class: 'grid' }, stat(counts.open, 'Open'), stat(counts.pending, 'Waiting for customer'), stat(counts.urgent, 'Urgent', counts.urgent > 0), stat(counts.unassigned, 'Unassigned', counts.unassigned > 0)),
      el('div', { style: 'height:12px' }),
      table(['#', 'Subject', 'From', 'Club / event', 'Priority', 'Status', 'Assigned', 'Updated'], tickets.map((t) => [t.number, el('strong', { text: t.subject }),
        el('span', { class: 'small', text: `${t.name} · ${t.email}` }), el('span', { class: 'small', text: [t.club, t.event].filter(Boolean).join(' · ') || 'Visitor' }),
        priorityPill(t.priority), el('span', {}, statusPill(t.status), t.lastReplyBy === 'customer' && t.status === 'open' ? el('div', { class: 'small', style: 'color:var(--warn)', text: 'needs a reply' }) : null),
        t.assignedTo?.name ?? '–', when(t.updatedAt)]), { onclick: (i) => go('/web/admin/support/' + tickets[i].id), empty: 'No tickets here.' }));
  };
  for (const i of Object.values(f)) i.onchange = load;
  let t; f.q.oninput = () => { clearTimeout(t); t = setTimeout(load, 300); };
  view.append(el('div', { class: 'form', style: 'margin-bottom:12px' }, Object.values(f).map((i) => el('div', {}, i))), out);
  await load();
  const timer = setInterval(() => load().catch(() => {}), 30000);
  return () => clearInterval(timer);
}

async function one(view, id) {
  const d = await get('/api/admin/tickets/' + id);
  const t = d.ticket;
  document.getElementById('title').textContent = `#${t.number} ${t.subject}`;
  const reload = () => go('/web/admin/support/' + id);
  const set = (k) => guard(async (e) => { await patch('/api/admin/tickets/' + id, { [k]: e.target.value || null }); toast('Saved'); reload(); });
  const body = el('textarea', { rows: 5, maxlength: 10000, placeholder: 'Reply to the customer (or an internal note)' });
  const internal = el('input', { type: 'checkbox' });
  const after = el('select', { style: 'width:auto' }, [['pending', 'then wait for customer'], ['open', 'keep open'], ['resolved', 'and mark resolved']].map(([v, l]) => el('option', { value: v, text: l })));
  const files = fileInput();
  view.append(
    el('div', { class: 'cr' },
      el('div', {},
        thread(d.messages, (f) => `/api/admin/tickets/${id}/files/${f.id}?${tokenQ()}`),
        t.status !== 'closed' ? el('div', { class: 'card', style: 'margin-top:14px' }, body, el('div', { style: 'margin-top:8px' }, files),
          el('div', { class: 'row', style: 'margin-top:10px' },
            el('label', { class: 'check' }, internal, 'Internal note (customer does not see it)'), el('div', { class: 'sp' }), after,
            el('button', { class: 'btn primary', onclick: guard(async () => {
              if (!body.value.trim()) return;
              await post(`/api/admin/tickets/${id}/messages`, { body: body.value.trim(), internal: internal.checked, status: internal.checked ? undefined : after.value, files: await readFiles(files) });
              toast(internal.checked ? 'Note added' : 'Reply sent'); reload();
            }), text: 'Send' }))) : el('p', { class: 'muted', text: 'Closed. Reopen it from the status on the right to reply.' })),
      el('div', {},
        el('div', { class: 'card' },
          el('label', { text: 'Status' }), el('select', { onchange: set('status') }, Object.entries(STATUS).map(([v, l]) => el('option', { value: v, selected: v === t.status || undefined, text: l }))),
          el('label', { style: 'margin-top:10px', text: 'Priority' }), el('select', { onchange: set('priority') }, Object.entries(PRIORITY).map(([v, l]) => el('option', { value: v, selected: v === t.priority || undefined, text: l }))),
          el('label', { style: 'margin-top:10px', text: 'Topic' }), el('select', { onchange: set('category') }, Object.entries(CATEGORY).map(([v, l]) => el('option', { value: v, selected: v === t.category || undefined, text: l }))),
          el('label', { style: 'margin-top:10px', text: 'Assigned to' }), el('select', { onchange: set('assignedTo') }, el('option', { value: '', text: 'Nobody' }), d.admins.map((a) => el('option', { value: a.id, selected: a.id === t.assignedTo?.id || undefined, text: a.name })))),
        el('div', { class: 'card', style: 'margin-top:12px' },
          el('strong', { text: t.name }), el('div', { class: 'small', text: t.email }),
          t.club ? el('div', { class: 'small', style: 'margin-top:6px' }, 'Club: ', t.orgId ? el('a', { href: '/web/admin/clubs/' + t.orgId, text: t.club }) : t.club) : el('div', { class: 'small muted', text: 'Website visitor (no account)' }),
          t.eventId ? el('div', { class: 'small' }, 'Event: ', el('a', { href: '/web/e/' + t.eventId, text: t.event })) : null,
          el('div', { class: 'small muted', style: 'margin-top:6px', text: `Opened ${when(t.createdAt)}` }),
          el('div', { class: 'small', style: 'margin-top:6px' }, el('a', { href: `/support/t/${t.key}`, target: '_blank', text: 'Customer’s view' }))),
        d.otherTickets.length ? el('div', { class: 'card', style: 'margin-top:12px' }, el('strong', { class: 'small', text: 'Their other tickets' }), d.otherTickets.map((o) => el('div', { class: 'small', text: `#${o.number} ${o.subject} · ${STATUS[o.status]}` }))) : null)));
}
