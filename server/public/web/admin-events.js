import { get, post, patch, el, table, day, num, confirmBox, toast, guard, go } from './core.js';

export const title = 'Events';

export async function render(view) {
  const q = el('input', { placeholder: 'Search event, club or venue…' });
  const status = el('select', {}, [['all', 'All events'], ['live', 'Live now'], ['active', 'Active'], ['archived', 'Archived']].map(([v, t]) => el('option', { value: v, text: t })));
  const list = el('div');
  const load = async () => {
    const p = new URLSearchParams({ status: status.value });
    if (q.value.trim()) p.set('q', q.value.trim());
    const { events } = await get('/api/admin/events?' + p);
    list.replaceChildren(el('p', { class: 'small muted', text: `${events.length} event${events.length === 1 ? '' : 's'}` }),
      table(['Event', 'Club', 'Type', 'Date', { t: 'Cameras', n: true }, { t: 'Live min', n: true }, { t: 'Viewers', n: true }, { t: 'Watch min', n: true }, '', ''], events.map((e) => [
        el('strong', { text: e.name }),
        el('a', { href: '/web/admin/clubs/' + e.orgId, onclick: (ev) => { ev.preventDefault(); go('/web/admin/clubs/' + e.orgId); }, text: e.orgName }),
        e.eventType, day(e.startsOn ?? e.createdAt), e.cameras, num(e.liveMinutes), num(e.viewers), num(e.watchMinutes),
        el('span', { class: 'row' }, e.liveNow ? el('span', { class: 'pill live', text: 'LIVE' }) : null, e.addonOn ? el('span', { class: 'pill ok', text: 'Add-on' }) : null,
          !e.publicWatch ? el('span', { class: 'pill warn', text: 'Page off' }) : null, e.archived ? el('span', { class: 'pill', text: 'Archived' }) : null),
        el('span', { class: 'row' },
          el('a', { class: 'btn small', href: '/web/e/' + e.id, text: 'Open' }),
          el('a', { class: 'btn small', href: e.watchUrl, target: '_blank', rel: 'noopener', text: 'Watch' }),
          el('button', { class: 'btn small', onclick: guard(async () => { await patch('/api/tournaments/' + e.id, { publicWatch: !e.publicWatch }); toast(e.publicWatch ? 'Watch page taken down' : 'Watch page back up'); load(); }), text: e.publicWatch ? 'Page off' : 'Page on' }),
          el('button', { class: 'btn small', onclick: guard(async () => { await patch('/api/tournaments/' + e.id, { archived: !e.archived }); toast(e.archived ? 'Restored' : 'Archived'); load(); }), text: e.archived ? 'Restore' : 'Archive' }),
          e.liveNow ? el('button', { class: 'btn small danger', onclick: guard(async () => {
            if (!(await confirmBox('End this broadcast now?', `${e.name} (${e.orgName}) stops on every platform.`, 'End broadcast'))) return;
            await post(`/api/admin/events/${e.id}/stop`); toast('Stop sent'); load();
          }), text: 'Stop' }) : null),
      ]), { empty: 'No events match.' }));
  };
  let t;
  q.oninput = () => { clearTimeout(t); t = setTimeout(load, 300); };
  status.onchange = load;
  view.append(el('div', { class: 'form', style: 'margin-bottom:12px' }, el('div', {}, q), el('div', {}, status)), list);
  await load();
}
