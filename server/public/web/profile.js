import { state, post, el, confirmBox, toast, signOut, guard } from './core.js';

export const title = 'Profile';

export async function render(view) {
  const me = state.me;
  view.append(
    el('div', { class: 'card' },
      el('div', { class: 'form' },
        el('div', {}, el('label', { text: 'Name' }), el('div', { text: me.name })),
        el('div', {}, el('label', { text: 'Email' }), el('div', { text: me.email })),
        el('div', {}, el('label', { text: 'Access' }), el('div', { text: me.platformAdmin ? 'Go Live administrator' : 'Club member' }))),
      el('h2', { text: 'Clubs' }),
      el('ul', {}, state.orgs.map((o) => el('li', { text: `${o.name} · ${o.role}` }))),
      el('h2', { text: 'Security' }),
      el('div', { class: 'row' },
        el('button', { class: 'btn danger', disabled: Boolean(state.impersonating), onclick: guard(async () => {
          if (!(await confirmBox('Sign out of all devices?', 'You will be signed out here, in other browsers and in the app.'))) return;
          await post('/api/me/sign-out-everywhere');
          toast('Signed out everywhere');
          signOut(true);
        }), text: 'Sign out of all devices' }))));
}
