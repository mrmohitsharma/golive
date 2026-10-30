import { get, post, patch, del, el, facts, table, when, ago, dialog, confirmBox, toast, guard, go, logInAs } from './core.js';
import { ROLE_LABELS } from './labels.js';
import { showPassword } from './admin-users.js';

export const title = 'User';

export async function render(view, { id }) {
  const load = async () => {
    const { user: u, audit } = await get('/api/admin/users/' + id);
    document.getElementById('title').textContent = u.name;
    const reload = () => load().catch((e) => toast(e.message, true));
    view.replaceChildren(
      u.disabled ? el('div', { class: 'banner bad', text: 'This account is disabled: it cannot log in or use the app.' }) : null,
      facts([['Email', u.email], ['Login', u.login], ['Last login', ago(u.lastLoginAt)], ['Joined', when(u.createdAt)], ['Access', u.platformAdmin ? 'Go Live administrator' : 'Club user']]),
      el('h2', { text: 'Actions' }),
      el('div', { class: 'row' },
        !u.platformAdmin && !u.disabled ? el('button', { class: 'btn', onclick: guard(() => logInAs(u.id)), text: 'Log in as' }) : null,
        el('button', { class: 'btn', onclick: guard(async () => {
          const v = await dialog({ title: 'Edit user', fields: [{ name: 'name', label: 'Name', value: u.name, required: true }, { name: 'email', label: 'Email', type: 'email', value: u.email, required: true }] });
          if (!v) return; await patch('/api/admin/users/' + id, v); toast('Saved'); reload();
        }), text: 'Edit' }),
        el('button', { class: 'btn', onclick: guard(async () => {
          if (!(await confirmBox('Reset password?', 'A new one-time password is created, and they are signed out everywhere.', 'Reset', false))) return;
          const r = await post(`/api/admin/users/${id}/reset-password`); showPassword(u.email, r.password);
        }), text: 'Reset password' }),
        el('button', { class: 'btn', onclick: guard(async () => { await post(`/api/admin/users/${id}/sign-out`); toast('Signed out of all devices'); }), text: 'Sign out everywhere' }),
        el('button', { class: 'btn', onclick: guard(async () => {
          const make = !u.platformAdmin;
          if (!(await confirmBox(make ? 'Make Go Live admin?' : 'Remove admin access?', make ? `${u.email} will be able to see and change everything on the platform.` : `${u.email} will lose admin access at once.`, make ? 'Make admin' : 'Remove', !make))) return;
          await patch('/api/admin/users/' + id, { platformAdmin: make }); toast('Saved'); reload();
        }), text: u.platformAdmin ? 'Remove admin access' : 'Make admin' }),
        el('button', { class: 'btn ' + (u.disabled ? '' : 'danger'), onclick: guard(async () => {
          if (!u.disabled && !(await confirmBox('Disable this account?', 'They are signed out everywhere and cannot log in until enabled again.', 'Disable'))) return;
          await patch('/api/admin/users/' + id, { disabled: !u.disabled }); toast(u.disabled ? 'Enabled' : 'Disabled'); reload();
        }), text: u.disabled ? 'Enable' : 'Disable' }),
        el('button', { class: 'btn danger', onclick: guard(async () => {
          if (!(await confirmBox('Delete account?', `This permanently deletes ${u.email} (data deletion request). Their clubs stay if they have another owner.`, 'Delete forever'))) return;
          await del('/api/admin/users/' + id); toast('Account deleted'); go('/web/admin/users');
        }), text: 'Delete' })),
      el('h2', { text: 'Clubs' }),
      table(['Club', 'Role'], u.clubs.map((c) => [el('strong', { text: c.name }), ROLE_LABELS[c.role]]), { onclick: (i) => go('/web/admin/clubs/' + u.clubs[i].id), empty: 'Not in any club.' }),
      el('h2', { text: 'Admin activity involving this user' }),
      table(['When', 'Admin', 'Action'], audit.map((a) => [when(a.at), a.actor + (a.asUser ? ` (as ${a.asUser})` : ''), el('span', { class: 'mono small', text: a.action })]), { empty: 'None.' }));
  };
  await load();
}
