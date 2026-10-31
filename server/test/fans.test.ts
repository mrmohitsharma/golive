import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';
let ip = 1;

describe('watch page: points, Top players, names and reactions', () => {
  let h: Harness;
  let owner: { token: string; orgId: string; userId: string };
  let tid: string;

  const view = async (body: object = {}, ua = UA) =>
    (await (
      await fetch(`${h.baseUrl}/api/public/tournaments/${tid}/view`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': ua, 'x-forwarded-for': `10.7.${ip++}.1` },
        body: JSON.stringify(body),
      })
    ).json()) as any;
  const play = (mid: string, token: string, runKey: string, answer?: string, ua = UA) =>
    fetch(`${h.baseUrl}/api/public/moments/${mid}/play`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': ua }, body: JSON.stringify({ token, runKey, answer }) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  const make = async (body: object) => (await expectOk(api(h, 'POST', `/api/tournaments/${tid}/moments`, body, owner.token))).moment;
  const fire = async (mid: string) => (await expectOk(api(h, 'POST', `/api/tournaments/${tid}/moments/${mid}/fire`, {}, owner.token))).run.id as string;

  before(async () => {
    h = await startHarness();
    owner = await signup(h, 'fans@club.test', 'Fans Club');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'Fan Day' });
  });
  after(async () => h.close());

  it('a right answer earns 100 points, a play 10; a settled prediction adds 100; Top players ranks them', async () => {
    const quiz = await make({ type: 'quiz', title: 'Quiz', question: 'Holes?', clock: 'director', openSec: 120, options: [{ id: 'a', text: '9' }, { id: 'b', text: '18' }], correctOption: 'b' });
    const pred = await make({ type: 'prediction', title: 'Birdie?', clock: 'director', openSec: 120, options: [{ id: 'y', text: 'Yes' }, { id: 'n', text: 'No' }] });
    const a = await view();
    const b = await view();
    const qr = await fire(quiz.id);
    const ra = (await play(quiz.id, a.token, qr, 'b')).body.result;
    assert.deepEqual([ra.correct, ra.points, ra.totalPoints], [true, 100, 100]);
    const rb = (await play(quiz.id, b.token, qr, 'a')).body.result;
    assert.deepEqual([rb.correct, rb.points, rb.totalPoints], [false, 10, 10]);
    const pr = await fire(pred.id);
    assert.equal((await play(pred.id, b.token, pr, 'y')).body.result.points, 10);
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/moments/${pred.id}/resolve`, { correctOption: 'y' }, owner.token));
    const named = await expectOk(api(h, 'POST', '/api/public/view/nickname', { token: b.token, name: '  Lucky   Putt ' }));
    assert.equal(named.name, 'Lucky Putt');
    const fans = await expectOk(api(h, 'GET', `/api/public/tournaments/${tid}/fans?token=${encodeURIComponent(a.token)}`));
    assert.deepEqual(fans.top.map((x: any) => [x.rank, x.name, x.points, x.correct]), [[1, 'Lucky Putt', 110, 1], [2, fans.top[1].name, 100, 1]]);
    assert.match(fans.top[1].name, /^Fan [0-9A-F]{4}$/);
    assert.deepEqual([fans.me.rank, fans.me.me, fans.players], [2, true, 2]);
    const back = await view({ viewerKey: b.viewerKey });
    assert.deepEqual([back.points, back.nickname], [110, 'Lucky Putt']);
  });

  it('a viewer on a busy network (over the cap) still plays and earns points, but cannot win prizes; bots are refused', async () => {
    const poll = await make({ type: 'poll', title: 'Fav?', clock: 'director', openSec: 120, options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] });
    const v = await view();
    await h.db.query('UPDATE viewers SET flagged = true WHERE viewer_key = $1', [v.viewerKey]);
    const busy = await view({ viewerKey: v.viewerKey });
    const run = await fire(poll.id);
    const r = await play(poll.id, busy.token, run, 'a');
    assert.equal(r.status, 200);
    assert.equal(r.body.result.points, 10);
    const bot = await view({}, 'Mozilla/5.0 HeadlessChrome/130.0');
    assert.equal((await play(poll.id, bot.token, run, 'a', 'Mozilla/5.0 HeadlessChrome/130.0')).body.error.code, 'not_counted');
  });

  it('names are checked; reactions count up and show in the games feed; too many are slowed down', async () => {
    const v = await view();
    assert.equal((await api(h, 'POST', '/api/public/view/nickname', { token: v.token, name: 'x' })).body.error.code, 'bad_name');
    for (let i = 0; i < 3; i++) await expectOk(api(h, 'POST', `/api/public/tournaments/${tid}/react`, { kind: 'fire' }));
    await expectOk(api(h, 'POST', `/api/public/tournaments/${tid}/react`, { kind: 'clap' }));
    assert.equal((await api(h, 'POST', `/api/public/tournaments/${tid}/react`, { kind: 'boo' })).status, 400);
    const feed = await expectOk(api(h, 'GET', `/api/public/tournaments/${tid}/moments`));
    assert.deepEqual(feed.reactions, { clap: 1, fire: 3, golf: 0 });
    let last = 202;
    for (let i = 0; i < 20 && last !== 429; i++) last = (await api(h, 'POST', `/api/public/tournaments/${tid}/react`, { kind: 'golf' })).status;
    assert.equal(last, 429);
  });
});
