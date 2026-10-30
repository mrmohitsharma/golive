import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';

const PNG = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64');

describe('V7 support tickets: visitors and members raise, the team answers, files, emails', () => {
  let h: Harness;
  let admin: { token: string; userId: string; orgId: string };
  let owner: { token: string; orgId: string; userId: string };
  let tid: string;
  const mails = (to: string) => h.app.mailer.outbox.filter((e) => e.kind === 'ticket' && e.to === to);

  before(async () => {
    h = await startHarness({ env: { SUPPORT_EMAIL: 'help@golive.test' } });
    admin = await signup(h, 'boss@golive.test', 'Go Live HQ');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [admin.userId]);
    owner = await signup(h, 'rahul@dlf.test', 'DLF Golf Club');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'Monsoon Open' });
  });
  after(async () => h.close());

  it('a website visitor raises a ticket with a screenshot and follows it by a private link', async () => {
    assert.equal((await api(h, 'POST', '/api/support/tickets', { subject: 'Need help', message: 'Hello there' })).body.error.code, 'contact_required');
    const bad = await api(h, 'POST', '/api/support/tickets', { name: 'Priya', email: 'priya@x.test', subject: 'Help please', message: 'How do I start?', files: [{ name: 'x.png', type: 'image/png', data: 'data:image/png;base64,' + Buffer.from('not a png').toString('base64') }] });
    assert.equal(bad.body.error.code, 'file_type');
    assert.equal((await expectOk(api(h, 'GET', '/api/admin/tickets', undefined, admin.token))).tickets.length, 0, 'no half ticket left behind');
    const r = await expectOk(api(h, 'POST', '/api/support/tickets', { name: 'Priya', email: 'Priya@X.test', subject: 'How do I stream a wedding?', category: 'question', priority: 'urgent', message: 'We have 3 phones.', files: [{ name: 'screen.png', type: 'image/png', data: PNG }] }), 201);
    assert.ok(r.number >= 1001);
    assert.match(r.link, /\/support\/t\/[\w-]+$/);
    const view = await expectOk(api(h, 'GET', `/api/support/t/${r.key}`));
    assert.deepEqual([view.ticket.priority, view.ticket.status, view.messages[0].files[0].name], ['high', 'open', 'screen.png'], 'visitors cannot mark urgent');
    const file = await fetch(`${h.baseUrl}/api/support/t/${r.key}/files/${view.messages[0].files[0].id}`);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.equal(mails('priya@x.test').length, 1, 'confirmation to the requester');
    assert.equal(mails('boss@golive.test').length + mails('help@golive.test').length, 2, 'the team is told');
    assert.equal((await api(h, 'GET', '/api/support/t/notarealkeyatall')).status, 404);
    assert.match(await fetch(`${h.baseUrl}/support/t/${r.key}`).then((x) => x.text()), /sp-thread/);
  });

  it('a member raises an urgent ticket about an event from the web app', async () => {
    const r = await expectOk(api(h, 'POST', '/api/support/tickets', { subject: 'Camera 2 drops every minute', category: 'streaming', priority: 'urgent', message: 'Live right now!', eventId: tid }, owner.token), 201);
    const mine = await expectOk(api(h, 'GET', '/api/support/mine', undefined, owner.token));
    assert.equal(mine.tickets[0].number, r.number);
    const list = await expectOk(api(h, 'GET', '/api/admin/tickets', undefined, admin.token));
    assert.equal(list.tickets[0].subject, 'Camera 2 drops every minute', 'urgent first');
    assert.deepEqual([list.tickets[0].club, list.tickets[0].event, list.counts.urgent], ['DLF Golf Club', 'Monsoon Open', 1]);
    assert.ok(h.app.mailer.outbox.some((e) => e.kind === 'ticket' && /^URGENT/.test(e.subject)));
    const d = await expectOk(api(h, 'GET', '/api/admin/dashboard', undefined, admin.token));
    assert.equal(d.alerts.urgentTickets, 1);
  });

  it('the team assigns, writes internal notes and replies; the customer replies back; resolve and close', async () => {
    const t = (await expectOk(api(h, 'GET', '/api/admin/tickets?q=Camera', undefined, admin.token))).tickets[0];
    assert.equal((await api(h, 'PATCH', `/api/admin/tickets/${t.id}`, { assignedTo: owner.userId }, admin.token)).body.error.code, 'not_admin');
    await expectOk(api(h, 'PATCH', `/api/admin/tickets/${t.id}`, { assignedTo: admin.userId, priority: 'high' }, admin.token));
    await expectOk(api(h, 'POST', `/api/admin/tickets/${t.id}/messages`, { body: 'Probably weak 4G at the tee', internal: true }, admin.token));
    const before = mails('rahul@dlf.test').length;
    await expectOk(api(h, 'POST', `/api/admin/tickets/${t.id}/messages`, { body: 'Please lower the camera quality to 720p in the app.', files: [{ name: 'how.png', type: 'image/png', data: PNG }] }, admin.token));
    assert.equal(mails('rahul@dlf.test').length, before + 1, 'customer emailed about the reply only');
    const cust = await expectOk(api(h, 'GET', `/api/support/t/${t.key}`));
    assert.deepEqual(cust.messages.map((m: any) => m.kind), ['customer', 'team'], 'internal notes and changes are hidden');
    assert.equal(cust.ticket.status, 'pending');
    await expectOk(api(h, 'POST', `/api/support/t/${t.key}/messages`, { body: 'That fixed it, thanks!' }));
    const full = await expectOk(api(h, 'GET', `/api/admin/tickets/${t.id}`, undefined, admin.token));
    assert.equal(full.ticket.status, 'open', 'a customer reply reopens it');
    assert.ok(full.messages.some((m: any) => m.internal && m.kind === 'system' && /priority urgent → high/.test(m.body)));
    assert.equal(mails('boss@golive.test').filter((e) => /Reply on #/.test(e.subject)).length, 1, 'the assignee hears about the reply');
    await expectOk(api(h, 'PATCH', `/api/admin/tickets/${t.id}`, { status: 'closed' }, admin.token));
    assert.ok(mails('rahul@dlf.test').some((e) => /Closed:/.test(e.subject)));
    assert.equal((await api(h, 'POST', `/api/support/t/${t.key}/messages`, { body: 'one more thing' })).body.error.code, 'ticket_closed');
    const fid = full.messages.find((m: any) => m.files.length).files[0].id;
    assert.equal((await fetch(`${h.baseUrl}/api/admin/tickets/${t.id}/files/${fid}?token=${encodeURIComponent(admin.token)}`)).status, 200);
    assert.equal((await fetch(`${h.baseUrl}/api/admin/tickets/${t.id}/files/${fid}?token=${encodeURIComponent(owner.token)}`)).status, 403);
  });

  it('visitors are limited to 5 tickets a day', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await api(h, 'POST', '/api/support/tickets', { name: 'Spam', email: `spam${i}@x.test`, subject: `Spam ${i}`, message: 'buy now buy now' })).status);
    assert.equal(codes.at(-1), 429, 'same address is stopped even with new emails');
    const { rows } = await h.db.query("SELECT count(*)::int AS n FROM tickets WHERE user_id IS NULL AND created_at > now() - interval '1 day'");
    assert.equal(rows[0].n, 5);
    const bot = await api(h, 'POST', '/api/support/tickets', { name: 'Bot', email: 'bot@x.test', subject: 'Cheap pills', message: 'buy now buy now', website: 'http://spam' });
    assert.equal(bot.status, 400, 'honeypot');
  });
});
