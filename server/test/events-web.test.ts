import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';

describe('V7 web event gaps: copy event, date, destinations, checklist', () => {
  let h: Harness;
  let owner: { token: string; orgId: string; userId: string };
  let tid: string;

  before(async () => {
    h = await startHarness();
    owner = await signup(h, 'rahul@dlf.test', 'DLF Golf Club');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'Monsoon Open', venue: 'DLF' });
  });
  after(async () => h.close());

  it('the date can be set and cleared; the event snapshot has the club and date', async () => {
    const t = (await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}`, { startsOn: '2026-11-15' }, owner.token))).tournament;
    assert.match(String(t.startsOn), /^2026-11-1[45]/);
    const s = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/state`, undefined, owner.token));
    assert.equal(s.tournament.orgId, owner.orgId);
    assert.ok(s.tournament.startsOn);
    assert.equal((await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}`, { startsOn: null }, owner.token))).tournament.startsOn, null);
  });

  it('copy: settings, course, games and (if asked) players; never keys, cameras or viewers', async () => {
    await expectOk(api(h, 'PUT', `/api/tournaments/${tid}/holes`, { preset: 'par72' }, owner.token));
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/players`, { players: [{ name: 'Aarav' }, { name: 'Riya' }] }, owner.token), 200, 201);
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}`, { chatSlowSec: 9, publicWatch: false }, owner.token));
    await expectOk(api(h, 'PUT', `/api/tournaments/${tid}/youtube/key`, { streamKey: 'abcd-efgh-ijkl-mnop' }, owner.token));
    await h.db.query("INSERT INTO moments (tournament_id, type, title, clock, options) VALUES ($1, 'poll', 'Who wins?', 'director', '[]')", [tid]);
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/cameras/register`, { name: 'Tee 1', deviceId: 'device-0001', platform: 'android' }, owner.token), 200, 201);

    const c = (await expectOk(api(h, 'POST', `/api/tournaments/${tid}/copy`, { name: 'Winter Open', startsOn: '2026-12-20', players: true }, owner.token), 201)).tournament;
    assert.deepEqual([c.name, c.venue, c.chatSlowSec, c.publicWatch], ['Winter Open', 'DLF', 9, false]);
    const src = (await h.db.query('SELECT engine_key, read_key FROM tournaments WHERE id = $1', [tid])).rows[0];
    const dst = (await h.db.query('SELECT engine_key, read_key, yt_source, yt_stream_key_enc FROM tournaments WHERE id = $1', [c.id])).rows[0];
    assert.notEqual(dst.engine_key, src.engine_key, 'new keys');
    assert.deepEqual([dst.yt_source, dst.yt_stream_key_enc], ['org', null], 'stream key not copied');
    assert.equal((await expectOk(api(h, 'GET', `/api/tournaments/${c.id}/holes`, undefined, owner.token))).holes.length, 18);
    assert.equal((await expectOk(api(h, 'GET', `/api/tournaments/${c.id}/players`, undefined, owner.token))).players.length, 2);
    assert.equal((await h.db.query('SELECT count(*)::int AS n FROM moments WHERE tournament_id = $1', [c.id])).rows[0].n, 1);
    assert.equal((await h.db.query('SELECT count(*)::int AS n FROM cameras WHERE tournament_id = $1', [c.id])).rows[0].n, 0);
    assert.equal((await expectOk(api(h, 'GET', `/api/tournaments/${c.id}/invites`, undefined, owner.token))).invites.length, 3, 'its own invite codes');
    const noPlayers = (await expectOk(api(h, 'POST', `/api/tournaments/${tid}/copy`, { name: 'Spring Open', games: false }, owner.token), 201)).tournament;
    assert.equal((await expectOk(api(h, 'GET', `/api/tournaments/${noPlayers.id}/players`, undefined, owner.token))).players.length, 0);
    const stranger = await signup(h, 'x@y.test', 'Other');
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/copy`, { name: 'Steal' }, stranger.token)).status, 404);
  });

  it('a stream-key destination needs its platform; vertical can be switched', async () => {
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/destinations`, { kind: 'key', streamKey: 'k1' }, owner.token)).status, 400);
    const d = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/destinations`, { kind: 'key', platform: 'facebook', streamUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/', streamKey: 'FB-123456', vertical: false }, owner.token), 201);
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/destinations/${d.destinationId}`, { vertical: true }, owner.token));
    const o = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/destinations`, undefined, owner.token));
    assert.equal(o.outputs.destinations[0].vertical, true);
  });

  it('first-show checklist for the club', async () => {
    const ob = await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/onboarding`, undefined, owner.token));
    assert.deepEqual([ob.hasEvent, ob.steps.cameras, ob.done], [true, true, false]);
  });
});
