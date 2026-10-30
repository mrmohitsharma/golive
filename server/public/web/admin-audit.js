import { get, el, table, when } from './core.js';

export const title = 'Audit log';

export async function render(view) {
  const q = el('input', { placeholder: 'Search action, target or user…' });
  const actor = el('input', { placeholder: 'Admin email' });
  const list = el('div');
  let last = [];
  const load = async (more = false) => {
    const params = new URLSearchParams();
    if (q.value.trim()) params.set('q', q.value.trim());
    if (actor.value.trim()) params.set('actor', actor.value.trim());
    if (more && last.length) params.set('before', last.at(-1).id);
    const { entries } = await get('/api/admin/audit?' + params);
    last = more ? last.concat(entries) : entries;
    list.replaceChildren(...[
      table(['When', 'Admin', 'Logged in as', 'Action', 'Target', { t: 'Result', n: true }, 'Details'], last.map((e) => [
        when(e.at), e.actor, e.asUser ?? '–', el('span', { class: 'mono', text: e.action }), e.targetId ? el('span', { class: 'mono small', text: `${e.targetKind ?? ''} ${e.targetId}` }) : '–',
        el('span', { class: 'pill ' + (e.status >= 400 ? 'bad' : 'ok'), text: e.status ?? '' }),
        el('details', { class: 'json' }, el('summary', { text: 'View' }), el('pre', { text: JSON.stringify(e.detail, null, 2) })),
      ]), { empty: 'No admin actions yet.' }),
      entries.length === 100 ? el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'btn small', onclick: () => load(true), text: 'Load more' })) : null].filter(Boolean));
  };
  let t;
  const later = () => { clearTimeout(t); t = setTimeout(() => load(), 300); };
  q.oninput = later; actor.oninput = later;
  view.append(
    el('p', { class: 'muted', text: 'Every change made by an administrator, including while logged in as a club owner. Passwords, keys and codes are never recorded.' }),
    el('div', { class: 'form', style: 'margin-bottom:12px' }, el('div', {}, q), el('div', {}, actor)),
    list);
  await load();
}
