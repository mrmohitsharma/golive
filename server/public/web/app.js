// Go Live web app: boot, menu by role, routing. Pages live in their own modules.
import { state, store, get, post, el, go, toast, signOut, when } from './core.js';

/**
 * Routes: path pattern → page module and who may see it.
 * roles: 'admin' = platform admin; 'club' = owner or director of the selected club.
 */
const ROUTES = [
  { path: '/web/admin', page: 'admin-dashboard', role: 'admin', nav: ['Admin', 'Dashboard'] },
  { path: '/web/admin/live', page: 'admin-live', role: 'admin', nav: ['Admin', 'Live monitor'] },
  { path: '/web/admin/clubs', page: 'admin-clubs', role: 'admin', nav: ['Admin', 'Clubs'] },
  { path: '/web/admin/clubs/:id', page: 'admin-club', role: 'admin' },
  { path: '/web/admin/users', page: 'admin-users', role: 'admin', nav: ['Admin', 'Users'] },
  { path: '/web/admin/users/:id', page: 'admin-user', role: 'admin' },
  { path: '/web/admin/events', page: 'admin-events', role: 'admin', nav: ['Admin', 'Events'] },
  { path: '/web/admin/money', page: 'admin-money', role: 'admin', nav: ['Admin', 'Money'] },
  { path: '/web/admin/money/:tab', page: 'admin-money', role: 'admin' },
  { path: '/web/admin/support', page: 'admin-support', role: 'admin', nav: ['Admin', 'Support'] },
  { path: '/web/admin/support/:id', page: 'admin-support', role: 'admin' },
  { path: '/web/admin/viewership', page: 'admin-viewership', role: 'admin', nav: ['Admin', 'Viewership'] },
  { path: '/web/admin/sms', page: 'admin-sms', role: 'admin', nav: ['Admin', 'SMS'] },
  { path: '/web/admin/email', page: 'admin-email', role: 'admin', nav: ['Admin', 'Email'] },
  { path: '/web/admin/streaming', page: 'admin-streaming', role: 'admin', nav: ['Admin', 'Streaming'] },
  { path: '/web/admin/safety', page: 'admin-safety', role: 'admin', nav: ['Admin', 'Safety'] },
  { path: '/web/admin/safety/:tab', page: 'admin-safety', role: 'admin' },
  { path: '/web/admin/reports', page: 'admin-reports', role: 'admin', nav: ['Admin', 'Reports'] },
  { path: '/web/admin/system', page: 'admin-system', role: 'admin', nav: ['Admin', 'System'] },
  { path: '/web/admin/settings', page: 'admin-settings', role: 'admin', nav: ['Admin', 'Settings'] },
  { path: '/web/admin/audit', page: 'admin-audit', role: 'admin', nav: ['Admin', 'Audit log'] },
  { path: '/web/events', page: 'club-events', role: 'club', nav: ['Club', 'Events'] },
  { path: '/web/team', page: 'club-team', role: 'owner', nav: ['Club', 'Team'] },
  { path: '/web/channels', page: 'club-channels', role: 'owner', nav: ['Club', 'Channels'] },
  { path: '/web/wallet', page: 'club-wallet', role: 'club', nav: ['Club', 'Wallet'] },
  { path: '/web/e/:id', page: 'event', role: 'any' },
  { path: '/web/e/:id/control', page: 'control', role: 'any' },
  { path: '/web/e/:id/:tab', page: 'event', role: 'any' },
  { path: '/web/profile', page: 'profile', role: 'any', nav: ['Account', 'Profile'] },
  { path: '/web/help', page: 'help', role: 'any', nav: ['Account', 'Help'] },
  { path: '/web/help/:key', page: 'help', role: 'any' },
];
export function addRoutes(list) { ROUTES.push(...list); }

const main = document.getElementById('main');
const titleEl = document.getElementById('title');
let cleanup = null;

