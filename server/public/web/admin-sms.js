import { get, put, post, del, el, stat, table, when, num, inr, dialog, confirmBox, toast, guard, go } from './core.js';

export const title = 'SMS';
const KINDS = { otp: 'Prize claim code (OTP)', reminder: '“Remind me” (stream is live)', winner: 'Winner message', draw_entry: 'Lucky draw entry' };

export async function render(view) {
  const [s, m] = await Promise.all([get('/api/admin/sms'), get('/api/admin/messages')]);
  const key = el('input', { type: 'password', placeholder: s.authKey ? `Saved (${s.authKey}); leave empty to keep` : 'MSG91 auth key' });
  const tpl = Object.fromEntries(Object.keys(KINDS).map((k) => [k, el('input', { value: s.templates[k] ?? '', placeholder: 'Flow / template id' })]));
  const st = m.stats;
  view.append(
    el('div', { class: 'grid' }, stat(s.live ? 'MSG91' : 'Test sender', 'Sending with'), stat(num(st.sentMonth), 'Sent this month'), stat(num(st.failedMonth), 'Failed this month', st.failedMonth > 0),
      stat(num(st.notSentNoCreditsMonth), 'Not sent: club out of credits'), stat(inr(st.costMonthInr), 'Estimated SMS cost this month'), stat(num(st.chargedMonthCredits), 'Credits charged to clubs')),
    !s.live ? el('div', { class: 'banner warn', text: 'No MSG91 key yet: messages are only recorded (test sender). Add the key and the 4 DLT-approved templates below.' }) : null,
    el('h2', { text: 'MSG91 settings' }),
    el('div', { class: 'card' },
      el('div', {}, el('label', { text: 'Auth key' }), key),
      el('div', { style: 'margin-top:12px', class: 'tablewrap' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: 'Message' }), el('th', { text: 'Text to register in DLT' }), el('th', { text: 'MSG91 template id' }))),
        el('tbody', {}, Object.entries(KINDS).map(([k, label]) => el('tr', {}, el('td', { text: label }), el('td', { class: 'small mono', text: s.texts[k] }), el('td', { style: 'min-width:200px' }, tpl[k])))))),
      el('div', { class: 'row', style: 'margin-top:12px' },
        el('button', { class: 'btn primary', onclick: guard(async () => {
          await put('/api/admin/sms', { authKey: key.value.trim() || undefined, templates: Object.fromEntries(Object.entries(tpl).map(([k, i]) => [k, i.value.trim() || null])) });
          toast('SMS settings saved'); go('/web/admin/sms');
        }), text: 'Save' }),
        el('button', { class: 'btn', onclick: guard(async () => {
          const v = await dialog({ title: 'Send a test SMS', text: 'Sends a sample prize claim code (123456) with the OTP template.', ok: 'Send', fields: [{ name: 'phone', label: 'Mobile number', required: true, placeholder: '98123 45678' }] });
          if (!v) return; const r = await post('/api/admin/sms/test', v);
          toast(r.ok ? `Sent to ${r.to} (${r.provider})` : `Not sent: ${r.error}`, !r.ok); go('/web/admin/sms');
        }), text: 'Send test SMS' }),
        s.source === 'admin' ? el('button', { class: 'btn danger', onclick: guard(async () => { if (!(await confirmBox('Remove saved MSG91 settings?', 'SMS falls back to the server config, or to the test sender.', 'Remove'))) return; await del('/api/admin/sms'); go('/web/admin/sms'); }), text: 'Remove saved settings' }) : null),
      el('p', { class: 'small muted', text: `Settings from: ${{ admin: 'this panel', 'server config': 'the server config', none: 'not set' }[s.source]}. The key is stored encrypted and never shown again in full.` })),
    el('h2', { text: 'Recent messages' }),
    table(['When', 'Kind', 'To', 'Event', 'Club', 'Via', 'Status'], m.messages.map((x) => [when(x.at), KINDS[x.kind] ?? x.kind, el('span', { class: 'mono', text: x.to }), x.event ?? '–', x.club ?? '–', x.provider,
      el('span', { class: 'pill ' + (x.status === 'sent' ? 'ok' : 'bad'), title: x.error ?? '', text: x.status === 'sent' ? 'Sent' : x.error === 'no_credits' ? 'No credits' : 'Failed' })]), { empty: 'No messages yet.' }));
}
