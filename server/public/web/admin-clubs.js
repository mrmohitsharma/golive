import { get, el, table, inr, num, day, ago, go } from './core.js';

export const title = 'Clubs';

export async function render(view) {
  const q = el('input', { placeholder: 'Search club name or member email…' });
  const filter = el('select', {}, ['All clubs', 'Live now', 'Suspended', 'Low balance (under 100)', 'Custom pricing'].map((t) => el('option', { text: t })));
  const list = el('div');
  let rows = [];
  const draw = () => {
    const f = filter.value;
    const shown = rows.filter((o) => f === 'Live now' ? o.liveNow : f === 'Suspended' ? o.suspended : f === 'Low balance (under 100)' ? o.balance < 100 : f === 'Custom pricing' ? o.customPricing : true);
    list.replaceChildren(
      el('p', { class: 'small muted', text: `${shown.length} club${shown.length === 1 ? '' : 's'}` }),
      table(['Club', 'Owner', { t: 'Credits', n: true }, { t: 'Events', n: true }, { t: 'Live min', n: true }, { t: 'Paid', n: true }, 'Last event', 'Joined', ''], shown.map((o) => [
        el('strong', { text: o.name }), el('span', { class: 'small', text: o.owners ?? '–' }), num(o.balance), o.tournaments, num(o.liveMinutes), inr(o.paidInr),
        o.lastTournamentAt ? ago(o.lastTournamentAt) : '–', day(o.createdAt),
        el('span', { class: 'row' }, o.liveNow ? el('span', { class: 'pill live', text: 'LIVE' }) : null, o.suspended ? el('span', { class: 'pill bad', text: 'Suspended' }) : null, o.customPricing ? el('span', { class: 'pill warn', text: 'Custom price' }) : null),
      ]), { onclick: (i) => go('/web/admin/clubs/' + shown[i].id), empty: 'No clubs match.' }));
  };
  const load = async () => {
    rows = (await get('/api/admin/orgs' + (q.value.trim() ? '?q=' + encodeURIComponent(q.value.trim()) : ''))).orgs;
    draw();
  };
  let t;
  q.oninput = () => { clearTimeout(t); t = setTimeout(load, 300); };
  filter.onchange = draw;
  view.append(el('div', { class: 'form', style: 'margin-bottom:12px' }, el('div', {}, q), el('div', {}, filter)), list);
  await load();
}
