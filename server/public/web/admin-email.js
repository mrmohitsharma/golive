import { get, put, post, el, stat, table, when, dialog, toast, guard, go } from './core.js';

export const title = 'Email';
const KIND = { welcome: 'Welcome', password_reset: 'Password reset', receipt: 'Payment receipt', refund: 'Refund', low_balance: 'Low credits', suspended: 'Club suspended', ticket: 'Support ticket', test: 'Test' };

export async function render(view) {
  const [s, log] = await Promise.all([get('/api/admin/email'), get('/api/admin/emails')]);
  const f = {
    host: el('input', { value: s.host, placeholder: 'email-smtp.ap-south-1.amazonaws.com' }),
    port: el('input', { type: 'number', value: s.port }),
    user: el('input', { value: s.user, placeholder: 'SMTP username' }),
    pass: el('input', { type: 'password', placeholder: s.pass ? `Saved (${s.pass}); leave empty to keep` : 'SMTP password' }),
    fromName: el('input', { value: s.fromName }),
    fromEmail: el('input', { value: s.fromEmail, placeholder: 'no-reply@yourdomain.com' }),
    replyTo: el('input', { value: s.replyTo ?? '', placeholder: 'support@yourdomain.com' }),
  };
  const secure = el('input', { type: 'checkbox' }); secure.checked = s.secure;
  const on = el('input', { type: 'checkbox' }); on.checked = s.enabled || !s.host;
  const sent = log.emails.filter((e) => e.status === 'sent').length;
  view.append(
    el('div', { class: 'grid' }, stat(s.live ? 'On' : 'Off', 'Sending email'), stat(sent, 'Sent (last 300)'), stat(log.emails.filter((e) => e.status === 'failed').length, 'Failed (last 300)', log.emails.some((e) => e.status === 'failed'))),
    !s.live ? el('div', { class: 'banner warn', text: 'Email is not set up: password resets, receipts and ticket replies are recorded below but not sent.' }) : null,
    el('h2', { text: 'SMTP settings' }),
    el('div', { class: 'card' },
      el('p', { class: 'small muted', text: 'Recommended: Amazon SES (about $0.10 per 1,000 emails). In SES, verify your domain, create SMTP credentials, and use host email-smtp.<region>.amazonaws.com, port 587. Zoho ZeptoMail or Brevo work the same way.' }),
      el('div', { class: 'form' }, ...[['host', 'SMTP host'], ['port', 'Port (587 or 465)'], ['user', 'Username'], ['pass', 'Password'], ['fromName', 'From name'], ['fromEmail', 'From email'], ['replyTo', 'Replies go to']].map(([k, l]) => el('div', {}, el('label', { text: l }), f[k]))),
      el('div', { class: 'row', style: 'margin-top:10px' }, el('label', { class: 'check' }, secure, 'Use SSL from the start (port 465)'), el('label', { class: 'check' }, on, 'Send emails')),
      el('div', { class: 'row', style: 'margin-top:12px' },
        el('button', { class: 'btn primary', onclick: guard(async () => {
          await put('/api/admin/email', { host: f.host.value.trim(), port: Number(f.port.value), secure: secure.checked, user: f.user.value.trim(), pass: f.pass.value || undefined, fromName: f.fromName.value.trim(), fromEmail: f.fromEmail.value.trim(), replyTo: f.replyTo.value.trim(), enabled: on.checked });
          toast('Email settings saved'); go('/web/admin/email');
        }), text: 'Save' }),
        el('button', { class: 'btn', onclick: guard(async () => {
          const v = await dialog({ title: 'Send a test email', ok: 'Send', fields: [{ name: 'to', label: 'To', type: 'email', required: true }] });
          if (!v) return; const r = await post('/api/admin/email/test', v);
          toast(r.ok ? 'Test email sent' : `Not sent: ${r.error}`, !r.ok); go('/web/admin/email');
        }), text: 'Send test email' }))),
    el('h2', { text: 'Recent emails' }),
    table(['When', 'To', 'Subject', 'Type', 'Club', 'Status'], log.emails.map((e) => [when(e.at), e.to, e.subject, KIND[e.kind] ?? e.kind, e.club ?? '–',
      el('span', { class: 'pill ' + ({ sent: 'ok', failed: 'bad', not_sent: 'warn' }[e.status]), title: e.error ?? '', text: { sent: 'Sent', failed: 'Failed', not_sent: 'Not sent' }[e.status] })]), { empty: 'No emails yet.' }));
}
