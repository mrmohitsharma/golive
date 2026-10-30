import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';

describe('V7 web: app shell, sessions, audit log, log in as', () => {
  let h: Harness;
  let admin: { token: string; orgId: string; userId: string };
  let owner: { token: string; orgId: string; userId: string };

  before(async () => {
    h = await startHarness({ env: { BILLING_ENABLED: 'true' } });
    admin = await signup(h, 'boss@golive.test', 'Go Live HQ');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [admin.userId]);
    h.app.sessions.forget(admin.userId);
    owner = await signup(h, 'owner@club.test', 'Club One');
  });
  after(async () => h.close());

  it('serves the web app and its assets', async () => {
    const page = await fetch(`${h.baseUrl}/web/admin/audit`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<script type="module" src="\/web-assets\/app.js">/);
    const js = await fetch(`${h.baseUrl}/web-assets/core.js`);
    assert.match(js.headers.get('content-type')!, /javascript/);
    assert.equal((await fetch(`${h.baseUrl}/web-assets/..%2Fadmin.html`)).status, 404);
  });

  it('admin actions are in the audit log, without secrets; owners cannot read it', async () => {
    assert.equal((await api(h, 'GET', '/api/admin/audit', undefined, owner.token)).status, 403);
    await expectOk(api(h, 'POST', `/api/admin/orgs/${owner.orgId}/credits`, { credits: 100, note: 'Welcome' }, admin.token));
    const { entries } = await expectOk(api(h, 'GET', '/api/admin/audit', undefined, admin.token));
    const e = entries.find((x: any) => x.action === 'POST /api/admin/orgs/:id/credits');
    assert.ok(e, 'logged');
    assert.equal(e.actor, 'boss@golive.test');
    assert.equal(e.targetId, owner.orgId);
    assert.equal(e.detail.body.credits, 100);
    assert.equal((await expectOk(api(h, 'GET', `/api/admin/audit?org=${owner.orgId}`, undefined, admin.token))).entries.length, 1);
    // Owners' own changes are not admin actions.
    await expectOk(api(h, 'POST', `/api/orgs/${owner.orgId}/tournaments`, { name: 'Own Cup' }, owner.token), 201);
    assert.equal((await expectOk(api(h, 'GET', '/api/admin/audit?q=tournaments', undefined, admin.token))).entries.length, 0);
  });

  it('log in as: works like the owner for 1 hour, never as admin, and everything is logged', async () => {
    const other = await signup(h, 'admin2@golive.test', 'HQ 2');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [other.userId]);
    assert.equal((await api(h, 'POST', `/api/admin/users/${other.userId}/impersonate`, {}, admin.token)).body.error.code, 'is_admin');
    assert.equal((await api(h, 'POST', `/api/admin/users/${admin.userId}/impersonate`, {}, owner.token)).status, 403);

    const imp = await expectOk(api(h, 'POST', `/api/admin/users/${owner.userId}/impersonate`, {}, admin.token));
    assert.equal(imp.user.impersonatedBy, 'boss@golive.test');
    const me = await expectOk(api(h, 'GET', '/api/me', undefined, imp.token));
    assert.deepEqual([me.principal.email, me.principal.platformAdmin, me.principal.impersonatedBy], ['owner@club.test', false, 'boss@golive.test']);
    assert.equal((await api(h, 'GET', '/api/admin/overview', undefined, imp.token)).status, 403, 'no admin rights while logged in as');
    const t = await expectOk(api(h, 'POST', `/api/orgs/${owner.orgId}/tournaments`, { name: 'Support Cup' }, imp.token), 201);
    assert.ok(t);
    assert.equal((await api(h, 'POST', '/api/me/sign-out-everywhere', {}, imp.token)).status, 403);
    await expectOk(api(h, 'POST', '/api/impersonation/stop', {}, imp.token));
    const { entries } = await expectOk(api(h, 'GET', '/api/admin/audit', undefined, admin.token));
    const made = entries.find((x: any) => x.action === 'POST /api/orgs/:id/tournaments');
    assert.deepEqual([made.actor, made.asUser], ['boss@golive.test', 'owner@club.test']);
    assert.ok(entries.find((x: any) => x.action === 'POST /api/admin/users/:id/impersonate' && x.targetId === owner.userId));
    assert.ok(entries.find((x: any) => x.action === 'POST /api/impersonation/stop'));

    // The admin loses admin rights: their "log in as" sessions end too.
    await h.db.query('UPDATE users SET is_platform_admin = false WHERE id = $1', [admin.userId]);
    h.app.sessions.forget(admin.userId);
    assert.equal((await api(h, 'GET', '/api/me', undefined, imp.token)).status, 401);
    assert.equal((await api(h, 'GET', '/api/admin/overview', undefined, admin.token)).status, 403, 'admin rights removed at once');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [admin.userId]);
    h.app.sessions.forget(admin.userId);
  });

  it('sign out everywhere and disabled accounts end sessions at once', async () => {
    const u = await signup(h, 'someone@club.test', 'Club Two');
    await expectOk(api(h, 'GET', '/api/me', undefined, u.token));
    await expectOk(api(h, 'POST', `/api/admin/users/${u.userId}/sign-out`, {}, admin.token));
    assert.equal((await api(h, 'GET', '/api/me', undefined, u.token)).status, 401);
    const again = await expectOk(api(h, 'POST', '/api/auth/login', { email: 'someone@club.test', password: 'password123' }));
    await expectOk(api(h, 'GET', '/api/me', undefined, again.token));
    await h.db.query('UPDATE users SET disabled = true WHERE id = $1', [u.userId]);
    h.app.sessions.forget(u.userId);
    assert.equal((await api(h, 'GET', `/api/tournaments`, undefined, again.token)).status, 401);
  });
});