function isAdmin() { return Boolean(state.me?.platformAdmin); }
function clubRole() { return state.orgs.find((o) => o.id === state.orgId)?.role ?? null; }
function allowed(r) {
  if (r.role === 'any') return true;
  if (r.role === 'admin') return isAdmin();
  if (r.role === 'club') return isAdmin() || ['owner', 'director'].includes(clubRole());
  if (r.role === 'owner') return isAdmin() || clubRole() === 'owner';
  return false;
}
function match(pathname) {
  for (const r of ROUTES) {
    const keys = [];
    const re = new RegExp('^' + r.path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    const m = re.exec(pathname);
    if (m) return { r, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

function renderNav() {
  const nav = document.getElementById('nav');
  const groups = new Map();
  for (const r of ROUTES) {
    if (!r.nav || !allowed(r)) continue;
    if (!groups.has(r.nav[0])) groups.set(r.nav[0], []);
    groups.get(r.nav[0]).push(r);
  }
  const here = location.pathname.replace(/\/$/, '');
  nav.replaceChildren(...[...groups].flatMap(([g, rs]) => [
    el('div', { class: 'grp', text: g }),
    ...rs.map((r) => el('a', { href: r.path, class: here === r.path || (r.path !== '/web/admin' && here.startsWith(r.path + '/')) ? 'on' : null, onclick: (e) => { e.preventDefault(); go(r.path); } , text: r.nav[1] })),
  ]));
}

async function route() {
  document.getElementById('side').classList.remove('open');
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  let path = location.pathname.replace(/\/$/, '');
  if (path === '/web' || path === '') { history.replaceState({}, '', isAdmin() ? '/web/admin' : '/web/events'); path = location.pathname; }
  const hit = match(path);
  renderNav();
  if (!hit) { titleEl.textContent = 'Not found'; main.replaceChildren(el('p', { class: 'muted', text: 'This page does not exist.' })); return; }
  if (!allowed(hit.r)) { titleEl.textContent = 'No access'; main.replaceChildren(el('div', { class: 'banner warn', text: 'You do not have access to this page.' })); return; }
  main.replaceChildren(el('p', { class: 'muted', text: 'Loading…' }));
  try {
    const mod = await import(`./${hit.r.page}.js`);
    titleEl.textContent = typeof mod.title === 'function' ? mod.title(hit.params) : mod.title;
    document.title = titleEl.textContent + ' · Go Live';
    const view = el('div');
    cleanup = (await mod.render(view, hit.params)) || null;
    main.replaceChildren(view);
  } catch (e) {
    main.replaceChildren(el('div', { class: 'banner bad', text: e.message || String(e) }));
  }
}

function renderOrgSwitch() {
  const sel = document.getElementById('org');
  const mine = state.orgs.filter((o) => ['owner', 'director'].includes(o.role));
  sel.hidden = mine.length < 2;
  sel.replaceChildren(...mine.map((o) => el('option', { value: o.id, selected: o.id === state.orgId || undefined, text: `${o.name} · ${o.role}` })));
  sel.onchange = () => { state.orgId = sel.value; store.set('gl.org', sel.value); route(); };
}

function renderImpersonation() {
  const bar = document.getElementById('imp');
  if (!state.impersonating) { bar.hidden = true; return; }
  const ends = store.get('gl.impEnds');
  bar.hidden = false;
  bar.replaceChildren(
    el('span', { text: `Support mode: you are logged in as ${state.me.email}${ends ? ` until ${when(ends)}` : ''}. Everything you change is recorded.` }),
    el('button', { class: 'btn small', onclick: async () => { try { await post('/api/impersonation/stop'); } catch {} signOut(); }, text: 'Back to admin' }));
}

async function boot() {
  state.token = store.get('baas.token');
  if (!state.token) return signOut(true);
  let me;
  try { me = await get('/api/me'); } catch { return; }
  if (me.principal.kind !== 'user') return signOut(true);
  state.me = me.principal;
  state.orgs = me.orgs;
  state.impersonating = me.principal.impersonatedBy || null;
  const saved = store.get('gl.org');
  const manageable = state.orgs.filter((o) => ['owner', 'director'].includes(o.role));
  state.orgId = manageable.find((o) => o.id === saved)?.id ?? manageable[0]?.id ?? state.orgs[0]?.id ?? null;
  document.getElementById('who').textContent = `${state.me.name} · ${state.me.email}${state.me.platformAdmin ? ' · Admin' : ''}`;
  document.getElementById('logout').onclick = () => signOut();
  document.getElementById('menu').onclick = () => document.getElementById('side').classList.toggle('open');
  renderOrgSwitch();
  renderImpersonation();
  if (!isAdmin() && !manageable.length && !location.pathname.startsWith('/web/help') && location.pathname !== '/web/profile') {
    main.replaceChildren(el('div', { class: 'banner warn' }, 'Your account is a camera, scorer or commentator. Use the Go Live app on your phone, or ask your club owner to make you a director.'));
    titleEl.textContent = 'Go Live';
    return;
  }
  window.addEventListener('popstate', route);
  window.addEventListener('gl:route', route);
  route();
}

export { toast };
boot();
