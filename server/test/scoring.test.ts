import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeLeaderboard, parsePlayerList, toParText } from '../src/scoring.js';
import { applyGraphicsPatch } from '../src/graphics.js';
import { defaultGraphics } from '../src/protocol.js';
import { addStaff, api, createTournament, expectOk, joinAsGuest, signup, startHarness, type Harness } from './helpers.js';

describe('leaderboard maths', () => {
  const holes = [
    { number: 1, par: 4, yardage: 400 },
    { number: 2, par: 3, yardage: 160 },
    { number: 3, par: 5, yardage: 520 },
  ];
  const p = (id: string, name: string) => ({ id, tournament_id: 't', name, club: null, category: id === 'd' ? 'Ladies' : 'Open', group_no: 1, sort_order: 0 });
  const players = [p('a', 'Aman'), p('b', 'Bina'), p('c', 'Chirag'), p('d', 'Dia')];
  const s = (player_id: string, hole: number, strokes: number) => ({ player_id, hole, strokes });

  it('ranks by score to par with ties, thru and unplayed players last', () => {
    const rows = computeLeaderboard(players, holes, [
      s('a', 1, 3), s('a', 2, 3), // -1 thru 2
      s('b', 1, 4), s('b', 2, 2), s('b', 3, 5), // -1 thru F
      s('c', 1, 6), // +2 thru 1
    ]);
    assert.deepEqual(
      rows.map((r) => [r.name, r.position, r.toParText, r.thru]),
      [
        ['Bina', 'T1', '-1', 'F'],
        ['Aman', 'T1', '-1', '2'],
        ['Chirag', '3', '+2', '1'],
        ['Dia', '', '–', '–'],
      ],
    );
  });

  it('filters by category and formats to-par', () => {
    assert.equal(computeLeaderboard(players, holes, [], 'Ladies').length, 1);
    assert.deepEqual([toParText(0), toParText(3), toParText(-2), toParText(null)], ['E', '+3', '-2', '–']);
  });

  it('parses pasted player lists (CSV or tab separated, header optional)', () => {
    const list = parsePlayerList('Name,Club,Category,Group\nAman Sharma, DLF, Open, 1\n"Bina Rao",Classic,Ladies,2\n\nChirag\tKGA\tOpen\t3');
    assert.deepEqual(list, [
      { name: 'Aman Sharma', club: 'DLF', category: 'Open', groupNo: 1 },
      { name: 'Bina Rao', club: 'Classic', category: 'Ladies', groupNo: 2 },
      { name: 'Chirag', club: 'KGA', category: 'Open', groupNo: 3 },
    ]);
  });

  it('graphics patches are validated and merged', () => {
    const g = applyGraphicsPatch(defaultGraphics(), {
      leaderboard: { visible: true, size: 99, category: 'Ladies' },
      lowerThird: { visible: 'yes', title: 'x'.repeat(100) },
      holeCard: { hole: 40, durationSec: 1 },
      bogus: true,
    });
    assert.equal(g.leaderboard.visible, true);
    assert.equal(g.leaderboard.size, 15);
    assert.equal(g.leaderboard.category, 'Ladies');
    assert.equal(g.lowerThird.visible, false, 'non-boolean ignored');
    assert.equal(g.lowerThird.title.length, 60);
    assert.equal(g.holeCard.hole, null, 'out-of-range hole ignored');
    assert.equal(g.holeCard.durationSec, 2);
  });
});

