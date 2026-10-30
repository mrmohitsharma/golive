import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';

describe('V7 admin: dashboard, clubs, users, events, live monitor', () => {
  let h: Harness;
  let admin: { token: string; orgId: string; userId: string };
  let owner: { token: string; orgId: string; userId: string };
  let tid: string;

  before(async () => {
    h = await startHarness({ env: { BILLING_ENABLED: 'true' } });
    admin = await signup(h, 'boss@golive.test', 'Go Live HQ');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [admin.userId]);
    owner = await signup(h, 'rahul@dlf.test', 'DLF Golf Club');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'Monsoon Open' });
  });
  after(async () => h.close());

  it('only admins reach the new admin APIs', async () => {
    for (const url of ['/api/admin/dashboard', '/api/admin/users', '/api/admin/events', '/api/admin/live-monitor']) {
      assert.equal((await api(h, 'GET', url, undefined, owner.token)).status, 403, url);
    }
  });

  it('dashboard: live now, periods, 30-day series and alerts', async () => {
    const d = await expectOk(api(h, 'GET', '/api/admin/dashboard', undefined, admin.token));
    assert.deepEqual(d.now, { liveEvents: 0, cameras: 0, watchingOnPage: 0, watchingOnYoutube: 0 });
    assert.equal(d.today.newClubs, 2);
    assert.equal(d.month.newEvents, 1);
    assert.equal(d.series.length, 30);
    assert.equal(d.series.at(-1).newEvents, 1);
    assert.deepEqual(d.alerts.engineWarnings, []);
  });

  it('users: create with a one-time password, edit, disable, admin rights, reset, delete', async () => {
    const c = await expectOk(api(h, 'POST', '/api/admin/users', { email: 'Neha@Club.test', name: 'Neha', clubName: 'Neha Events' }, admin.token), 201);
    assert.equal(c.user.email, 'neha@club.test');
    assert.equal(c.password.length, 12);
    const login = await expectOk(api(h, 'POST', '/api/auth/login', { email: 'neha@club.test', password: c.password }));
    assert.equal(login.orgs[0].role, 'owner');
    const list = await expectOk(api(h, 'GET', '/api/admin/users?q=neha', undefined, admin.token));
    assert.equal(list.users.length, 1);
    assert.equal(list.users[0].clubs[0].name, 'Neha Events');
    assert.ok(list.users[0].lastLoginAt);

    await expectOk(api(h, 'PATCH', `/api/admin/users/${c.user.id}`, { disabled: true }, admin.token));
    assert.equal((await api(h, 'GET', '/api/me', undefined, login.token)).status, 401);
    assert.equal((await api(h, 'POST', '/api/auth/login', { email: 'neha@club.test', password: c.password })).status, 401);
    await expectOk(api(h, 'PATCH', `/api/admin/users/${c.user.id}`, { disabled: false }, admin.token));
    const r = await expectOk(api(h, 'POST', `/api/admin/users/${c.user.id}/reset-password`, {}, admin.token));
    assert.equal((await api(h, 'POST', '/api/auth/login', { email: 'neha@club.test', password: c.password })).status, 401, 'old password gone');
    await expectOk(api(h, 'POST', '/api/auth/login', { email: 'neha@club.test', password: r.password }));

    assert.equal((await api(h, 'PATCH', `/api/admin/users/${admin.userId}`, { platformAdmin: false }, admin.token)).body.error.code, 'self');
    await expectOk(api(h, 'PATCH', `/api/admin/users/${c.user.id}`, { platformAdmin: true }, admin.token));
    assert.equal((await expectOk(api(h, 'GET', '/api/admin/users?filter=admins', undefined, admin.token))).users.length, 2);
    await expectOk(api(h, 'PATCH', `/api/admin/users/${c.user.id}`, { platformAdmin: false }, admin.token));

    assert.equal((await api(h, 'DELETE', `/api/admin/users/${c.user.id}`, undefined, admin.token)).body.error.code, 'sole_owner');
    const org = login.orgs[0].id;
    const helper = await expectOk(api(h, 'POST', '/api/admin/users', { email: 'helper@club.test', name: 'Helper' }, admin.token), 201);
    await expectOk(api(h, 'POST', `/api/admin/orgs/${org}/members`, { email: 'helper@club.test', role: 'director' }, admin.token));
    await expectOk(api(h, 'POST', `/api/admin/orgs/${org}/transfer`, { userId: helper.user.id }, admin.token));
    const members = (await expectOk(api(h, 'GET', `/api/admin/orgs/${org}`, undefined, admin.token))).members;
    assert.deepEqual(members.map((m: any) => `${m.email}:${m.role}`).sort(), ['helper@club.test:owner', 'neha@club.test:director']);
    assert.equal((await api(h, 'DELETE', `/api/admin/users/${c.user.id}`, undefined, admin.token)).status, 204);
  });

  it('clubs: rename, notes, feature switches that clubs feel, delete with the name typed', async () => {
    await expectOk(api(h, 'PATCH', `/api/admin/orgs/${owner.orgId}`, { name: 'DLF Golf & Country Club', notes: 'VIP launch partner' }, admin.token));
    let x = await expectOk(api(h, 'GET', `/api/admin/orgs/${owner.orgId}/extra`, undefined, admin.token));
    assert.deepEqual(x.features, { cloud: true, viewership: true });
    assert.equal(x.notes, 'VIP launch partner');
    await expectOk(api(h, 'PATCH', `/api/admin/orgs/${owner.orgId}`, { features: { cloud: false, viewership: false } }, admin.token));
    x = await expectOk(api(h, 'GET', `/api/admin/orgs/${owner.orgId}/extra`, undefined, admin.token));
    assert.deepEqual(x.features, { cloud: false, viewership: false });
    assert.equal(x.notes, 'VIP launch partner', 'notes kept');
    const cloud = await api(h, 'PATCH', `/api/tournaments/${tid}`, { mode: 'cloud' }, owner.token);
    assert.deepEqual([cloud.status, cloud.body.error.code], [403, 'feature_off']);
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/billing/viewership`, {}, owner.token)).body.error.code, 'feature_off');
    await expectOk(api(h, 'PATCH', `/api/admin/orgs/${owner.orgId}`, { features: { cloud: true, viewership: true } }, admin.token));

    const throwaway = await signup(h, 'temp@x.test', 'Temp Club');
    assert.equal((await api(h, 'DELETE', `/api/admin/orgs/${throwaway.orgId}`, { confirmName: 'Temp' }, admin.token)).body.error.code, 'confirm_name');
    assert.equal((await api(h, 'DELETE', `/api/admin/orgs/${throwaway.orgId}`, { confirmName: 'Temp Club' }, admin.token)).status, 204);
    assert.equal((await api(h, 'GET', `/api/admin/orgs/${throwaway.orgId}`, undefined, admin.token)).status, 404);
  });

  it('events across clubs, with filters, watch page off and archive', async () => {
    const all = await expectOk(api(h, 'GET', '/api/admin/events', undefined, admin.token));
    const e = all.events.find((x: any) => x.id === tid);
    assert.deepEqual([e.orgName, e.cameras, e.viewers, e.liveNow, e.publicWatch], ['DLF Golf & Country Club', 0, 0, false, true]);
    assert.equal((await expectOk(api(h, 'GET', '/api/admin/events?status=live', undefined, admin.token))).events.length, 0);
    assert.equal((await expectOk(api(h, 'GET', '/api/admin/events?q=monsoon', undefined, admin.token))).events.length, 1);
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}`, { publicWatch: false }, admin.token));
    assert.equal((await api(h, 'GET', `/api/public/tournaments/${tid}`)).status, 404);
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}`, { publicWatch: true, archived: true }, admin.token));
    assert.equal((await expectOk(api(h, 'GET', '/api/admin/events?status=archived', undefined, admin.token))).events.length, 1);
    await expectOk(api(h, 'POST', `/api/admin/events/${tid}/stop`, {}, admin.token));
    assert.deepEqual((await expectOk(api(h, 'GET', '/api/admin/live-monitor', undefined, admin.token))).live, []);
  });
});
