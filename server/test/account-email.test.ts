import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, expectOk, signup, startHarness, type Harness } from './helpers.js';

describe('V7 email (SMTP) and accounts: welcome, name, password, forgot password', () => {
  let h: Harness;
  let admin: { token: string; userId: string; orgId: string };
  const sent: any[] = [];

  before(async () => {
    h = await startHarness();
    h.app.mailer.transportFactory = () => ({ sendMail: async (m: any) => { if (m.to === 'bounce@x.test') throw new Error('550 mailbox unavailable'); sent.push(m); } });
    admin = await signup(h, 'boss@golive.test', 'Go Live HQ');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [admin.userId]);
  });
  after(async () => h.close());

  it('without SMTP: emails are recorded as not sent (welcome on sign-up)', async () => {
    const w = h.app.mailer.outbox.find((e) => e.kind === 'welcome' && e.to === 'boss@golive.test');
    assert.ok(w);
    assert.match(w.text, /Go Live HQ is set up/);
    const log = await expectOk(api(h, 'GET', '/api/admin/emails', undefined, admin.token));
    assert.equal(log.emails[0].status, 'not_sent');
  });

  it('SMTP settings: saved encrypted, password masked, test email, failures logged', async () => {
    const s = await expectOk(api(h, 'PUT', '/api/admin/email', { host: 'email-smtp.ap-south-1.amazonaws.com', port: 587, secure: false, user: 'AKIAEXAMPLE', pass: 'smtp-secret-123456', fromName: 'Go Live', fromEmail: 'no-reply@golive.test', replyTo: 'support@golive.test', enabled: true }, admin.token));
    assert.deepEqual([s.live, s.pass], [true, 'smtp…3456']);
    const enc = (await h.db.query("SELECT value_enc FROM platform_secrets WHERE key = 'smtp'")).rows[0].value_enc;
    assert.ok(!enc.includes('smtp-secret-123456'));
    assert.equal((await expectOk(api(h, 'POST', '/api/admin/email/test', { to: 'me@golive.test' }, admin.token))).ok, true);
    assert.equal(sent.at(-1).from, '"Go Live" <no-reply@golive.test>');
    assert.equal(sent.at(-1).replyTo, 'support@golive.test');
    assert.match(sent.at(-1).html, /email is set up correctly/);
    const bad = await expectOk(api(h, 'POST', '/api/admin/email/test', { to: 'bounce@x.test' }, admin.token));
    assert.deepEqual([bad.ok, bad.status], [false, 'failed']);
    assert.match(bad.error, /550/);
    // Keeping the saved password when the field is left empty.
    await expectOk(api(h, 'PUT', '/api/admin/email', { host: 'email-smtp.ap-south-1.amazonaws.com', port: 587, secure: false, user: 'AKIAEXAMPLE', fromName: 'Go Live', fromEmail: 'no-reply@golive.test', enabled: true }, admin.token));
    assert.equal(h.app.mailer.saved!.pass, 'smtp-secret-123456');
  });

  it('welcome email once; name change; password change signs other devices out', async () => {
    const u = await signup(h, 'rahul@dlf.test', 'DLF Golf Club');
    assert.equal(sent.filter((m) => m.to === 'rahul@dlf.test' && /Welcome/.test(m.subject)).length, 1);
    await expectOk(api(h, 'PATCH', '/api/me', { name: 'Rahul Kumar' }, u.token));
    assert.equal((await expectOk(api(h, 'GET', '/api/me', undefined, u.token))).principal.name, 'Rahul Kumar');
    assert.equal((await api(h, 'POST', '/api/me/password', { currentPassword: 'wrong', newPassword: 'newpass123' }, u.token)).body.error.code, 'wrong_password');
    const r = await expectOk(api(h, 'POST', '/api/me/password', { currentPassword: 'password123', newPassword: 'newpass123' }, u.token));
    assert.equal((await api(h, 'GET', '/api/me', undefined, u.token)).status, 401, 'old session ended');
    await expectOk(api(h, 'GET', '/api/me', undefined, r.token));
    await expectOk(api(h, 'POST', '/api/auth/login', { email: 'rahul@dlf.test', password: 'newpass123' }));
  });

  it('forgot password: same answer for unknown emails, one-use 1-hour link, limited', async () => {
    const unknown = await expectOk(api(h, 'POST', '/api/auth/forgot', { email: 'nobody@x.test' }));
    const known = await expectOk(api(h, 'POST', '/api/auth/forgot', { email: 'Rahul@DLF.test' }));
    assert.equal(unknown.message, known.message, 'does not reveal who has an account');
    const mail = sent.filter((m) => m.to === 'rahul@dlf.test' && /Reset/.test(m.subject)).at(-1);
    const token = /reset-password\?token=([\w-]+)/.exec(mail.text)![1];
    assert.equal((await api(h, 'POST', '/api/auth/reset', { token, password: 'short' })).status, 400);
    await expectOk(api(h, 'POST', '/api/auth/reset', { token, password: 'resetpass123' }));
    assert.equal((await api(h, 'POST', '/api/auth/reset', { token, password: 'again12345' })).body.error.code, 'reset_link_invalid', 'one use');
    await expectOk(api(h, 'POST', '/api/auth/login', { email: 'rahul@dlf.test', password: 'resetpass123' }));
    await api(h, 'POST', '/api/auth/forgot', { email: 'rahul@dlf.test' });
    await api(h, 'POST', '/api/auth/forgot', { email: 'rahul@dlf.test' });
    const before = sent.length;
    await api(h, 'POST', '/api/auth/forgot', { email: 'rahul@dlf.test' });
    assert.equal(sent.length, before, '3 links an hour at most');
    const page = await fetch(`${h.baseUrl}/reset-password?token=abc`).then((r) => r.text());
    assert.match(page, /Choose a new password|Reset your password/);
    assert.match(await fetch(`${h.baseUrl}/login`).then((r) => r.text()), /href="\/reset-password"/);
  });
});