describe('scoring API and graphics feed', () => {
  let h: Harness;
  let owner: { token: string; orgId: string };
  let directorToken: string;
  let scorerGuest: string;
  let tournamentId: string;
  let players: any[];

  before(async () => {
    h = await startHarness();
    owner = await signup(h, 'owner@club.test');
    directorToken = await addStaff(h, owner.token, owner.orgId, 'd@club.test', 'director');
    tournamentId = await createTournament(h, owner.token, owner.orgId, { name: 'Gurgaon Classic' });
    scorerGuest = await joinAsGuest(h, owner.token, tournamentId, 'scorer', 'scorer-phone-001', 'Scorer 1');
  });
  after(async () => h.close());

  it('managers set the course and players; scorers cannot', async () => {
    const holes = await expectOk(api(h, 'PUT', `/api/tournaments/${tournamentId}/holes`, { preset: 'par72' }, directorToken));
    assert.equal(holes.holes.length, 18);
    assert.equal(holes.holes.reduce((a: number, x: any) => a + x.par, 0), 72);
    await expectOk(api(h, 'PUT', `/api/tournaments/${tournamentId}/holes`, { holes: holes.holes.map((x: any) => (x.number === 7 ? { ...x, yardage: 412 } : x)) }, directorToken));
    assert.equal((await api(h, 'PUT', `/api/tournaments/${tournamentId}/holes`, { preset: 'par72' }, scorerGuest)).status, 403);
    const r = await expectOk(
      api(h, 'POST', `/api/tournaments/${tournamentId}/players`, { csv: 'Aman Sharma,DLF,Open,1\nBina Rao,Classic,Ladies,1\nChirag Jain,KGA,Open,2' }, directorToken),
    );
    players = r.players;
    assert.equal(players.length, 3);
    assert.equal((await api(h, 'POST', `/api/tournaments/${tournamentId}/players`, { players: [{ name: 'X' }] }, scorerGuest)).status, 403);
  });

  it('scorers enter strokes; the leaderboard updates; invalid holes are rejected', async () => {
    const put = (playerId: string, hole: number, strokes: number | null) =>
      api(h, 'PUT', `/api/tournaments/${tournamentId}/scores`, { playerId, hole, strokes }, scorerGuest);
    await expectOk(put(players[0].id, 1, 3));
    await expectOk(put(players[0].id, 2, 4));
    const r = await expectOk(put(players[1].id, 1, 4));
    assert.equal(r.player.toParText, 'E');
    assert.equal((await put(players[0].id, 19, 4)).status, 400);
    assert.equal((await put(players[0].id, 1, 0)).status, 400);
    const lb = await expectOk(api(h, 'GET', `/api/tournaments/${tournamentId}/leaderboard`, undefined, scorerGuest));
    assert.deepEqual(lb.rows.slice(0, 2).map((x: any) => [x.name, x.position, x.toParText, x.thru]), [
      ['Aman Sharma', '1', '-1', '2'],
      ['Bina Rao', '2', 'E', '1'],
    ]);
    await expectOk(put(players[0].id, 2, null));
    const lb2 = await expectOk(api(h, 'GET', `/api/tournaments/${tournamentId}/leaderboard?category=Ladies`, undefined, directorToken));
    assert.equal(lb2.rows.length, 1);
  });

  it('the overlay page and SSE feed use the graphics key; directors drive what is shown', async () => {
    const t = (await h.app.repo.tournamentById(tournamentId))!;
    assert.equal((await fetch(`${h.baseUrl}/graphics/${tournamentId}?k=wrong`)).status, 403);
    const page = await fetch(`${h.baseUrl}/graphics/${tournamentId}?k=${t.graphics_key}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /EventSource/);

    const ctrl = new AbortController();
    const res = await fetch(`${h.baseUrl}/api/graphics/${tournamentId}/events?k=${t.graphics_key}`, { signal: ctrl.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body!.getReader();
    const events: any[] = [];
    let buf = '';
    const next = async (pred: (e: any) => boolean) => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const found = events.find(pred);
        if (found) return found;
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (line) events.push(JSON.parse(line.slice(6)));
        }
      }
      throw new Error('no matching SSE event');
    };
    const first = await next(() => true);
    assert.equal(first.tournament.name, 'Gurgaon Classic');
    assert.equal(first.leaderboard, null);
    assert.equal(first.scoreBug.leader.name, 'A. Sharma');

    await expectOk(api(h, 'PATCH', `/api/tournaments/${tournamentId}/graphics`, { leaderboard: { visible: true } }, directorToken));
    const lb = await next((e) => e.leaderboard);
    assert.equal(lb.leaderboard.rows[0].name, 'A. Sharma');

    await expectOk(api(h, 'PATCH', `/api/tournaments/${tournamentId}/graphics`, { lowerThird: { visible: true, playerId: players[1].id } }, directorToken));
    const lt = await next((e) => e.lowerThird);
    assert.deepEqual(
      { title: lt.lowerThird.title, sub: lt.lowerThird.subtitle, pos: lt.lowerThird.position, par: lt.lowerThird.toPar },
      { title: 'Bina Rao', sub: 'Classic · Ladies', pos: '2', par: 'E' },
    );

    await expectOk(api(h, 'PATCH', `/api/tournaments/${tournamentId}/graphics`, { holeCard: { visible: true, hole: 7 } }, directorToken));
    const hc = await next((e) => e.holeCard);
    assert.deepEqual(hc.holeCard, { hole: 7, par: 3, yardage: 412, average: null });

    // A new score is pushed to the overlay without anyone touching graphics.
    await expectOk(api(h, 'PUT', `/api/tournaments/${tournamentId}/scores`, { playerId: players[2].id, hole: 1, strokes: 2 }, scorerGuest));
    const after = await next((e) => e.scoreBug?.leader?.name === 'C. Jain');
    assert.equal(after.scoreBug.leader.toPar, '-2');

    assert.equal((await api(h, 'PATCH', `/api/tournaments/${tournamentId}/graphics`, { leaderboard: { visible: false } }, scorerGuest)).status, 403);
    ctrl.abort();
  });
});
