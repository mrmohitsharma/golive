import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';

describe('V8 Laptop OBS: pair a laptop with a 6-digit code, pick its event', () => {
  let h: Harness;
  let owner: { token: string; orgId: string };
  let other: { token: string; orgId: string };
  let a: string;
  let b: string;

  before(async () => {
    h = await startHarness();
    owner = await signup(h, 'owner@laptop.test', 'Laptop Club');
    other = await signup(h, 'other@laptop.test', 'Other Club');
    a = await createTournament(h, owner.token, owner.orgId, { name: 'Final A', productionMode: 'laptop' } as any);
    b = await createTournament(h, owner.token, owner.orgId, { name: 'Final B', productionMode: 'laptop' } as any);
  });
  after(async () => h.close());

  it('pairs, hands the laptop key over once, and gives an engine token for its event', async () => {
    const p = await expectOk(api(h, 'POST', '/api/agent/pair', { name: 'Mohit-PC', os: 'windows', version: '1.0.0' }));
    assert.match(p.code, /^\d{6}$/);
    assert.match(p.pairUrl, /\/web\/pair\?code=\d{6}$/);
    const wait = await expectOk(h.app.fastify.inject({ method: 'GET', url: `/api/agent/pair/${p.pairId}`, headers: { 'x-pair-secret': p.secret } }).then((r) => ({ status: r.statusCode, body: r.json() })));
    assert.equal(wait.status, 'waiting');
    // Wrong secret: not found.
    const bad = await h.app.fastify.inject({ method: 'GET', url: `/api/agent/pair/${p.pairId}`, headers: { 'x-pair-secret': 'nope' } });
    assert.equal(bad.statusCode, 404);
    // Wrong code; another club cannot see this event.
    assert.equal((await api(h, 'POST', `/api/tournaments/${a}/laptops/pair`, { code: '000000' === p.code ? '111111' : '000000' }, owner.token)).status, 404);
    assert.equal((await api(h, 'POST', `/api/tournaments/${a}/laptops/pair`, { code: p.code }, other.token)).status, 404);

    const st = await expectOk(api(h, 'POST', `/api/tournaments/${a}/laptops/pair`, { code: ` ${p.code.slice(0, 3)} ${p.code.slice(3)} ` }, owner.token));
    assert.equal(st.laptops.length, 1);
    assert.equal(st.laptops[0].name, 'Mohit-PC');
    assert.equal(st.laptopId, st.laptops[0].id);
    assert.ok(st.downloads.windows.endsWith('/download/agent/windows'));
    // The code cannot be used twice.
    assert.equal((await api(h, 'POST', `/api/tournaments/${b}/laptops/pair`, { code: p.code }, owner.token)).status, 404);

    const got = (await h.app.fastify.inject({ method: 'GET', url: `/api/agent/pair/${p.pairId}`, headers: { 'x-pair-secret': p.secret } })).json();
    assert.equal(got.status, 'paired');
    assert.ok(got.laptopToken.length >= 32);
    const again = (await h.app.fastify.inject({ method: 'GET', url: `/api/agent/pair/${p.pairId}`, headers: { 'x-pair-secret': p.secret } })).json();
    assert.notEqual(again.status, 'paired');

    const s = await expectOk(api(h, 'POST', '/api/agent/session', { laptopId: got.laptopId, laptopToken: got.laptopToken, version: '1.0.1' }));
    assert.equal(s.event.id, a);
    assert.equal(s.club, 'Laptop Club');
    assert.ok(s.engineToken);
    assert.equal((await api(h, 'POST', '/api/agent/session', { laptopId: got.laptopId, laptopToken: 'x'.repeat(64) })).status, 401);

    // Move the laptop to event B: A has no laptop now.
    const lid = got.laptopId;
    await expectOk(api(h, 'POST', `/api/tournaments/${b}/laptops/${lid}/use`, {}, owner.token));
    assert.equal((await expectOk(api(h, 'POST', '/api/agent/session', { laptopId: lid, laptopToken: got.laptopToken }))).event.id, b);
    const sa = await expectOk(api(h, 'GET', `/api/tournaments/${a}/laptops`, undefined, owner.token));
    assert.equal(sa.laptopId, null);
    assert.equal(sa.laptops[0].online, true);
    assert.equal(sa.laptops[0].event.name, 'Final B');

    // Take it off B, then forget it: the agent must pair again.
    await expectOk(api(h, 'POST', `/api/tournaments/${b}/laptops/${lid}/release`, {}, owner.token));
    assert.equal((await expectOk(api(h, 'POST', '/api/agent/session', { laptopId: lid, laptopToken: got.laptopToken }))).event, null);
    await expectOk(api(h, 'DELETE', `/api/tournaments/${b}/laptops/${lid}`, undefined, owner.token));
    const gone = await api(h, 'POST', '/api/agent/session', { laptopId: lid, laptopToken: got.laptopToken });
    assert.equal(gone.status, 401);
    assert.equal(gone.body.error.code, 'laptop_removed');
  });

  it('redirects downloads to the agent apps', async () => {
    const r = await h.app.fastify.inject({ method: 'GET', url: '/download/agent/windows' });
    assert.equal(r.statusCode, 302);
    assert.match(r.headers.location as string, /GoLiveAgent-Windows\.exe$/);
    assert.equal((await h.app.fastify.inject({ method: 'GET', url: '/download/agent/linux' })).statusCode, 404);
  });
});
