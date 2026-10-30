// Shared pieces for support tickets (Help and Admin > Support).
import { state, el, when } from './core.js';

export const CATEGORY = { streaming: 'Streaming or cameras', billing: 'Payments and credits', account: 'Account', bug: 'Something broken', question: 'Question', other: 'Other' };
export const PRIORITY = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };
export const STATUS = { open: 'Open', pending: 'Waiting for customer', resolved: 'Resolved', closed: 'Closed' };
export const statusPill = (s) => el('span', { class: 'pill ' + ({ open: 'warn', pending: '', resolved: 'ok', closed: '' }[s] ?? ''), text: STATUS[s] ?? s });
export const priorityPill = (p) => el('span', { class: 'pill ' + ({ urgent: 'live', high: 'bad', normal: '', low: '' }[p] ?? ''), text: PRIORITY[p] ?? p });

/** Reads chosen files as data URLs (5 files, 5 MB each). */
export async function readFiles(input) {
  return Promise.all([...(input.files ?? [])].slice(0, 5).map((f) => {
    if (f.size > 5 * 1024 * 1024) throw new Error(`${f.name} is over 5 MB.`);
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res({ name: f.name, type: f.type, data: r.result }); r.onerror = rej; r.readAsDataURL(f); });
  }));
}
export const fileInput = () => el('input', { type: 'file', multiple: true, accept: 'image/png,image/jpeg,image/webp,image/gif,application/pdf' });

/** The conversation. fileUrl(file) gives each attachment's address. */
export function thread(messages, fileUrl) {
  return el('div', {}, messages.map((m) => el('div', { class: 'tk-msg ' + m.kind + (m.internal ? ' internal' : '') },
    el('div', { class: 'small muted' }, m.kind === 'team' ? `${m.author} · Go Live team` : m.kind === 'system' ? 'Change' : m.author, ` · ${when(m.at)}`, m.internal && m.kind !== 'system' ? el('span', { class: 'pill warn', style: 'margin-left:6px', text: 'Internal note' }) : null),
    el('div', { class: 'tk-body', text: m.body }),
    m.files.length ? el('div', { class: 'row', style: 'margin-top:6px' }, m.files.map((f) => el('a', { class: 'btn small', href: fileUrl(f), target: '_blank', rel: 'noopener', text: `📎 ${f.name}` }))) : null)));
}
export const tokenQ = () => `token=${encodeURIComponent(state.token)}`;
