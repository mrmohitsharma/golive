import { state, get, post, patch, del, el, table, dialog, confirmBox, toast, guard, go } from './core.js';
import { ROLE_LABELS } from './labels.js';

export const title = 'Team';

export async function render(view) {
  const org = state.orgs.find((o) => o.id === state.orgId);
  const { members } = await get(`/api/orgs/${state.orgId}/members`);
  const reload = () => go('/web/team');
  view.append(
    el('p', { class: 'muted', text: `People with an account in ${org?.name ?? 'your club'}. For one event only, share the event's invite links instead: no account needed.` }),
    el('div', { class: 'row', style: 'margin-bottom:12px' }, el('div', { class: 'sp' }), el('button', { class: 'btn primary', onclick: guard(async () => {
      const v = await dialog({ title: 'Add to the team', text: 'If they have no account yet, give a name and a first password to share with them.', ok: 'Add', fields: [
        { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'role', label: 'Role', type: 'select', value: 'director', options: Object.entries(ROLE_LABELS).filter(([k]) => k !== 'owner').map(([value, label]) => ({ value, label })) },
        { name: 'name', label: 'Name (new accounts)' }, { name: 'password', label: 'First password, 8+ characters (new accounts)', type: 'password' }] });
      if (!v) return;
      const r = await post(`/api/orgs/${state.orgId}/members`, { email: v.email, role: v.role, name: v.name || undefined, password: v.password || undefined });
      toast(r.created ? 'Account created and added' : 'Added'); reload();
    }), text: 'Add person' })),
    table(['Name', 'Email', 'Role', ''], members.map((m) => [m.name, m.email,
      m.role === 'owner' ? el('strong', { text: 'Owner' }) : el('select', { onchange: guard(async (e) => { await patch(`/api/orgs/${state.orgId}/members/${m.userId}`, { role: e.target.value }); toast('Role changed'); }) },
        Object.entries(ROLE_LABELS).filter(([k]) => k !== 'owner').map(([k, l]) => el('option', { value: k, selected: k === m.role || undefined, text: l }))),
      m.role === 'owner' || m.userId === state.me.id ? '' : el('button', { class: 'btn small danger', onclick: guard(async () => {
        if (!(await confirmBox('Remove from the team?', `${m.email} loses access to ${org?.name}.`, 'Remove'))) return;
        await del(`/api/orgs/${state.orgId}/members/${m.userId}`); reload();
      }), text: 'Remove' })]), { empty: 'Only you so far.' }),
    el('h2', { text: 'What each role can do' }),
    table(['Role', 'Can'], [['Owner', 'Everything, including the wallet, team and connected accounts'], ['Director', 'Create and run events: cameras, go live, games, influencers'], ['Scorer', 'Enter scores'], ['Commentator', 'Talk on the stream'], ['Camera', 'Use their phone as a camera']]));
}
