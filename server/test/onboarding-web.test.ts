import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';

describe('V7 web onboarding: setup and tour progress per user; the main stream', () => {
  let h: Harness;
  let owner: { token: string; orgId: string };
  let tid: string;

  before(async () => {
    h = await startHarness({ env: { HLS_ENABLED: 'true' } });
    owner = await signup(h, 'mohit@icca.test', 'ICCA');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'New Test Event' });
  });
  after(async () => h.close());

  it('remembers the setup bar and the tour per user, merging each change', async () => {
    assert.deepEqual((await expectOk(api(h, 'GET', '/api/me/onboarding', undefined, owner.token))).onboarding, {});
    await expectOk(api(h, 'PATCH', '/api/me/onboarding', { welcomed: true, setup: { state: 'active', step: 1 } }, owner.token));
    await expectOk(api(h, 'PATCH', '/api/me/onboarding', { setup: { step: 2, eventId: tid } }, owner.token));
    await expectOk(api(h, 'PATCH', '/api/me/onboarding', { tour: { state: 'active', step: 3, seen: ['welcome', 'events'] } }, owner.token));
    const r = await expectOk(api(h, 'PATCH', '/api/me/onboarding', { tour: { step: 4, seen: ['events', 'new-event'] } }, owner.token));
    assert.deepEqual(r.onboarding, { welcomed: true, setup: { state: 'active', step: 2, eventId: tid }, tour: { state: 'active', step: 4, seen: ['welcome', 'events', 'new-event'] } });
    assert.equal((await expectOk(api(h, 'PATCH', '/api/me/onboarding', { controlGuide: false }, owner.token))).onboarding.controlGuide, false);
    assert.equal((await api(h, 'PATCH', '/api/me/onboarding', { setup: { step: 9 } }, owner.token)).status, 400);
    assert.equal((await api(h, 'PATCH', '/api/me/onboarding', { admin: true }, owner.token)).status, 400, 'only known keys');
    assert.equal((await api(h, 'GET', '/api/me/onboarding')).status, 401);
  });

  it('main stream: our watch page by default; pick YouTube, a key destination; pause and resume; fall back when removed', async () => {
    const out = async () => (await expectOk(api(h, 'GET', `/api/tournaments/${tid}/destinations`, undefined, owner.token))).outputs;
    let o = await out();
    assert.deepEqual(o.main, { id: 'watch', label: 'Watch page (our player)', link: `https://live.example.com/watch/${tid}`, paused: false, ready: true });

    // YouTube as main: not ready until a broadcast or key exists.
    o = (await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/outputs`, { main: 'youtube' }, owner.token))).outputs;
    assert.deepEqual([o.main.id, o.main.ready, o.main.paused], ['youtube', false, false]);
    // Pause it, resume it.
    o = (await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/outputs`, { youtube: { enabled: false } }, owner.token))).outputs;
    assert.equal(o.main.paused, true);
    o = (await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/outputs`, { main: 'youtube' }, owner.token))).outputs;
    assert.equal(o.main.paused, false, 'choosing it again resumes it');

    // A stream key destination (e.g. a sponsor's Instagram) as main.
    const d = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/destinations`, { kind: 'key', platform: 'other', streamUrl: 'rtmp://live.example.net/app', streamKey: 'SECRET-KEY-1', label: 'Club website' }, owner.token), 201);
    const destId = d.destination?.id ?? d.outputs?.destinations?.[0]?.id;
    o = (await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/outputs`, { main: `d:${destId}` }, owner.token))).outputs;
    assert.deepEqual([o.main.id, o.main.label, o.main.ready], [`d:${destId}`, 'Club website', true]);
    assert.ok(!JSON.stringify(o).includes('SECRET-KEY-1'));
    await expectOk(api(h, 'DELETE', `/api/tournaments/${tid}/destinations/${destId}`, undefined, owner.token));
    o = await out();
    assert.equal(o.main.id, 'watch', 'a removed main falls back to the watch page');

    // Instagram needs its key first; nonsense is refused.
    assert.equal((await api(h, 'PATCH', `/api/tournaments/${tid}/outputs`, { main: 'instagram' }, owner.token)).body.error.code, 'instagram_no_key');
    assert.equal((await api(h, 'PATCH', `/api/tournaments/${tid}/outputs`, { main: 'tiktok' }, owner.token)).body.error.code, 'bad_main');
    o = (await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/outputs`, { main: 'watch' }, owner.token))).outputs;
    assert.equal(o.main.id, 'watch');
  });
});
