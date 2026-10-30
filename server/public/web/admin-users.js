import { get, post, el, table, day, ago, dialog, toast, guard, go } from './core.js';
import { ROLE_LABELS } from './labels.js';

export const title = 'Users';

export function showPassword(email, password) {
  const d = el('dialog', {}, el('h3', { text: 'One-time password' }),
    el('p', { class: 'muted', text: `Give this to ${email}. It is shown only once; they can change it after logging in.` }),
    el('div', { class: 'card mono', style: 'font-size:18px;text-align:center;user-select:all', text: password }),
    el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(password).then(() => toast('Copied')), text: 'Copy' }),
      el('button', { class: 'btn primary', onclick: () => { d.close(); d.remove(); }, text: 'Done' })));
  document.body.append(d); d.showModal();
}

export async function render(view) {
  const q = el('input', { placeholder: 'Search email or name…' });
  const filter = el('select', {}, [['all', 'Everyone'], ['admins', 'Go Live admins'], ['disabled', 'Disabled'], ['no-club', 'Not in any club']].map(([v, t]) => el('option', { value: v, text: t })));
  const list = el('div');
  const load = async () => {
    const p = new URLSearchParams({ filter: filter.value });
    if (q.value.trim()) p.set('q', q.value.trim());
    const { users } = await get('/api/admin/users?' + p);
    list.replaceChildren(el('p', { class: 'small muted', text: `${users.length} user${users.length === 1 ? '' : 's'}` }),
      table(['Name', 'Email', 'Clubs', 'Login', 'Last login', 'Joined', ''], users.map((u) => [
        el('strong', { text: u.name }), u.email,
        el('span', { class: 'small', text: u.clubs.map((c) => `${c.name} (${ROLE_LABELS[c.role]})`).join(', ') || '–' }),
        u.login, ago(u.lastLoginAt), day(u.createdAt),
        el('span', { class: 'row' }, u.platformAdmin ? el('span', { class: 'pill warn', text: 'Admin' }) : null, u.disabled ? el('span', { class: 'pill bad', text: 'Disabled' }) : null),
      ]), { onclick: (i) => go('/web/admin/users/' + users[i].id), empty: 'No users match.' }));
  };
  let t;
  q.oninput = () => { clearTimeout(t); t = setTimeout(load, 300); };
  filter.onchange = load;
  view.append(
    el('div', { class: 'row', style: 'margin-bottom:12px' }, el('div', { style: 'flex:2;min-width:220px' }, q), el('div', { style: 'flex:1;min-width:160px' }, filter),
      el('button', { class: 'btn primary', onclick: guard(async () => {
        const v = await dialog({ title: 'Add user', text: 'Creates an account with a one-time password. Add a club name to make them its owner.', ok: 'Create', fields: [
          { name: 'name', label: 'Name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'clubName', label: 'New club (optional)' }] });
        if (!v) return;
        const r = await post('/api/admin/users', { ...v, clubName: v.clubName || null });
        showPassword(r.user.email, r.password); load();
      }), text: 'Add user' })),
    list);
  await load();
}
