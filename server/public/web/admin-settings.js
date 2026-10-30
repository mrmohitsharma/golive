import { get, put, post, patch, del, el, stat, table, day, confirmBox, toast, guard, go } from './core.js';

export const title = 'Settings';
const COSTS = { fixedMonthlyInr: 'Fixed servers per month (₹)', cloudEngineInrPerHour: 'Cloud engine per hour (₹)', cameraInrPerHour: 'Bandwidth per camera-hour (₹)', smsInr: 'One SMS (₹)', usdInr: '₹ per US$' };

export async function render(view) {
  const [p, g, admins] = await Promise.all([get('/api/admin/platform'), get('/api/admin/golive-channel'), get('/api/admin/users?filter=admins')]);
  const signup = el('input', { type: 'checkbox' }); signup.checked = p.signupEnabled;
  signup.onchange = guard(async () => { await put('/api/admin/platform', { signupEnabled: signup.checked }); toast(signup.checked ? 'Sign-up is open' : 'Sign-up is closed: only admins and club owners can add people'); });
  const costForm = el('form', { class: 'card form', onsubmit: guard(async (e) => {
    e.preventDefault();
    await put('/api/admin/platform', { costs: Object.fromEntries(Object.keys(COSTS).map((k) => [k, Number(e.target.elements[k].value)])) }); toast('Costs saved');
  }) }, Object.entries(COSTS).map(([k, l]) => el('div', {}, el('label', { text: l }), el('input', { name: k, type: 'number', step: 'any', min: 0, value: p.costs[k] }))), el('div', {}, el('button', { class: 'btn primary', text: 'Save costs' })));
  const c = g.channel;
  const connect = guard(async () => { const r = await post('/api/admin/golive-channel/connect'); window.open(r.url, '_blank', 'noopener'); toast('Finish the Google sign-in in the new tab, then refresh.'); });
  view.append(
    el('h2', { text: 'Sign-up' }),
    el('div', { class: 'card' }, el('label', { class: 'check' }, signup, 'Anyone can sign up and create a club (self-serve)'),
      el('p', { class: 'small muted', text: `When off, new accounts are made only by admins (Users > Add user) or by club owners adding their team. Server default: ${p.signupFromConfig ? 'open' : 'closed'}.` })),
    el('h2', { text: 'Go Live YouTube channel' }),
    el('div', { class: 'card' },
      !g.youtubeConfigured ? el('p', { class: 'muted', text: 'YouTube is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).' })
      : !c ? el('div', {}, el('p', { class: 'muted', text: 'Not connected. Connect a YouTube channel you own: clubs without YouTube can then go live on it (unlisted broadcasts).' }), el('button', { class: 'btn primary', onclick: connect, text: 'Connect the Go Live channel' }))
      : el('div', {}, el('p', {}, el('strong', { text: c.channelTitle }), ' ', el('span', { class: 'pill ' + (c.enabled ? 'ok' : 'warn'), text: c.enabled ? 'On' : 'Off' }), el('span', { class: 'muted', text: ' · connected ' + day(c.connectedAt) })),
          el('div', { class: 'row' },
            el('button', { class: 'btn', onclick: guard(async () => { await patch('/api/admin/golive-channel', { enabled: !c.enabled }); go('/web/admin/settings'); }), text: c.enabled ? 'Switch off for new events' : 'Switch on' }),
            el('button', { class: 'btn', onclick: connect, text: 'Reconnect' }),
            el('button', { class: 'btn danger', onclick: guard(async () => { if (!(await confirmBox('Disconnect the Go Live channel?', 'Events using it fall back to their own channel or a stream key.', 'Disconnect'))) return; await del('/api/admin/golive-channel'); go('/web/admin/settings'); }), text: 'Disconnect' })))),
    el('h2', { text: 'Running costs (for the margin in System)' }), costForm,
    el('h2', { text: 'Go Live administrators' }),
    table(['Name', 'Email', 'Last login'], admins.users.map((u) => [u.name, u.email, day(u.lastLoginAt)]), { onclick: (i) => go('/web/admin/users/' + admins.users[i].id) }),
    el('p', { class: 'small muted', text: 'To add an admin, open the user under Users and choose “Make admin”.' }),
    el('h2', { text: 'This server' }),
    el('div', { class: 'grid' }, stat(p.brand, 'Brand'), stat(p.billingEnabled ? 'On' : 'Off', 'Billing'), stat(p.cloudAvailable ? 'Available' : 'Off', 'Cloud production'), stat(p.youtube ? 'Configured' : 'Not set', 'YouTube API')),
    el('p', { class: 'small muted' }, `Public address ${p.publicBaseUrl} · support ${p.supportEmail ?? '(not set)'} · legal entity ${p.legalEntity ?? '(not set)'} · event types: ${p.eventTypes.map((e) => e.name).join(', ')}. These come from the server config.`));
}
