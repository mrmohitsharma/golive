import { get, post, patch, del, api, el, stat, table, inr, num, when, day, dialog, confirmBox, toast, guard, go, logInAs } from './core.js';
import { PRICING_LABELS, TX_LABELS, ROLE_LABELS, FEATURE_LABELS } from './labels.js';

export const title = 'Club';

export async function render(view, { id }) {
  const load = async () => {
    const [c, x] = await Promise.all([get('/api/admin/orgs/' + id), get(`/api/admin/orgs/${id}/extra`)]);
    document.getElementById('title').textContent = c.org.name;
    const reload = () => load().catch((e) => toast(e.message, true));
    const owner = c.members.find((m) => m.role === 'owner');

    const actions = el('div', { class: 'row' },
      owner ? el('button', { class: 'btn', onclick: guard(() => logInAs(owner.userId)), text: 'Log in as owner' }) : null,
      el('button', { class: 'btn', onclick: guard(async () => {
        const v = await dialog({ title: 'Add or remove credits', text: 'Use a minus number to deduct. The club sees this in its wallet history.', fields: [
          { name: 'credits', label: 'Credits', type: 'number', step: '0.01', required: true }, { name: 'note', label: 'Reason (shown to the club)', required: true, placeholder: 'Launch offer' }] });
        if (!v) return; await post(`/api/admin/orgs/${id}/credits`, v); toast('Wallet updated'); reload();
      }), text: 'Add / deduct credits' }),
      el('button', { class: 'btn', onclick: guard(async () => {
        const v = await dialog({ title: 'Rename club', fields: [{ name: 'name', label: 'Club name', value: c.org.name, required: true }] });
        if (!v) return; await patch('/api/admin/orgs/' + id, v); toast('Renamed'); reload();
      }), text: 'Rename' }),
      c.suspended
        ? el('button', { class: 'btn', onclick: guard(async () => { await patch(`/api/admin/orgs/${id}/billing`, { suspended: false, suspendedReason: null }); toast('Club unsuspended'); reload(); }), text: 'Unsuspend' })
        : el('button', { class: 'btn danger', onclick: guard(async () => {
            const v = await dialog({ title: 'Suspend club', text: 'They cannot go live, and live broadcasts end at once.', ok: 'Suspend', danger: true, fields: [{ name: 'suspendedReason', label: 'Reason (shown to the club)', required: true }] });
            if (!v) return; await patch(`/api/admin/orgs/${id}/billing`, { suspended: true, suspendedReason: v.suspendedReason }); toast('Club suspended'); reload();
          }), text: 'Suspend' }),
      el('button', { class: 'btn danger', onclick: guard(async () => {
        const v = await dialog({ title: 'Delete club', text: 'This deletes the club, all its events, wallet history and viewer data. It cannot be undone.', ok: 'Delete forever', danger: true, fields: [{ name: 'confirmName', label: `Type “${c.org.name}” to confirm`, required: true }] });
        if (!v) return; await api('DELETE', '/api/admin/orgs/' + id, v); toast('Club deleted'); go('/web/admin/clubs');
      }), text: 'Delete' }));

    const members = table(['Name', 'Email', 'Role', ''], c.members.map((m) => [m.name, m.email,
      el('select', { onchange: guard(async (e) => {
        if (e.target.value === 'owner') { await post(`/api/admin/orgs/${id}/transfer`, { userId: m.userId }); toast('Ownership transferred'); }
        else { await patch(`/api/orgs/${id}/members/${m.userId}`, { role: e.target.value }); toast('Role changed'); }
        reload();
      }) }, Object.entries(ROLE_LABELS).map(([k, v]) => el('option', { value: k, selected: k === m.role || undefined, text: v }))),
      el('span', { class: 'row' },
        el('button', { class: 'btn small', onclick: () => go('/web/admin/users/' + m.userId), text: 'User' }),
        el('button', { class: 'btn small danger', onclick: guard(async () => {
          if (!(await confirmBox('Remove from club?', `${m.email} loses access to ${c.org.name}.`, 'Remove'))) return;
          await del(`/api/orgs/${id}/members/${m.userId}`); toast('Removed'); reload();
        }), text: 'Remove' }))]), { empty: 'No members.' });

    const features = el('div', { class: 'card' }, Object.entries(FEATURE_LABELS).map(([k, label]) => {
      const box = el('input', { type: 'checkbox' }); box.checked = x.features[k];
      box.onchange = guard(async () => { await patch('/api/admin/orgs/' + id, { features: { [k]: box.checked } }); toast(`${label}: ${box.checked ? 'on' : 'off'}`); });
      return el('label', { class: 'check', style: 'margin:6px 0' }, box, label);
    }));

    const pricingForm = el('form', { class: 'form', onsubmit: guard(async (e) => {
      e.preventDefault();
      const overrides = {};
      for (const k of Object.keys(PRICING_LABELS)) { const v = e.target.elements[k].value.trim(); if (v !== '') overrides[k] = Number(v); }
      await patch(`/api/admin/orgs/${id}/billing`, { overrides }); toast('Club pricing saved'); reload();
    }) }, Object.entries(PRICING_LABELS).map(([k, label]) => el('div', {}, el('label', { text: label }),
      el('input', { name: k, type: 'number', step: 'any', min: 0, value: c.overrides[k] ?? '', placeholder: `Platform: ${c.platformPricing[k]}` }))),
      el('div', {}, el('button', { class: 'btn primary', text: 'Save club pricing' })));

    const notes = el('textarea', { rows: 3, value: x.notes ?? '', placeholder: 'Private notes for the Go Live team' });
    view.replaceChildren(
      c.suspended ? el('div', { class: 'banner bad', text: `Suspended: ${c.suspendedReason ?? 'no reason given'}` }) : null,
      el('div', { class: 'grid' }, stat(num(c.balance), 'Credits'), stat(c.tournaments.length, 'Events'), stat(c.members.length, 'Members'),
        stat(inr(c.payments.filter((p) => p.status === 'paid').reduce((s, p) => s + p.amountInr, 0)), 'Paid (last 50 payments)'), stat(day(c.org.createdAt), 'Joined')),
      el('h2', { text: 'Actions' }), actions,
      el('h2', { text: 'Team' }), members,
      el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn small', onclick: guard(async () => {
        const v = await dialog({ title: 'Add member', fields: [{ name: 'email', label: 'Email of an existing account', type: 'email', required: true },
          { name: 'role', label: 'Role', type: 'select', value: 'director', options: Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label })) }] });
        if (!v) return; await post(`/api/admin/orgs/${id}/members`, v); toast('Member added'); reload();
      }), text: 'Add member' })),
      el('h2', { text: 'Events' }),
      table(['Event', 'Date', { t: 'Cameras', n: true }, { t: 'Live min', n: true }, { t: 'Paid min', n: true }, ''], c.tournaments.map((t) => [
        el('strong', { text: t.name }), day(t.startsOn), t.cameras, t.liveMinutes, t.paidMinutes,
        el('span', { class: 'row' }, t.liveNow ? el('span', { class: 'pill live', text: 'LIVE' }) : null, t.archived ? el('span', { class: 'pill', text: 'Archived' }) : null,
          el('a', { class: 'btn small', href: '/web/e/' + t.id, text: 'Open' }))]), { empty: 'No events yet.' }),
      el('h2', { text: 'Features' }), features,
      el('h2', { text: 'Pricing for this club' }), el('p', { class: 'small muted', text: 'Leave a field empty to use the platform price.' }), el('div', { class: 'card' }, pricingForm),
      el('h2', { text: 'Wallet history' }),
      table(['When', 'What', 'Event', { t: 'Qty', n: true }, { t: 'Credits', n: true }, 'Note', 'By'], c.transactions.map((t) => [
        when(t.at), TX_LABELS[t.kind] ?? t.kind, t.tournamentName ?? '–', t.quantity ?? '', el('span', { style: `color:${t.credits < 0 ? 'var(--bad)' : '#7ee0a6'}`, text: num(t.credits) }), t.note ?? '', el('span', { class: 'small muted', text: t.by ?? '' })]), { empty: 'No wallet activity.' }),
      el('h2', { text: 'Payments' }),
      table(['When', 'Order', { t: 'Amount', n: true }, { t: 'Credits', n: true }, 'Status'], c.payments.map((p) => [when(p.createdAt), el('span', { class: 'mono', text: p.orderId }), inr(p.amountInr), num(p.credits),
        el('span', { class: 'pill ' + (p.status === 'paid' ? 'ok' : p.status === 'failed' ? 'bad' : 'warn'), text: p.status })]), { empty: 'No payments.' }),
      el('h2', { text: 'Billing details' }),
      el('div', { class: 'card small' }, `${c.details.name ?? '–'} · ${c.details.email ?? '–'} · ${c.details.phone ?? '–'} · GSTIN ${c.details.gstin ?? '–'}`),
      el('h2', { text: 'Admin notes' }),
      el('div', {}, notes, el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn small', onclick: guard(async () => { await patch('/api/admin/orgs/' + id, { notes: notes.value.trim() || null }); toast('Notes saved'); }), text: 'Save notes' }))),
      el('h2', { text: 'Recent admin actions' }),
      table(['When', 'Admin', 'Action'], x.audit.map((a) => [when(a.at), a.actor + (a.asUser ? ` (as ${a.asUser})` : ''), el('span', { class: 'mono small', text: a.action })]), { empty: 'None yet.' }));
  };
  await load();
}
