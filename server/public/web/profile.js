import { state, post, patch, el, confirmBox, toast, signOut, guard, store, go } from './core.js';

export const title = 'Profile';

export async function render(view) {
  const me = state.me;
  const name = el('input', { value: me.name, maxlength: 80 });
  const cur = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Current password (leave empty if you only use Google)' });
  const pw1 = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'New password, 8+ characters' });
  const pw2 = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Repeat new password' });
  view.append(
    el('div', { class: 'card' },
      el('div', { class: 'form' },
        el('div', {}, el('label', { text: 'Name' }), name),
        el('div', {}, el('label', { text: 'Email' }), el('div', { style: 'padding:8px 0', text: me.email })),
        el('div', {}, el('button', { class: 'btn primary', onclick: guard(async () => { await patch('/api/me', { name: name.value.trim() }); state.me.name = name.value.trim(); toast('Name saved'); }), text: 'Save name' }))),
      el('p', { class: 'small muted', text: `Access: ${me.platformAdmin ? 'Go Live administrator' : 'Club member'} · Clubs: ${state.orgs.map((o) => `${o.name} (${o.role})`).join(', ') || 'none'}` })),
    el('h2', { text: 'Password' }),
    el('div', { class: 'card' },
      el('div', { class: 'form' }, el('div', {}, cur), el('div', {}, pw1), el('div', {}, pw2),
        el('div', {}, el('button', { class: 'btn primary', disabled: Boolean(state.impersonating), onclick: guard(async () => {
          if (pw1.value.length < 8) throw new Error('Use at least 8 characters.');
          if (pw1.value !== pw2.value) throw new Error('The two new passwords are different.');
          const r = await post('/api/me/password', { currentPassword: cur.value || undefined, newPassword: pw1.value });
          state.token = r.token; store.set('baas.token', r.token);
          cur.value = pw1.value = pw2.value = '';
          toast('Password changed. Other devices are signed out.');
        }), text: 'Change password' }))),
      el('p', { class: 'small muted', text: 'Changing your password signs you out of your other browsers and the app.' })),
    el('h2', { text: 'Security' }),
    el('div', { class: 'row' },
      el('button', { class: 'btn danger', disabled: Boolean(state.impersonating), onclick: guard(async () => {
        if (!(await confirmBox('Sign out of all devices?', 'You will be signed out here, in other browsers and in the app.'))) return;
        await post('/api/me/sign-out-everywhere');
        toast('Signed out everywhere');
        signOut(true);
      }), text: 'Sign out of all devices' })));
}
