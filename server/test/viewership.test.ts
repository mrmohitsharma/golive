import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';
import { describeAgent } from '../src/viewership.js';

const PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';
const INSTA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 350.0';

describe('viewership step 1: viewers, viewer clock, stream clock', () => {
  let h: Harness;
  let owner: { token: string; orgId: string; userId: string };
  let tid: string;

  const view = async (body: object, headers: Record<string, string> = {}) => {
    const r = await fetch(`${h.baseUrl}/api/public/tournaments/${tid}/view`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': PHONE, ...headers },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  const beat = async (token: string, playingSec: number, unmutedSec: number, asText = false) => {
    const r = await fetch(`${h.baseUrl}/api/public/view/beat`, {
      method: 'POST',
      headers: { 'content-type': asText ? 'text/plain;charset=UTF-8' : 'application/json' },
      body: JSON.stringify({ token, playingSec, unmutedSec }),
    });
    return { status: r.status, body: (await r.json()) as any };
  };

  before(async () => {
    h = await startHarness();
    owner = await signup(h, 'views@club.test', 'View Club');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'View Cup' });
  });
  after(async () => h.close());

  it('tells phones, Instagram and bots apart', () => {
    assert.deepEqual(describeAgent(PHONE), { device: 'mobile', app: 'browser', bot: false });
    assert.deepEqual(describeAgent(INSTA), { device: 'mobile', app: 'instagram', bot: false });
    assert.equal(describeAgent('Mozilla/5.0 HeadlessChrome/120').bot, true);
    assert.equal(describeAgent('').bot, true);
  });

  it('a viewer gets an id kept in the browser; the viewer clock continues on return', async () => {
    const a = await view({});
    assert.equal(a.status, 200);
    assert.match(a.body.viewerKey, /^[A-Za-z0-9_-]{16,64}$/);
    assert.deepEqual([a.body.watchedSec, a.body.streamClockSec, a.body.live, a.body.beatSec], [0, null, false, 30]);
    await beat(a.body.token, 30, 0);
    await beat(a.body.token, 30, 12, true); // sendBeacon sends text/plain
    await h.app.viewership.flush();
    const again = await view({ viewerKey: a.body.viewerKey });
    assert.equal(again.body.viewerKey, a.body.viewerKey);
    assert.equal(again.body.watchedSec, 60);
  });

  it('claims are capped; forged tokens are refused', async () => {
    const v = await view({});
    const r = await beat(v.body.token, 600, 600);
    assert.equal(r.body.addedSec, 38, 'at most 30 s plus slack per report');
    assert.equal((await beat(v.body.token.replace(/.$/, (c: string) => (c === 'a' ? 'b' : 'a')), 30, 0)).status, 401);
    assert.equal((await beat('x.y.z', 30, 0)).status, 401);
  });

  it('the stream clock starts at the first Go live and does not reset', async () => {
    await h.app.viewership.streamStarted(tid);
    const first = (await h.db.query('SELECT first_live_at FROM tournaments WHERE id = $1', [tid])).rows[0].first_live_at;
    await h.db.query("UPDATE tournaments SET first_live_at = now() - interval '10 minutes' WHERE id = $1", [tid]);
    await h.app.viewership.streamStarted(tid);
    const t = await h.app.repo.tournamentById(tid);
    assert.ok(first);
    const sec = h.app.viewership.streamClockSec(t!);
    assert.ok(sec! >= 599 && sec! <= 605, String(sec));
  });

  it('the director sees watching now, viewers, watch time, unmuted and bounces; bots are left out', async () => {
    const bot = await view({}, { 'user-agent': 'HeadlessChrome' });
    await beat(bot.body.token, 30, 30);
    const short = await view({}, { 'user-agent': INSTA });
    await beat(short.body.token, 10, 0);
    await h.app.viewership.snapshotMinute();
    const s = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/viewership`, undefined, owner.token));
    const v = s.viewership;
    assert.equal(v.flaggedViewers, 1);
    assert.equal(v.viewers, 3, 'played: 60 s, 38 s and 10 s viewers');
    assert.equal(v.qualifiedViewers, 2);
    assert.equal(v.bouncedViewers, 1);
    assert.equal(v.watchingNow, 3);
    assert.equal(v.unmutedRate, 67, 'two of three viewers unmuted at some point');
    assert.equal(v.apps.instagram, 1);
    assert.equal(v.replayMinutes, 2, 'not live: counted as replay');
    assert.equal(v.peakWatching, 3);
    assert.equal(v.series.length, 1);
    assert.deepEqual(s.playable, { ok: false, reason: 'Create the YouTube broadcast first (Start show does it).' });
  });

  it('caps viewers from one network', async () => {
    const h2 = await startHarness({ env: { VIEW_NET_CAP: '2' } });
    try {
      const o = await signup(h2, 'cap@club.test');
      const t2 = await createTournament(h2, o.token, o.orgId);
      const go = () => fetch(`${h2.baseUrl}/api/public/tournaments/${t2}/view`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': PHONE }, body: '{}' });
      for (let i = 0; i < 3; i++) await go();
      const rows = (await h2.db.query('SELECT flagged FROM viewers WHERE tournament_id = $1 ORDER BY first_seen_at', [t2])).rows.map((r: any) => r.flagged);
      assert.deepEqual(rows, [false, false, true]);
    } finally {
      await h2.close();
    }
  });
});
