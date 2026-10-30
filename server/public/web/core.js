// Shared helpers for the Go Live web app: session, API calls, DOM, formatting, dialogs.
export const state = { token: null, me: null, orgs: [], orgId: null, impersonating: null };

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
export { store };

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export async function api(method, url, body) {
  const headers = { accept: 'application/json' };
  if (state.token) headers.authorization = 'Bearer ' + state.token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { signOut(true); throw new ApiError(401, 'unauthorized', 'Your session ended. Log in again.'); }
  if (!r.ok) throw new ApiError(r.status, data?.error?.code ?? 'error', data?.error?.message ?? `Request failed (${r.status})`);
  return data;
}
export const get = (u) => api('GET', u);
export const post = (u, b = {}) => api('POST', u, b);
export const put = (u, b = {}) => api('PUT', u, b);
export const patch = (u, b = {}) => api('PATCH', u, b);
export const del = (u) => api('DELETE', u);

/** Downloads a file from an authenticated URL (CSV exports). */
export async function download(url, name) {
  const r = await fetch(url, { headers: { authorization: 'Bearer ' + state.token } });
  if (!r.ok) throw new Error('Download failed');
  const a = el('a', { href: URL.createObjectURL(await r.blob()), download: name });
  document.body.append(a); a.click(); a.remove();
}

export function signOut(expired = false) {
  const admin = store.get('gl.adminToken');
  if (state.impersonating && admin && !expired) { store.set('baas.token', admin); store.set('gl.adminToken', null); location.href = '/web/admin/users'; return; }
  store.set('baas.token', null); store.set('baas.session', null); store.set('gl.adminToken', null);
  location.replace('/login?next=' + encodeURIComponent(location.pathname));
}

/** el('div', {class:'x', onclick}, child, 'text', [more]) — text is always set as text, never HTML. */
export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') n.textContent = v;
    else if (k === 'class') n.className = v;
    else if (k === 'style') n.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k.nodeType ? k : String(k));
  return n;
}

let toastTimer;
export function toast(msg, err = false) {
  document.querySelector('.toast')?.remove();
  const t = el('div', { class: 'toast' + (err ? ' err' : ''), role: 'status', text: msg });
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 4000);
}

/** Wraps an async handler: shows errors as a toast instead of failing silently. */
export const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message || String(e), true); } };

/** A modal form. fields: [{name,label,type,value,options,required,hint}]. Resolves with values or null. */
export function dialog({ title, text, fields = [], ok = 'Save', danger = false }) {
  return new Promise((resolve) => {
    const body = fields.map((f) => {
      let input;
      if (f.type === 'select') input = el('select', { name: f.name }, f.options.map((o) => el('option', { value: o.value ?? o, selected: (o.value ?? o) === f.value || undefined, text: o.label ?? o })));
      else if (f.type === 'textarea') input = el('textarea', { name: f.name, rows: 3, required: f.required, value: f.value ?? '' });
      else if (f.type === 'checkbox') { input = el('input', { type: 'checkbox', name: f.name }); input.checked = Boolean(f.value); return el('label', { class: 'check' }, input, f.label); }
      else input = el('input', { name: f.name, type: f.type || 'text', required: f.required, value: f.value ?? '', step: f.step, min: f.min, placeholder: f.placeholder });
      return el('div', { style: 'margin-bottom:12px' }, el('label', { text: f.label }), input, f.hint ? el('div', { class: 'small muted', style: 'margin-top:4px', text: f.hint }) : null);
    });
    const d = el('dialog', {},
      el('h3', { text: title }), text ? el('p', { class: 'muted', text }) : null,
      el('form', { method: 'dialog' }, body,
        el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:8px' },
          el('button', { class: 'btn ghost', value: 'cancel', formnovalidate: true, text: 'Cancel' }),
          el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), value: 'ok', text: ok }))));
    document.body.append(d);
    d.addEventListener('close', () => {
      const ok = d.returnValue === 'ok';
      const out = {};
      if (ok) for (const f of fields) {
        const i = d.querySelector(`[name="${f.name}"]`);
        out[f.name] = f.type === 'checkbox' ? i.checked : f.type === 'number' ? (i.value === '' ? null : Number(i.value)) : i.value.trim();
      }
      d.remove();
      resolve(ok ? out : null);
    });
    d.showModal();
  });
}
export const confirmBox = (title, text, ok = 'Confirm', danger = true) => dialog({ title, text, ok, danger }).then((v) => v !== null);

// ---------------------------------------------------------------- formatting
export const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
export const num = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
export const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');
export const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
export const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return Math.floor(s / 86400) + ' d ago';
};
export const stat = (v, l, alert = false) => el('div', { class: 'stat' + (alert ? ' alert' : '') }, el('div', { class: 'v', text: v }), el('div', { class: 'l', text: l }));

/** table(['Name', {t:'Amount', n:true}], rows.map(r => [cells...]), {onclick: i => ...}) */
export function table(head, rows, opts = {}) {
  if (!rows.length) return el('div', { class: 'tablewrap' }, el('div', { class: 'empty', text: opts.empty ?? 'Nothing here yet.' }));
  return el('div', { class: 'tablewrap' }, el('table', {},
    el('thead', {}, el('tr', {}, head.map((h) => el('th', { class: h.n ? 'n' : null, text: h.t ?? h })))),
    el('tbody', {}, rows.map((r, i) => el('tr', { class: opts.onclick ? 'click' : null, onclick: opts.onclick ? () => opts.onclick(i) : null },
      r.map((c, j) => el('td', { class: head[j]?.n ? 'n' : null }, c)))))));
}

export const go = (path) => { history.pushState({}, '', path); window.dispatchEvent(new Event('gl:route')); };
