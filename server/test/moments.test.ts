import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addStaff, api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';
let ip = 1;

describe('viewership step 3: games on three clocks', () => {
  let h: Harness;
  let owner: { token: string; orgId: string; userId: string };
  let tid: string;

  const view = async (body: object = {}) =>
    (await (
      await fetch(`${h.baseUrl}/api/public/tournaments/${tid}/view`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': UA, 'x-forwarded-for': `10.9.${ip++}.1` },
        body: JSON.stringify(body),
      })
    ).json()) as any;
  const watch = async (token: string, sec: number) => {
    for (let s = 0; s < sec; s += 30)
      await fetch(`${h.baseUrl}/api/public/view/beat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, playingSec: Math.min(30, sec - s), unmutedSec: 0 }) });
  };
  const play = (mid: string, token: string, runKey: string, answer?: string) => api(h, 'POST', `/api/public/moments/${mid}/play`, { token, runKey, answer });
  const make = async (body: object) => (await expectOk(api(h, 'POST', `/api/tournaments/${tid}/moments`, body, owner.token))).moment;

  before(async () => {
    h = await startHarness();
    owner = await signup(h, 'games@club.test', 'Games Club');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'Game Day' });
  });
  after(async () => h.close());

  it('checks a game before saving it', async () => {
    const bad = async (body: object) => (await api(h, 'POST', `/api/tournaments/${tid}/moments`, body, owner.token)).body.error.code;
    assert.equal(await bad({ type: 'quiz', title: 'Q', clock: 'viewer', atSec: 10, options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }), 'need_correct');
    assert.equal(await bad({ type: 'poll', title: 'P', clock: 'stream', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }), 'need_time');
    assert.equal(await bad({ type: 'poll', title: 'P', clock: 'director', options: [{ id: 'a', text: 'A' }] }), 'need_options');
    assert.equal(await bad({ type: 'poll', title: 'P', clock: 'viewer', atSec: 5, repeatMax: 3, options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }), 'need_repeat');
    const scorer = await addStaff(h, owner.token, owner.orgId, 'sc@club.test', 'scorer');
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/moments`, { type: 'poll', title: 'P', clock: 'director', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }, scorer)).status, 403);
  });

  it('viewer clock: opens when this viewer has watched long enough; repeats; one play each; the server marks the quiz', async () => {
    const q = await make({
      type: 'quiz', title: 'Golf quiz', question: 'How many holes in a round?', clock: 'viewer', atSec: 60, repeatEverySec: 120, repeatMax: 2, openSec: 60,
      options: [{ id: 'a', text: '9' }, { id: 'b', text: '18' }], correctOption: 'b',
    });
    const feed = await expectOk(api(h, 'GET', `/api/public/tournaments/${tid}/moments`));
    const pub = feed.moments.find((m: any) => m.id === q.id);
    assert.equal(pub.correctOption, undefined, 'right answer never sent to the page');
    const v = await view();
    assert.equal((await play(q.id, v.token, 'v0', 'b')).body.error.code, 'too_early');
    await watch(v.token, 60);
    const r = await expectOk(play(q.id, v.token, 'v0', 'b'));
    assert.deepEqual([r.result.correct, r.result.correctOption], [true, 'b']);
    assert.equal((await play(q.id, v.token, 'v0', 'a')).body.error.code, 'already_played');
    assert.equal((await play(q.id, v.token, 'v1', 'a')).body.error.code, 'too_early', 'second run at 180 s');
    assert.equal((await play(q.id, v.token, 'v2', 'a')).body.error.code, 'moment_closed', 'only 2 runs');
    const back = await view({ viewerKey: v.viewerKey });
    assert.deepEqual(back.done, [`${q.id}:v0`], 'a returning viewer gets no repeat');
  });

  it('stream clock: one run for everyone when the show reaches its time; late joiners skip a closed run', async () => {
    const p = await make({ type: 'poll', title: 'Who wins?', clock: 'stream', atSec: 300, openSec: 60, options: [{ id: 'a', text: 'Team A' }, { id: 'b', text: 'Team B' }] });
    await h.db.query("UPDATE tournaments SET first_live_at = now() - interval '200 seconds' WHERE id = $1", [tid]);
    let t = (await h.app.repo.tournamentById(tid))!;
    assert.equal(await h.app.moments.tick(t), 0, 'not yet');
    await h.db.query("UPDATE tournaments SET first_live_at = now() - interval '310 seconds' WHERE id = $1", [tid]);
    t = (await h.app.repo.tournamentById(tid))!;
    assert.equal(await h.app.moments.tick(t), 1);
    assert.equal(await h.app.moments.tick(t), 0, 'opened once');
    const feed = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/moments`, undefined, owner.token));
    const run = feed.runs.find((r: any) => r.momentId === p.id);
    const a = await view();
    const b = await view();
    await expectOk(play(p.id, a.token, run.id, 'a'));
    const rb = await expectOk(play(p.id, b.token, run.id, 'a'));
    assert.deepEqual(rb.result.results.map((x: any) => [x.id, x.votes, x.percent]), [['a', 2, 100], ['b', 0, 0]]);
    await h.db.query("UPDATE moment_runs SET closes_at = now() - interval '10 seconds' WHERE id = $1", [run.id]);
    const c = await view();
    assert.equal((await play(p.id, c.token, run.id, 'b')).body.error.code, 'moment_closed');
  });

  it('director clock: fired from the control room; a prediction is settled afterwards', async () => {
    const pr = await make({ type: 'prediction', title: 'Next hole', question: 'Birdie on 18?', clock: 'director', openSec: 120, options: [{ id: 'y', text: 'Yes' }, { id: 'n', text: 'No' }] });
    const director = await addStaff(h, owner.token, owner.orgId, 'dir@club.test', 'director');
    const fired = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/moments/${pr.id}/fire`, {}, director));
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/moments/${pr.id}/fire`, {}, director)).body.error.code, 'moment_running');
    const a = await view();
    const b = await view();
    await expectOk(play(pr.id, a.token, fired.run.id, 'y'));
    await expectOk(play(pr.id, b.token, fired.run.id, 'n'));
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/moments/${pr.id}/resolve`, { correctOption: 'y' }, director));
    const feed = await expectOk(api(h, 'GET', `/api/public/tournaments/${tid}/moments`));
    assert.equal(feed.runs.find((r: any) => r.runKey === fired.run.id).correctOption, 'y');
    const rep = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/moments/report`, undefined, owner.token));
    const row = rep.moments.find((m: any) => m.id === pr.id);
    assert.deepEqual([row.runs, row.played, row.correctRate], [1, 2, 50]);
  });

  it('spin: the server draws the segment by its weights; audience rules apply', async () => {
    const inf = (await expectOk(api(h, 'POST', `/api/tournaments/${tid}/influencers`, { name: 'Ravi' }, owner.token))).influencer;
    const sp = await make({
      type: 'spin', title: 'Spin the wheel', clock: 'viewer', atSec: 0, openSec: 600, audience: 'ref', audienceRef: inf.id,
      options: [{ id: 'nope', text: 'Try again', weight: 0 }, { id: 'win', text: '₹100 coupon', weight: 1, win: true }],
    });
    const outsider = await view();
    assert.equal((await play(sp.id, outsider.token, 'v0')).body.error.code, 'not_for_you');
    const fan = await view({ ref: inf.slug });
    await api(h, 'POST', `/api/public/moments/${sp.id}/seen`, { token: fan.token, runKey: 'v0', kind: 'shown' });
    const r = await expectOk(play(sp.id, fan.token, 'v0'));
    assert.deepEqual([r.result.segment, r.result.win], ['win', true], 'weight 0 never lands');
    const feed = await expectOk(api(h, 'GET', `/api/public/tournaments/${tid}/moments`));
    assert.equal(feed.moments.find((m: any) => m.id === sp.id).audienceRef, inf.slug);
  });

  it('the report shows shown / played / closed and extra watch time of players', async () => {
    const q = await make({ type: 'poll', title: 'Fav club', clock: 'viewer', atSec: 0, openSec: 600, options: [{ id: 'a', text: 'Driver' }, { id: 'b', text: 'Putter' }] });
    const p1 = await view();
    const p2 = await view();
    for (const v of [p1, p2]) await api(h, 'POST', `/api/public/moments/${q.id}/seen`, { token: v.token, runKey: 'v0', kind: 'shown' });
    await expectOk(play(q.id, p1.token, 'v0', 'a'));
    await api(h, 'POST', `/api/public/moments/${q.id}/seen`, { token: p2.token, runKey: 'v0', kind: 'dismissed' });
    await watch(p1.token, 90);
    await watch(p2.token, 30);
    const rep = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/moments/report`, undefined, owner.token));
    const row = rep.moments.find((m: any) => m.id === q.id);
    assert.deepEqual([row.shown, row.played, row.dismissed, row.playRate], [2, 1, 1, 50]);
    assert.deepEqual(row.watchAfterSec, { played: 90, skipped: 30 });
    assert.equal(row.extraWatchSec, 60);
  });
});
