import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';
let ip = 1;

describe('viewership step 4: prizes, lucky draw, claims', () => {
  let h: Harness;
  let owner: { token: string; orgId: string; userId: string };
  let tid: string;

  const view = async () =>
    (await (
      await fetch(`${h.baseUrl}/api/public/tournaments/${tid}/view`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': UA, 'x-forwarded-for': `10.7.${ip++}.1` },
        body: '{}',
      })
    ).json()) as any;
  const beat = async (token: string, sec = 30, unmuted = 0) =>
    (await (await fetch(`${h.baseUrl}/api/public/view/beat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, playingSec: sec, unmutedSec: unmuted }) })).json()) as any;
  const watch = async (token: string, sec: number) => {
    for (let s = 0; s < sec; s += 30) await beat(token, Math.min(30, sec - s));
  };
  const make = async (body: object) => (await expectOk(api(h, 'POST', `/api/tournaments/${tid}/moments`, body, owner.token))).moment;
  const play = (mid: string, token: string, runKey: string, answer?: string) => api(h, 'POST', `/api/public/moments/${mid}/play`, { token, runKey, answer });
  const lastOtp = () => /^(\d{6}) is your Go Live code/.exec(h.app.messenger.sentInTest.filter((m) => m.kind === 'otp').at(-1)!.text)![1];

  before(async () => {
    h = await startHarness();
    owner = await signup(h, 'prize@club.test', 'Prize Club');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'Prize Day' });
  });
  after(async () => h.close());

  it('a prize needs a description, stock and (for wheels) a winning and a losing segment', async () => {
    const code = async (b: object) => (await api(h, 'POST', `/api/tournaments/${tid}/moments`, b, owner.token)).body.error.code;
    const wheel = { type: 'spin', title: 'W', clock: 'viewer', atSec: 0, options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B', win: true }] };
    assert.equal(await code({ ...wheel, pick: 'spin', prizeStock: 1 }), 'need_prize');
    assert.equal(await code({ ...wheel, pick: 'spin', prize: '₹100' }), 'need_stock');
    assert.equal(await code({ ...wheel, options: [{ id: 'a', text: 'A', win: true }, { id: 'b', text: 'B', win: true }], pick: 'spin', prize: 'x', prizeStock: 1 }), 'need_lose_segment');
    assert.equal(await code({ type: 'poll', title: 'P', clock: 'director', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], pick: 'first_correct', prize: 'x', prizeStock: 1 }), 'bad_pick');
  });

  it('wheel: wins only while prizes last, for eligible viewers; the page hears about it', async () => {
    const w = await make({
      type: 'spin', title: 'Spin', clock: 'viewer', atSec: 0, openSec: 600, pick: 'spin', prize: '₹100 voucher', sponsor: 'Acme', prizeStock: 1, minWatchSec: 60,
      options: [{ id: 'lose', text: 'Try again', weight: 0 }, { id: 'win', text: '₹100 voucher', weight: 1, win: true }],
    });
    const early = await view();
    const r0 = await expectOk(play(w.id, early.token, 'v0'));
    assert.deepEqual([r0.result.segment, r0.result.prize], ['lose', undefined], 'watched under a minute: lands on a losing segment');
    const a = await view();
    await watch(a.token, 60);
    const r1 = await expectOk(play(w.id, a.token, 'v0'));
    assert.equal(r1.result.segment, 'win');
    assert.equal(r1.result.prize.prize, '₹100 voucher');
    assert.match(r1.result.prize.claimUrl, /^https:\/\/live\.example\.com\/claim\/[\w-]{12}$/);
    const told = await beat(a.token, 5);
    assert.equal(told.wins[0].prize, '₹100 voucher');
    assert.equal((await beat(a.token, 5)).wins, undefined, 'told once');
    const b = await view();
    await watch(b.token, 60);
    assert.equal((await expectOk(play(w.id, b.token, 'v0'))).result.segment, 'lose', 'stock used up');
  });

  it('quiz: the first right answers win, up to the per-run limit', async () => {
    const q = await make({
      type: 'quiz', title: 'Quiz', clock: 'director', openSec: 120, options: [{ id: 'a', text: '9' }, { id: 'b', text: '18' }], correctOption: 'b',
      pick: 'first_correct', prize: 'Cap', prizeStock: 5, winnersPerRun: 1, minWatchSec: 0,
    });
    const run = (await expectOk(api(h, 'POST', `/api/tournaments/${tid}/moments/${q.id}/fire`, {}, owner.token))).run;
    const [x, y, z] = [await view(), await view(), await view()];
    assert.equal((await expectOk(play(q.id, x.token, run.id, 'a'))).result.prize, undefined, 'wrong answer');
    assert.equal((await expectOk(play(q.id, y.token, run.id, 'b'))).result.prize.prize, 'Cap');
    assert.equal((await expectOk(play(q.id, z.token, run.id, 'b'))).result.prize, undefined, 'one winner per run');
  });

  it('lucky draw: phone entry, only entrants still watching can win, reserves, SMS, claim with a code', async () => {
    const d = await make({ type: 'draw', title: 'Lucky draw', clock: 'viewer', atSec: 0, openSec: 600, prize: 'Golf bag', prizeStock: 1, reserves: 1, minWatchSec: 30, claimHours: 24 });
    assert.equal(d.pick, 'draw');
    const people = [await view(), await view(), await view()];
    const phones = ['9800000001', '9800000002', '9800000003'];
    for (let i = 0; i < 3; i++) {
      await watch(people[i].token, 30);
      const r = await api(h, 'POST', `/api/public/moments/${d.id}/enter`, { token: people[i].token, runKey: 'v0', phone: phones[i], consent: true });
      assert.equal(r.status, 201);
    }
    assert.equal((await api(h, 'POST', `/api/public/moments/${d.id}/enter`, { token: people[0].token, runKey: 'v0', phone: phones[0], consent: true })).body.already, true);
    assert.equal((await api(h, 'POST', `/api/public/moments/${d.id}/enter`, { token: people[0].token, runKey: 'v0', phone: phones[0] })).status, 400, 'consent needed');
    assert.ok(h.app.messenger.sentInTest.some((m) => m.kind === 'draw_entry' && m.text.includes('Prize Day lucky draw')));
    // Entrant 3 has left (no report in the last 75 s): only 1 and 2 are in the draw.
    (h.app.viewership as any).presence.get(tid).delete(people[2].viewer?.id ?? (await h.db.query('SELECT viewer_id FROM draw_entries WHERE phone = $1', ['919800000003'])).rows[0].viewer_id);
    const res = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/moments/${d.id}/draw`, {}, owner.token));
    assert.deepEqual(res.draw, { pool: 2, eligible: 2, winners: 1, reserves: 1 });
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/moments/${d.id}/draw`, {}, owner.token)).body.error.code, 'draw_done');
    const wins = (await expectOk(api(h, 'GET', `/api/tournaments/${tid}/winners`, undefined, owner.token))).winners.filter((w: any) => w.game === 'Lucky draw');
    const winner = wins.find((w: any) => w.status === 'won');
    assert.ok(winner && wins.some((w: any) => w.status === 'reserve'));
    const sms = h.app.messenger.sentInTest.filter((m) => m.kind === 'winner').at(-1)!;
    assert.match(sms.text, /^You won Golf bag in Prize Day! Claim within 24 hours: https:\/\/live\.example\.com\/claim\//);
    const code = sms.text.split('/claim/')[1].split(' ')[0];
    // Claim: the code goes to the number they entered with; a wrong number is refused.
    const info = await expectOk(api(h, 'GET', `/api/public/claims/${code}`));
    assert.match(info.phoneHint, /^91\*{6}\d{4}$/);
    assert.equal((await api(h, 'POST', `/api/public/claims/${code}/otp`, { phone: '9811111111' })).body.error.code, 'wrong_phone');
    await expectOk(api(h, 'POST', `/api/public/claims/${code}/otp`, {}));
    assert.equal((await api(h, 'POST', `/api/public/claims/${code}/verify`, { otp: '000000', email: 'w@x.test', consent: true })).body.error.code, 'otp_wrong');
    await expectOk(api(h, 'POST', `/api/public/claims/${code}/verify`, { otp: lastOtp(), email: 'Win@X.test', consent: true }));
    assert.equal((await expectOk(api(h, 'GET', `/api/public/claims/${code}`))).status, 'claimed');
    assert.equal((await api(h, 'POST', `/api/public/claims/${code}/otp`, {})).body.error.code, 'already_claimed');
    const log = (await expectOk(api(h, 'GET', `/api/tournaments/${tid}/winners`, undefined, owner.token))).log.find((l: any) => l.game === 'Lucky draw');
    assert.deepEqual([log.method, log.eligible, log.winners, log.reserves], ['lucky_draw', 2, 1, 1]);
  });

  it('an unclaimed prize passes to the reserve; organisers export winners and mark prizes sent', async () => {
    const q = await make({ type: 'poll', title: 'Raffle poll', clock: 'director', openSec: 60, options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], pick: 'draw', prize: 'Shirt', prizeStock: 1, reserves: 1, minWatchSec: 0, claimHours: 1 });
    const run = (await expectOk(api(h, 'POST', `/api/tournaments/${tid}/moments/${q.id}/fire`, {}, owner.token))).run;
    const [a, b] = [await view(), await view()];
    await expectOk(play(q.id, a.token, run.id, 'a'));
    await expectOk(play(q.id, b.token, run.id, 'b'));
    await h.db.query("UPDATE moment_runs SET closes_at = now() - interval '1 minute' WHERE id = $1", [run.id]);
    await h.app.prizes.tick((await h.app.repo.tournamentById(tid))!);
    let wins = (await h.db.query("SELECT status FROM wins WHERE moment_id = $1 ORDER BY status", [q.id])).rows.map((r: any) => r.status);
    assert.deepEqual(wins, ['reserve', 'won']);
    await h.db.query("UPDATE wins SET claim_expires_at = now() - interval '1 second' WHERE moment_id = $1 AND status = 'won'", [q.id]);
    assert.equal(await h.app.prizes.expire(tid), 1);
    wins = (await h.db.query('SELECT status FROM wins WHERE moment_id = $1 ORDER BY status', [q.id])).rows.map((r: any) => r.status);
    assert.deepEqual(wins, ['expired', 'won'], 'the reserve now holds the prize');
    const all = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/winners`, undefined, owner.token));
    const claimed = all.winners.find((w: any) => w.status === 'claimed');
    assert.equal(claimed.email, 'win@x.test');
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/winners/${claimed.id}/sent`, {}, owner.token));
    const csv = await fetch(`${h.baseUrl}/api/tournaments/${tid}/winners.csv`, { headers: { authorization: `Bearer ${owner.token}` } });
    const text = await csv.text();
    assert.match(text.split('\r\n')[0], /^"Game","Prize","Sponsor","Status","Phone","Email"/);
    assert.match(text, /"Lucky draw","Golf bag","","sent","9198000000\d\d","win@x\.test"/);
    const stock = all.stock.find((s: any) => s.title === 'Lucky draw');
    assert.deepEqual([stock.stock, stock.left, stock.entries], [1, 0, 3]);
    const terms = await (await fetch(`${h.baseUrl}/prize-terms/${tid}`)).text();
    assert.match(terms, /Free to take part/);
    assert.match(terms, /Golf bag ×1/);
    assert.match(terms, /Sharing on social media is optional/);
  });
});
