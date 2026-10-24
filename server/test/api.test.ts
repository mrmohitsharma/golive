import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addStaff, api, createTournament, engineToken, expectOk, joinAsGuest, signup, startHarness, type Harness } from './helpers.js';

describe('self-serve: sign-up, organisations, roles', () => {
  let h: Harness;
  let owner: { token: string; orgId: string; userId: string };
  let directorToken: string;
  let scorerToken: string;
  let tournamentId: string;

  before(async () => {
    h = await startHarness();
    owner = await signup(h, 'owner@club.test', 'Delhi Golf Club');
  });
  after(async () => h.close());

  it('sign-up creates the account and the club with the user as owner', async () => {
    const me = await expectOk(api(h, 'GET', '/api/me', undefined, owner.token));
    assert.equal(me.principal.kind, 'user');
    assert.deepEqual(me.orgs, [{ id: owner.orgId, name: 'Delhi Golf Club', role: 'owner' }]);
    const dup = await api(h, 'POST', '/api/auth/signup', { name: 'x', email: 'owner@club.test', password: 'password123', orgName: 'Other' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'email_taken');
  });

  it('rejects bad credentials with a consistent error shape', async () => {
    const r = await api(h, 'POST', '/api/auth/login', { email: 'owner@club.test', password: 'nope' });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'invalid_credentials');
  });

  it('owner adds staff; non-owners cannot manage members', async () => {
    directorToken = await addStaff(h, owner.token, owner.orgId, 'director@club.test', 'director');
    scorerToken = await addStaff(h, owner.token, owner.orgId, 'scorer@club.test', 'scorer');
    const members = await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/members`, undefined, owner.token));
    assert.deepEqual(members.members.map((m: any) => m.role).sort(), ['director', 'owner', 'scorer']);
    assert.equal((await api(h, 'GET', `/api/orgs/${owner.orgId}/members`, undefined, directorToken)).status, 403);
    // The last owner cannot be demoted.
    const r = await api(h, 'PATCH', `/api/orgs/${owner.orgId}/members/${owner.userId}`, { role: 'director' }, owner.token);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'last_owner');
  });

  it('directors create tournaments; scorers cannot; other clubs cannot see them', async () => {
    tournamentId = await createTournament(h, directorToken, owner.orgId);
    assert.equal((await api(h, 'POST', `/api/orgs/${owner.orgId}/tournaments`, { name: 'X' }, scorerToken)).status, 403);
    const other = await signup(h, 'rival@club.test', 'Rival Club');
    const list = await expectOk(api(h, 'GET', '/api/tournaments', undefined, other.token));
    assert.equal(list.tournaments.length, 0);
    assert.equal((await api(h, 'GET', `/api/tournaments/${tournamentId}/state`, undefined, other.token)).status, 404);
    const mine = await expectOk(api(h, 'GET', '/api/tournaments', undefined, scorerToken));
    assert.equal(mine.tournaments[0].role, 'scorer');
    assert.equal(mine.tournaments[0].read_key, undefined, 'secrets never leak');
  });

  it('QR join codes: volunteers join without an account, scoped to one tournament and role', async () => {
    const created = await expectOk(api(h, 'POST', `/api/tournaments/${tournamentId}/join-codes`, { role: 'camera', label: 'Hole 1-9' }, directorToken));
    const code = created.code.code;
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(created.code.joinUrl, `https://live.example.com/join/${code}`);

    const png = await fetch(`${h.baseUrl}${created.code.qrUrl}`, { headers: { authorization: `Bearer ${directorToken}` } });
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await png.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

    const page = await fetch(`${h.baseUrl}/join/${code.toLowerCase()}`);
    assert.match(await page.text(), new RegExp(code));

    const j = await expectOk(api(h, 'POST', '/api/join', { code: code.slice(0, 3) + '-' + code.slice(3), deviceId: 'phone-0001-abcd', name: 'Ravi' }));
    assert.equal(j.role, 'camera');
    assert.equal(j.tournament.id, tournamentId);
    const me = await expectOk(api(h, 'GET', '/api/me', undefined, j.token));
    assert.equal(me.principal.kind, 'guest');
    assert.equal(me.principal.role, 'camera');
    // A camera guest cannot create tournaments, manage, or enter scores.
    assert.equal((await api(h, 'GET', `/api/tournaments/${tournamentId}/join-codes`, undefined, j.token)).status, 403);
    assert.equal((await api(h, 'PUT', `/api/tournaments/${tournamentId}/scores`, { playerId: crypto.randomUUID(), hole: 1, strokes: 4 }, j.token)).status, 403);

    // Revoked codes stop working.
    await expectOk(api(h, 'DELETE', `/api/tournaments/${tournamentId}/join-codes/${code}`, undefined, directorToken), 204);
    const bad = await api(h, 'POST', '/api/join', { code, deviceId: 'phone-0002-abcd', name: 'X' });
    assert.equal(bad.status, 404);
    assert.equal(bad.body.error.code, 'invalid_code');
  });

  it('a guest camera registers, re-registers on the same slot, and only that phone reads its key', async () => {
    const guest = await joinAsGuest(h, directorToken, tournamentId, 'camera', 'phone-aaaa-1111', 'Asha');
    const body = { name: 'Hole 1 Tee', hole: 1, position: 'Tee', deviceId: 'phone-aaaa-1111', platform: 'android', deviceModel: 'Pixel 8' };
    const r1 = await expectOk(api(h, 'POST', `/api/tournaments/${tournamentId}/cameras/register`, body, guest), 201);
    assert.match(r1.camera.streamPath, /^cam-[0-9a-f]{10}$/);
    assert.ok(r1.publish.srtUrl.startsWith(`srt://live.example.com:8890?streamid=publish:${r1.camera.streamPath}:cam:`));

    // Same phone joins again later (new token) and keeps its slot.
    const again = await joinAsGuest(h, directorToken, tournamentId, 'camera', 'phone-aaaa-1111', 'Asha');
    const r2 = await expectOk(api(h, 'POST', `/api/tournaments/${tournamentId}/cameras/register`, { ...body, name: 'Hole 1 Fairway' }, again), 200);
    assert.equal(r2.camera.id, r1.camera.id);
    assert.equal(r2.camera.streamPath, r1.camera.streamPath);
    assert.equal((await api(h, 'GET', `/api/cameras/${r1.camera.id}/publish`, undefined, again)).status, 200);

    const otherGuest = await joinAsGuest(h, directorToken, tournamentId, 'camera', 'phone-bbbb-2222', 'Bob');
    assert.equal((await api(h, 'GET', `/api/cameras/${r1.camera.id}/publish`, undefined, otherGuest)).status, 403);
    assert.equal((await api(h, 'GET', `/api/cameras/${r1.camera.id}/publish`, undefined, directorToken)).status, 403);
    // Directors reassign; the owner phone can rename itself.
    const p = await expectOk(api(h, 'PATCH', `/api/cameras/${r1.camera.id}`, { hole: 7, position: 'Green' }, directorToken));
    assert.equal(p.camera.hole, 7);
    assert.equal((await api(h, 'PATCH', `/api/cameras/${r1.camera.id}`, { name: 'Bob cam' }, otherGuest)).status, 403);
  });

  it('engine key → engine token; engine setup only for managers', async () => {
    const setup = await expectOk(api(h, 'GET', `/api/tournaments/${tournamentId}/engine-setup`, undefined, directorToken));
    assert.match(setup.envFile, new RegExp(`TOURNAMENT_ID=${tournamentId}`));
    assert.match(setup.envFile, /ENGINE_KEY=[0-9a-f]{48}/);
    assert.equal((await api(h, 'GET', `/api/tournaments/${tournamentId}/engine-setup`, undefined, scorerToken)).status, 403);
    const bad = await api(h, 'POST', '/api/engine/token', { tournamentId, engineKey: 'x'.repeat(48) });
    assert.equal(bad.status, 401);
    const tok = await engineToken(h, tournamentId);
    const me = await expectOk(api(h, 'GET', '/api/me', undefined, tok));
    assert.equal(me.principal.kind, 'engine');
    // Rotating invalidates the old key.
    const rotated = await expectOk(api(h, 'POST', `/api/tournaments/${tournamentId}/engine-key/rotate`, undefined, directorToken));
    assert.notEqual(rotated.engineKey, setup.engineKey);
    assert.equal((await api(h, 'POST', '/api/engine/token', { tournamentId, engineKey: setup.engineKey })).status, 401);
  });

  it('server info advertises optional features', async () => {
    const info = await expectOk(api(h, 'GET', '/api/info'));
    assert.deepEqual({ signup: info.signup, youtube: info.youtube, cloud: info.cloudProduction }, { signup: true, youtube: false, cloud: false });
  });

  it('sign-up can be disabled', async () => {
    const closed = await startHarness({ env: { SIGNUP_ENABLED: 'false' } });
    try {
      const r = await api(closed, 'POST', '/api/auth/signup', { name: 'a', email: 'a@b.test', password: 'password123', orgName: 'Org' });
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, 'signup_disabled');
    } finally {
      await closed.close();
    }
  });
});
