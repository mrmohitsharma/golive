import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, expectOk, signup, startHarness, type Harness } from './helpers.js';

describe('web-to-app handoff by QR', () => {
  let h: Harness;
  let owner: { token: string; orgId: string; userId: string };

  before(async () => {
    h = await startHarness();
    owner = await signup(h, 'web@club.test', 'Web Club');
  });
  after(async () => h.close());

  it('the website gets a one-time QR; the app redeems it once for the same account', async () => {
    const r = await expectOk(api(h, 'POST', '/api/auth/handoff', {}, owner.token));
    assert.match(r.url, /^https:\/\/live\.example\.com\/app\/login\/[A-Za-z0-9_-]{32}$/);
    assert.ok(r.qrSvg.startsWith('<svg'));
    assert.ok(Date.parse(r.expiresAt) - Date.now() > 4 * 60_000);
    const s = await expectOk(api(h, 'POST', '/api/auth/handoff/redeem', { code: r.code }));
    assert.equal(s.user.id, owner.userId);
    assert.equal(s.orgs[0].id, owner.orgId);
    const me = await expectOk(api(h, 'GET', '/api/me', undefined, s.token));
    assert.equal(me.principal.email, 'web@club.test');
    const again = await api(h, 'POST', '/api/auth/handoff/redeem', { code: r.code });
    assert.equal(again.status, 404);
    assert.equal(again.body.error.code, 'handoff_invalid');
  });

  it('expired, unknown and guest requests are refused; only a hash is stored', async () => {
    const r = await expectOk(api(h, 'POST', '/api/auth/handoff', {}, owner.token));
    const stored = await h.db.query<{ code_hash: string }>('SELECT code_hash FROM auth_handoffs');
    assert.ok(stored.rows.every((x) => x.code_hash !== r.code && x.code_hash.length === 64));
    await h.db.query("UPDATE auth_handoffs SET expires_at = now() - interval '1 second' WHERE used_at IS NULL");
    assert.equal((await api(h, 'POST', '/api/auth/handoff/redeem', { code: r.code })).status, 404);
    assert.equal((await api(h, 'POST', '/api/auth/handoff/redeem', { code: 'x'.repeat(32) })).status, 404);
    assert.equal((await api(h, 'POST', '/api/auth/handoff', {})).status, 401);
  });

  it('the link opened in a phone browser explains what to do', async () => {
    const r = await fetch(`${h.baseUrl}/app/login/abc`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Scan QR from website/);
  });
});
