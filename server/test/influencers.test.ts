import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addStaff, api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';
import { maskPhone, normalisePhone } from '../src/messaging.js';

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';

describe('viewership step 2: influencer links', () => {
  let h: Harness;
  let owner: { token: string; orgId: string; userId: string };
  let tid: string;

  const view = async (ref: string | null, viewerKey?: string) => {
    const r = await fetch(`${h.baseUrl}/api/public/tournaments/${tid}/view`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': PHONE_UA },
      body: JSON.stringify({ ref, viewerKey }),
    });
    return (await r.json()) as any;
  };
  const watch = async (token: string, sec: number, unmuted = 0) =>
    fetch(`${h.baseUrl}/api/public/view/beat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, playingSec: sec, unmutedSec: unmuted }) });

  before(async () => {
    h = await startHarness();
    owner = await signup(h, 'inf@club.test', 'Promo Club');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'Sunday Cup' });
  });
  after(async () => h.close());

  it('phone numbers are normalised and masked', () => {
    assert.equal(normalisePhone('+91 98123 45678'), '919812345678');
    assert.equal(normalisePhone('09812345678'), '919812345678');
    assert.equal(normalisePhone('9812345678'), '919812345678');
    assert.throws(() => normalisePhone('12345'));
    assert.throws(() => normalisePhone('915812345678'));
    assert.equal(maskPhone('919812345678'), '91******5678');
  });

  it('organisers add influencers: short link, slug, PAN kept encrypted; directors cannot add', async () => {
    const r = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/influencers`, { name: 'Ravi Kumar', handle: '@ravi.golf', pan: 'abcde1234f', terms: '₹2 per viewer' }, owner.token));
    const inf = r.influencer;
    assert.equal(inf.slug, 'ravigolf');
    assert.match(inf.link, /^https:\/\/live\.example\.com\/w\/sunday-cup-[0-9a-f]{4}\/ravigolf$/);
    assert.equal(inf.panHint, 'AB******4F');
    const row = (await h.db.query('SELECT pan_enc FROM influencers WHERE id = $1', [inf.id])).rows[0];
    assert.ok(!row.pan_enc.includes('ABCDE1234F'));
    const dup = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/influencers`, { name: 'Ravi', handle: 'ravi.golf' }, owner.token));
    assert.equal(dup.influencer.slug, 'ravigolf-2');
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/influencers`, { name: 'X', pan: 'BAD' }, owner.token)).body.error.code, 'bad_pan');
    const scorer = await addStaff(h, owner.token, owner.orgId, 'sc@club.test', 'scorer');
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/influencers`, { name: 'Y' }, scorer)).status, 403);
    const list = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/influencers`, undefined, owner.token));
    assert.equal(list.influencers.length, 2);
    assert.equal(list.playable.ok, false, 'no broadcast yet: links still work, the page shows Remind me');
  });

  it('the short link has its own preview for WhatsApp; taps count, link previews do not', async () => {
    const list = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/influencers`, undefined, owner.token));
    const inf = list.influencers[0];
    const path = new URL(inf.link).pathname;
    const preview = await fetch(h.baseUrl + path, { headers: { 'user-agent': 'WhatsApp/2.23.20.0 A' } });
    const html = await preview.text();
    assert.match(html, /og:title" content="Ravi Kumar invites you to watch Sunday Cup"/);
    assert.match(html, new RegExp(`location.replace\\("/watch/${tid}\\?r=ravigolf"\\)`));
    await fetch(h.baseUrl + path, { headers: { 'user-agent': PHONE_UA } });
    await fetch(h.baseUrl + path, { headers: { 'user-agent': PHONE_UA } });
    const clicks = (await h.db.query('SELECT count(*)::int AS n FROM influencer_clicks WHERE influencer_id = $1', [inf.id])).rows[0].n;
    assert.equal(clicks, 2);
    assert.equal((await fetch(`${h.baseUrl}/w/nope/ravigolf`)).status, 404);
    const kit = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/influencers/${inf.id}/kit`, undefined, owner.token));
    assert.ok(kit.qrSvg.startsWith('<svg'));
    assert.equal(kit.influencer.name, 'Ravi Kumar');
  });

  it('viewers are credited to the first link; reports rank influencers', async () => {
    const a = await view('ravigolf');
    await watch(a.token, 30, 30);
    await watch(a.token, 30, 0);
    const again = await view('ravigolf-2', a.viewerKey); // second link: first one keeps the credit
    await watch(again.token, 20);
    const b = await view('ravigolf-2');
    await watch(b.token, 10);
    const direct = await view(null);
    await watch(direct.token, 30);
    const s = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/influencers/stats`, undefined, owner.token));
    const [first, second] = s.influencers;
    assert.deepEqual([first.slug ?? first.name, first.viewers, first.qualifiedViewers, first.watchMinutes, first.unmutedRate, first.watchingNow, first.clicks], ['Ravi Kumar', 1, 1, 1, 100, 1, 2]);
    assert.deepEqual([second.viewers, second.qualifiedViewers, second.bouncedViewers], [1, 0, 1]);
    assert.deepEqual([s.totals.viewers, s.totals.viaLinks, s.totals.viaLinksShare], [3, 2, 67]);
  });

  it('Remind me: one entry per number, sent once when the stream starts (test sender)', async () => {
    const ok = await api(h, 'POST', `/api/public/tournaments/${tid}/remind`, { phone: '98123 45678', consent: true, ref: 'ravigolf' });
    assert.equal(ok.status, 201);
    assert.equal((await api(h, 'POST', `/api/public/tournaments/${tid}/remind`, { phone: '+919812345678', consent: true })).status, 200);
    assert.equal((await api(h, 'POST', `/api/public/tournaments/${tid}/remind`, { phone: '9812345679' })).status, 400, 'consent required');
    const t = (await h.app.repo.tournamentById(tid))!;
    assert.equal(await h.app.influencers.sendReminders(t), 1);
    assert.equal(await h.app.influencers.sendReminders(t), 0, 'once');
    const sent = h.app.messenger.sentInTest.at(-1)!;
    assert.equal(sent.text, `Sunday Cup is live now on Go Live. Watch: https://live.example.com/watch/${tid}`);
    const out = (await h.db.query('SELECT kind, to_masked, provider, status FROM messages WHERE tournament_id = $1', [tid])).rows;
    assert.deepEqual(out, [{ kind: 'reminder', to_masked: '91******5678', provider: 'test', status: 'sent' }]);
    const s = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/influencers/stats`, undefined, owner.token));
    assert.equal(s.influencers[0].reminders, 1);
  });

  it('the influencer sees only their numbers and the board; a new key retires the old link', async () => {
    const list = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/influencers`, undefined, owner.token));
    const inf = list.influencers[0];
    const key = new URL(inf.statsUrl).pathname.split('/').pop();
    const p = await expectOk(api(h, 'GET', `/api/public/influencer/${key}`));
    assert.deepEqual([p.you.rank, p.you.of, p.you.qualifiedViewers, p.board.length, p.board[0].you], [1, 2, 1, 2, true]);
    assert.equal(p.you.id, undefined);
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/viewership-settings`, { influencerBoard: false }, owner.token));
    assert.equal((await expectOk(api(h, 'GET', `/api/public/influencer/${key}`))).board, null);
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/influencers/${inf.id}/rotate-stats`, {}, owner.token));
    assert.equal((await api(h, 'GET', `/api/public/influencer/${key}`)).status, 404);
    const page = await fetch(`${h.baseUrl}/i/${key}`);
    assert.match(await page.text(), /your stats/);
  });

  it('MSG91: one Flow API call with every recipient and the template variables', async () => {
    const calls: any[] = [];
    const msg91Fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ type: 'success', message: 'ok' }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const h2 = await startHarness({ msg91Fetch, env: { MSG91_AUTH_KEY: 'auth-123', MSG91_TEMPLATE_REMINDER: 'tpl-rem' } });
    try {
      const o = await signup(h2, 'm@club.test');
      const t2 = await createTournament(h2, o.token, o.orgId, { name: 'Msg Cup' });
      for (const p of ['9812345678', '9812345670']) await api(h2, 'POST', `/api/public/tournaments/${t2}/remind`, { phone: p, consent: true });
      assert.equal(await h2.app.influencers.sendReminders((await h2.app.repo.tournamentById(t2))!), 2);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://control.msg91.com/api/v5/flow');
      assert.equal(calls[0].headers.authkey, 'auth-123');
      assert.equal(calls[0].body.template_id, 'tpl-rem');
      assert.deepEqual(calls[0].body.recipients.map((r: any) => [r.mobiles, r.var1]), [['919812345678', 'Msg Cup'], ['919812345670', 'Msg Cup']]);
    } finally {
      await h2.close();
    }
  });
});
