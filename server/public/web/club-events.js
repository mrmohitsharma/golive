import { state, get, el, table, day } from './core.js';

export const title = 'Events';

export async function render(view) {
  const { tournaments } = await get('/api/tournaments');
  const mine = tournaments.filter((t) => t.orgId === state.orgId && !t.archived);
  const org = state.orgs.find((o) => o.id === state.orgId);
  view.append(
    el('p', { class: 'muted', text: org ? `${org.name} · ${org.role}` : 'No club selected.' }),
    table(['Event', 'Type', 'Date', 'Venue', ''], mine.map((t) => [
      el('strong', { text: t.name }), t.eventType, day(t.startsOn), t.venue ?? '–',
      el('a', { class: 'btn small', href: '/studio/' + t.id, text: 'Studio' }),
    ]), { empty: 'No events yet. Create one in the app.' }));
}
