// V9 Club > Brand page: the club's own channel at <name>.gogetslive.com: address, name,
// description, theme and colour, logo, links, sponsors, public or hidden, and which events show
// (with their series and start time for the countdown and reminder email).
import { state, get, put, post, del, patch, el, stat, table, toast, guard, go, confirmBox } from './core.js';

export const title = 'Brand page';

const readFile = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error('Could not read the file.'));
  r.readAsDataURL(file);
});
const localInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export async function render(view) {
  const id = state.orgId;
  const org = state.orgs.find((o) => o.id === id);
  const owner = org?.role === 'owner' || state.me.platformAdmin;
  let v = await get(`/api/orgs/${id}/channel`);

  const draw = () => {
    const c = v.channel;
    const look = c?.look ?? { theme: 'conference', accent: null, links: [], sponsors: [] };
    const suggested = (org?.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
    const slug = el('input', { value: c?.slug ?? suggested, maxlength: '30', style: 'text-transform:lowercase', required: true });
    const slugNote = el('div', { class: 'small muted', style: 'margin-top:4px' });
    let checkT = null;
    const check = () => { clearTimeout(checkT); checkT = setTimeout(guard(async () => { const r = await get(`/api/orgs/${id}/channel/check?slug=${encodeURIComponent(slug.value.trim().toLowerCase())}`); slugNote.style.color = r.ok ? 'var(--green, #7ee0a6)' : 'var(--bad)'; slugNote.textContent = r.ok ? r.url : r.problem; }), 350); };
    slug.addEventListener('input', check);
    const name = el('input', { value: c?.name ?? org?.name ?? '', maxlength: '60', required: true });
    const desc = el('textarea', { rows: 3, maxlength: '600', value: c?.description ?? '' });
    const isPublic = el('input', { type: 'checkbox' }); isPublic.checked = c ? c.public : true;
    const theme = el('select', {}, ...[...new Set(v.themes.map((t) => t.group))].map((g) => el('optgroup', { label: g }, ...v.themes.filter((t) => t.group === g).map((t) => el('option', { value: t.id, selected: t.id === look.theme || undefined, text: t.label })))));
    const accent = el('input', { type: 'color', value: look.accent ?? v.themes.find((t) => t.id === look.theme)?.accent ?? '#4fb3ff' });
    let useAccent = Boolean(look.accent);
    accent.addEventListener('input', () => (useAccent = true));
    const links = el('textarea', { rows: 3, placeholder: 'One per line: Label | https://…\nInstagram | https://instagram.com/ourclub', value: (look.links ?? []).map((l) => `${l.label} | ${l.url}`).join('\n') });
    const sponsors = el('textarea', { rows: 2, placeholder: 'One sponsor per line', value: (look.sponsors ?? []).join('\n') });
    const featured = el('select', {}, el('option', { value: '', text: 'Latest event (automatic)' }), ...v.events.map((e) => el('option', { value: e.id, selected: c?.featuredTournamentId === e.id || undefined, text: e.name })));

    const save = guard(async (e) => {
      e?.preventDefault?.();
      v = await put(`/api/orgs/${id}/channel`, {
        slug: slug.value.trim().toLowerCase(), name: name.value, description: desc.value, public: isPublic.checked, featuredTournamentId: featured.value || null,
        look: {
          theme: theme.value, accent: useAccent ? accent.value : null,
          links: links.value.split('\n').map((x) => x.split('|').map((y) => y.trim())).filter(([l, u]) => l && u).map(([label, url]) => ({ label, url })),
          sponsors: sponsors.value.split('\n').map((x) => x.trim()).filter(Boolean),
        },
      });
      toast(c ? 'Brand page saved' : 'Brand page created');
      draw();
    });

    const fileIn = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, onchange: guard(async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (f.size > 1_500_000) throw new Error('The logo must be 1.5 MB or smaller.');
      v = await post(`/api/orgs/${id}/channel/logo`, { dataUrl: await readFile(f) });
      toast('Logo uploaded'); draw();
    }) });

    const eventRow = (e) => {
      const series = el('input', { value: e.series ?? '', maxlength: '60', placeholder: 'e.g. Season 2026', style: 'width:150px' });
      const starts = el('input', { type: 'datetime-local', value: localInput(e.startsAt), style: 'width:200px' });
      const saveRow = guard(async () => { await patch(`/api/tournaments/${e.id}/channel`, { series: series.value.trim() || null, startsAt: starts.value ? new Date(starts.value).toISOString() : null }); toast(`${e.name}: saved`); });
      return [
        el('a', { href: `/web/e/${e.id}`, onclick: (ev) => { ev.preventDefault(); go(`/web/e/${e.id}`); }, text: e.name }),
        e.live ? el('span', { class: 'pill live', text: 'LIVE' }) : e.wentLive ? 'Past' : 'Upcoming',
        series, starts,
        el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: (!e.hidden && e.publicWatch) || undefined, disabled: !e.publicWatch || undefined, onchange: guard(async (ev) => { await patch(`/api/tournaments/${e.id}/channel`, { hidden: !ev.target.checked }); toast(ev.target.checked ? 'Shown on the brand page' : 'Hidden from the brand page'); }) }), e.publicWatch ? 'Show' : 'Watch page off'),
        el('button', { class: 'btn small ghost', onclick: saveRow, text: 'Save' }),
      ];
    };

    view.replaceChildren(
      c ? el('div', { class: 'banner ok row' }, el('span', { style: 'flex:1' }, 'Your brand page: ', el('a', { href: c.url, target: '_blank', rel: 'noopener', text: c.url })),
        el('a', { class: 'btn small', href: c.pathUrl, target: '_blank', rel: 'noopener', text: 'Open' })) : el('div', { class: 'banner', text: 'Your own channel: what is live, what is coming, every past event and your best clips, on one page. Viewers follow it and get an email when you go live.' }),
      c ? el('div', { class: 'grid' }, el('div', { class: 'stat' }, el('div', { class: 'v', text: String(v.followers.verified) }), el('div', { class: 'l', text: 'Followers' })), stat(String(v.events.filter((e) => !e.hidden && e.publicWatch).length), 'Events shown'), stat(c.public ? 'Public' : 'Hidden', 'Search engines')) : null,
      el('form', { class: 'card', style: 'margin-top:14px;display:grid;gap:12px', onsubmit: save },
        el('div', { class: 'form' },
          el('div', {}, el('label', { text: `Address (${v.domain})` }), el('div', { class: 'row', style: 'flex-wrap:nowrap' }, slug, el('span', { class: 'small muted', text: '.' + v.domain })), slugNote),
          el('div', {}, el('label', { text: 'Channel name' }), name)),
        el('div', {}, el('label', { text: 'About (shown on the page)' }), desc),
        el('div', { class: 'form' },
          el('div', {}, el('label', { text: 'Theme' }), theme),
          el('div', {}, el('label', { text: 'Main colour' }), el('div', { class: 'row' }, accent, useAccent ? el('button', { type: 'button', class: 'btn small ghost', onclick: () => { useAccent = false; toast('Theme colour will be used when you save'); }, text: 'Use theme colour' }) : null)),
          el('div', {}, el('label', { text: 'Main player when nothing is live or coming up' }), featured)),
        el('div', { class: 'form' }, el('div', {}, el('label', { text: 'Links' }), links), el('div', {}, el('label', { text: 'Sponsors' }), sponsors)),
        el('label', { class: 'check' }, isPublic, 'Public: anyone can find it and search engines can list it (otherwise only people with the link)'),
        owner ? el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'submit', text: c ? 'Save brand page' : 'Create brand page' })) : el('p', { class: 'small muted', text: 'Only the club owner can change the brand page.' })),
      c ? el('div', { class: 'card', style: 'margin-top:14px' },
        el('div', { class: 'row' }, el('strong', { text: 'Logo' }), el('div', { class: 'sp' }),
          c.look.logoUrl ? el('img', { src: c.look.logoUrl, alt: 'Logo', style: 'height:48px;border-radius:8px;background:#fff1' }) : el('span', { class: 'small muted', text: 'No logo: your initials are shown' })),
        owner ? el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'btn', onclick: () => fileIn.click(), text: c.look.logoUrl ? 'Change logo' : 'Upload logo' }),
          c.look.logoUrl ? el('button', { class: 'btn ghost', onclick: guard(async () => { if (!(await confirmBox('Remove the logo?', 'Your initials are shown instead.', 'Remove'))) return; v = await del(`/api/orgs/${id}/channel/logo`); draw(); }), text: 'Remove' }) : null, fileIn) : null) : null,
      c ? el('div', {}, el('h2', { text: 'Events on your brand page' }),
        el('p', { class: 'small muted', text: 'Group events into a series or season, and set a start time: viewers see a countdown, and followers get an email an hour before. Followers also get an email the moment an event goes live.' }),
        table(['Event', 'State', 'Series', 'Starts', 'On the page', ''], v.events.map(eventRow), { empty: 'No events yet.' })) : null);
    if (!c) check();
  };
  draw();
}
