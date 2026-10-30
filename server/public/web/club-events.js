import { state, get, post, el, table, day, dialog, toast, guard, go } from './core.js';

export const title = 'Events';

export async function render(view) {
  const org = state.orgs.find((o) => o.id === state.orgId);
  const [{ tournaments }, { eventTypes }] = await Promise.all([get('/api/tournaments'), get('/api/event-types')]);
  const all = tournaments.filter((t) => t.orgId === state.orgId);
  const show = el('select', {}, [['active', 'Active events'], ['archived', 'Archived'], ['all', 'All']].map(([v, t]) => el('option', { value: v, text: t })));
  const list = el('div');
  const draw = () => {
    const rows = all.filter((t) => (show.value === 'all' ? true : show.value === 'archived' ? t.archived : !t.archived));
    list.replaceChildren(table(['Event', 'Type', 'Date', 'Venue', 'Production', ''], rows.map((t) => [
      el('strong', { text: t.name }), eventTypes.find((e) => e.id === t.eventType)?.label ?? t.eventType, day(t.startsOn), t.venue ?? '–', t.mode === 'cloud' ? 'Cloud' : 'Laptop',
      el('span', { class: 'row' },
        el('a', { class: 'btn small', href: `/web/e/${t.id}`, onclick: (e) => { e.preventDefault(); e.stopPropagation(); go(`/web/e/${t.id}`); }, text: 'Open' }),
        el('a', { class: 'btn small primary', href: `/web/e/${t.id}/control`, onclick: (e) => e.stopPropagation(), text: 'Control room' }))]),
      { onclick: (i) => go(`/web/e/${rows[i].id}`), empty: 'No events here yet.' }));
  };
  show.onchange = draw;
  view.append(
    el('div', { class: 'row', style: 'margin-bottom:12px' },
      el('span', { class: 'muted', text: org ? `${org.name} · ${org.role}` : '' }), el('div', { class: 'sp' }),
      el('div', { style: 'width:180px' }, show),
      el('button', { class: 'btn primary', onclick: guard(async () => {
        const v = await dialog({ title: 'New event', ok: 'Create', fields: [
          { name: 'name', label: 'Event name', required: true, placeholder: 'Monsoon Open 2026' },
          { name: 'eventType', label: 'Type of event', type: 'select', value: 'golf', options: eventTypes.map((e) => ({ value: e.id, label: e.label })) },
          { name: 'venue', label: 'Venue (optional)' },
          { name: 'startsOn', label: 'Date (optional)', type: 'date' }] });
        if (!v) return;
        const r = await post(`/api/orgs/${state.orgId}/tournaments`, { name: v.name, eventType: v.eventType, venue: v.venue || null, startsOn: v.startsOn || null });
        toast('Event created'); go(`/web/e/${r.tournament.id}`);
      }), text: 'New event' })),
    list);
  draw();
}
