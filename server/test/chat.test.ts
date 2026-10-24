import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addStaff, api, createTournament, expectOk, joinAsGuest, signup, startHarness, TestSocket, type Harness } from './helpers.js';

/** Fake Google (token refresh, broadcast snippet, live chat) and Facebook (live comments). */
function fakes() {
  const yt: { pages: { items: object[]; next: string }[]; calls: string[]; quota: boolean } = { pages: [], calls: [], quota: false };
  const fb: { comments: object[]; calls: number } = { comments: [], calls: 0 };
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const googleFetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === '/token') return json(200, { access_token: 'yt-access', expires_in: 3600 });
    if (url.pathname === '/yt/liveBroadcasts') return json(200, { items: [{ snippet: { liveChatId: 'chat-1' } }] });
    if (url.pathname === '/yt/liveChat/messages') {
      yt.calls.push(url.searchParams.get('pageToken') ?? '');
      if (yt.quota) return json(403, { error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } });
      const page = yt.pages.shift() ?? { items: [], next: yt.calls.length ? `p${yt.calls.length}` : '' };
      return json(200, { items: page.items, nextPageToken: page.next, pollingIntervalMillis: 1000 });
    }
    return json(404, { error: { message: `fake google: ${url.pathname}` } });
  }) as typeof fetch;
  const metaFetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/lv9/comments')) {
      fb.calls++;
      assert.equal(url.searchParams.get('access_token'), 'page-token');
      return json(200, { data: fb.comments });
    }
    return json(400, { error: { message: `fake meta: ${url.pathname}` } });
  }) as typeof fetch;
  return { yt, fb, googleFetch, metaFetch };
}

const ytMsg = (id: string, name: string, channel: string, text: string) => ({
  id,
  snippet: { type: 'textMessageEvent', displayMessage: text, publishedAt: '2026-10-24T06:00:00Z' },
  authorDetails: { displayName: name, channelId: channel },
});

describe('viewer comments: watch page chat + YouTube + Facebook in one feed', () => {
  let h: Harness;
  const f = fakes();
  let owner: { token: string; orgId: string; userId: string };
  let director: string;
  let commentator: string;
  let tid: string;
  const pub = (path: string, method = 'GET', body?: unknown, token?: string) => api(h, method, `/api/public/tournaments/${tid}${path}`, body, token);
  let viewer: string;

  before(async () => {
    h = await startHarness({
      env: {
        GOOGLE_CLIENT_ID: 'g',
        GOOGLE_CLIENT_SECRET: 'g',
        GOOGLE_TOKEN_URL: 'https://google.fake/token',
        YOUTUBE_API_BASE: 'https://google.fake/yt',
        META_APP_ID: 'm',
        META_APP_SECRET: 'm',
        META_GRAPH_BASE: 'https://graph.fake',
        YOUTUBE_CHAT_POLL_SEC: '1',
        FACEBOOK_COMMENTS_POLL_SEC: '1',
        CHAT_BLOCKED_WORDS: 'slicer',
      },
      googleFetch: f.googleFetch,
      metaFetch: f.metaFetch,
    });
    owner = await signup(h, 'owner@club.test', 'DLF Golf Club');
    director = await addStaff(h, owner.token, owner.orgId, 'dir@club.test', 'director');
    tid = await createTournament(h, director, owner.orgId, { name: 'Monsoon Open' });
    commentator = await joinAsGuest(h, director, tid, 'commentator', 'com-device-1', 'Vikram');
    // A connected YouTube channel and Facebook Page, with a broadcast and a live video.
    await h.app.repo.saveOrgYoutube(owner.orgId, { channelId: 'UC1', channelTitle: 'DLF Golf', refreshTokenEnc: h.app.sealer.seal('refresh'), userId: owner.userId });
    await h.app.repo.saveOrgFacebook(owner.orgId, { userName: 'Admin', pages: [{ id: 'p1', name: 'DLF', tokenEnc: h.app.sealer.seal('page-token') }], pageId: 'p1', userId: owner.userId });
    await h.db.query(`UPDATE tournaments SET yt_broadcast_id = 'b1', fb_live_video_id = 'lv9' WHERE id = $1`, [tid]);
  });
  after(async () => {
    h.app.chatReaders.stopAll();
    await h.close();
  });

  it('viewers give a name once, then chat; abuse masked, links refused, questions spotted, slow mode', async () => {
    const anon = await pub('/chat', 'POST', { text: 'hello' });
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error.code, 'chat_name_needed');
    assert.equal((await pub('/chat/name', 'POST', { name: 'x' })).body.error.code, 'bad_name');
    const n = await expectOk(pub('/chat/name', 'POST', { name: '  Rahul  Verma ' }));
    assert.equal(n.name, 'Rahul Verma');
    viewer = n.token;
    const m = await expectOk(pub('/chat', 'POST', { text: 'What club did Aman hit on 7?' }, viewer));
    assert.deepEqual([m.message.author, m.message.source, m.message.question], ['Rahul Verma', 'watch', true]);
    assert.equal((await pub('/chat', 'POST', { text: 'too quick' }, viewer)).body.error.code, 'slow_mode');

    const other = (await expectOk(pub('/chat/name', 'POST', { name: 'Neha' }))).token;
    const masked = await expectOk(pub('/chat', 'POST', { text: 'what a shit shot, total slicer' }, other));
    assert.equal(masked.message.text, 'what a s*** shot, total s*****');
    assert.equal(masked.message.question, false);
    await new Promise((r) => setTimeout(r, 3100));
    assert.equal((await pub('/chat', 'POST', { text: 'buy now at www.spam.com' }, viewer)).body.error.code, 'no_links');

    const view = await expectOk(pub('/chat'));
    assert.deepEqual(view.messages.map((x: any) => x.author), ['Rahul Verma', 'Neha']);
    const again = await expectOk(pub(`/chat?after=0&v=${view.version}`));
    assert.equal(again.unchanged, true, 'nothing new: tiny reply');
    // The token is for this tournament only.
    const t2 = await createTournament(h, director, owner.orgId, { name: 'Other' });
    assert.equal((await api(h, 'POST', `/api/public/tournaments/${t2}/chat`, { text: 'hi' }, viewer)).status, 401);
  });

  it('YouTube live chat and Facebook comments arrive in the same feed while live, without duplicates', async () => {
    f.yt.pages.push({ items: [ytMsg('y1', 'Arjun', 'UCa', 'Great coverage!'), ytMsg('y2', 'Kabir', 'UCk', 'Who is leading the ladies?')], next: 'n1' });
    f.yt.pages.push({ items: [ytMsg('y2', 'Kabir', 'UCk', 'Who is leading the ladies?'), ytMsg('y3', 'Kabir', 'UCk', 'nice birdie')], next: 'n2' });
    f.fb.comments = [
      { id: 'c2', message: 'Is the 18th reachable in two?', created_time: '2026-10-24T06:01:00+0000', from: { id: 'f2', name: 'Priya Nair' } },
      { id: 'c1', message: 'Watching from Pune', created_time: '2026-10-24T06:00:30+0000', from: { id: 'f1', name: 'Sameer' } },
    ];
    const t = (await h.app.repo.tournamentById(tid))!;
    await h.app.chatReaders.sync(t, true);
    await waitFor(async () => (await expectOk(api(h, 'GET', `/api/tournaments/${tid}/chat`, undefined, director))).messages.length >= 7, 6000);
    const s = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/chat`, undefined, commentator));
    const by = (src: string) => s.messages.filter((m: any) => m.source === src).map((m: any) => m.text);
    assert.deepEqual(by('youtube'), ['Great coverage!', 'Who is leading the ladies?', 'nice birdie']);
    assert.deepEqual(by('facebook'), ['Watching from Pune', 'Is the 18th reachable in two?'], 'oldest first');
    assert.equal(s.sources.youtube.state, 'reading');
    assert.equal(s.sources.facebook.state, 'reading');
    assert.deepEqual(f.yt.calls.slice(0, 2), ['', 'n1'], 'follows YouTube page tokens');
    assert.ok(f.fb.calls >= 2);
    const pubView = await expectOk(pub('/chat'));
    assert.ok(pubView.messages.some((m: any) => m.source === 'facebook' && m.author === 'Priya Nair'), 'combined chat on the watch page');
    // Viewers cannot see staff fields.
    assert.equal(pubView.messages[0].hidden, undefined);
    // Stops when the broadcast ends.
    await h.app.chatReaders.sync(t, false);
    const calls = f.fb.calls;
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(f.fb.calls, calls);
    assert.equal((await expectOk(api(h, 'GET', `/api/tournaments/${tid}/chat`, undefined, director))).sources.facebook.state, 'off');
  });

  it('commentator marks answered; director hides, pins and blocks; staff are told about changes', async () => {
    const ws = await TestSocket.open(h.wsUrl, commentator);
    ws.send({ type: 'subscribe', tournamentId: tid });
    await ws.type('snapshot');
    const all = (await expectOk(api(h, 'GET', `/api/tournaments/${tid}/chat`, undefined, commentator))).messages;
    const q = all.find((m: any) => m.text.startsWith('What club'));
    const neha = all.find((m: any) => m.author === 'Neha');
    const kabir = all.find((m: any) => m.text === 'nice birdie');

    assert.equal((await expectOk(api(h, 'PATCH', `/api/chat/${q.id}`, { answered: true }, commentator))).message.answered, true);
    await ws.next((m) => m.type === 'chat');
    assert.equal((await api(h, 'PATCH', `/api/chat/${neha.id}`, { hidden: true }, commentator)).status, 403);
    const scorer = await joinAsGuest(h, director, tid, 'scorer', 'scorer-1');
    assert.equal((await api(h, 'GET', `/api/tournaments/${tid}/chat`, undefined, scorer)).status, 403);

    await expectOk(api(h, 'PATCH', `/api/chat/${neha.id}`, { hidden: true }, director));
    await expectOk(api(h, 'PATCH', `/api/chat/${q.id}`, { pinned: true }, director));
    let v = await expectOk(pub('/chat'));
    assert.ok(v.hidden.includes(neha.id) && !v.messages.some((m: any) => m.id === neha.id));
    assert.equal(v.pinned.id, q.id);

    const blocked = await expectOk(api(h, 'POST', `/api/chat/${kabir.id}/ban`, undefined, director));
    assert.equal(blocked.hidden, 2, 'both of Kabir’s YouTube messages hidden');
    // A blocked YouTube author's new messages are dropped.
    const row = await h.app.chat.add(tid, { source: 'youtube', externalId: 'y9', author: 'Kabir', authorKey: 'UCk', text: 'again' });
    assert.equal(row, null);
    // A blocked watch-page viewer cannot post.
    const rahul = all.find((m: any) => m.author === 'Rahul Verma');
    await expectOk(api(h, 'POST', `/api/chat/${rahul.id}/ban`, undefined, director));
    assert.equal((await pub('/chat', 'POST', { text: 'let me back' }, viewer)).body.error.code, 'chat_banned');
    v = await expectOk(pub('/chat'));
    assert.equal(v.pinned, null, 'a blocked author’s pinned message is unpinned');
    ws.close();
  });

  it('director puts a viewer question on air; the graphics overlay shows it', async () => {
    const all = (await expectOk(api(h, 'GET', `/api/tournaments/${tid}/chat`, undefined, director))).messages;
    const q = all.find((m: any) => m.text === 'Is the 18th reachable in two?');
    assert.equal((await api(h, 'POST', `/api/chat/${q.id}/on-air`, {}, commentator)).status, 403);
    const g = await expectOk(api(h, 'POST', `/api/chat/${q.id}/on-air`, {}, director));
    assert.deepEqual(g.graphics.question, { visible: true, author: 'Priya Nair', source: 'facebook', text: 'Is the 18th reachable in two?' });
    const t = (await h.app.repo.tournamentById(tid))!;
    const payload = await h.app.graphics.payload(t);
    assert.deepEqual(payload.question, { author: 'Priya Nair', source: 'facebook', text: 'Is the 18th reachable in two?' });
    assert.equal(payload.lowerThird, null);
    assert.equal((await h.app.chat.byId(q.id))!.answered, true);
    await expectOk(api(h, 'POST', `/api/chat/${q.id}/on-air`, { visible: false }, director));
    assert.equal((await h.app.graphics.payload((await h.app.repo.tournamentById(tid))!)).question, null);
  });

  it('chat can be switched off or slowed down per tournament; private tournaments have no public chat', async () => {
    const r = await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}`, { chatEnabled: false, chatSlowSec: 10 }, director));
    assert.deepEqual([r.tournament.chatEnabled, r.tournament.chatSlowSec], [false, 10]);
    const n = (await expectOk(pub('/chat/name', 'POST', { name: 'Late Viewer' }))).token;
    assert.equal((await pub('/chat', 'POST', { text: 'hi' }, n)).body.error.code, 'chat_off');
    assert.equal((await expectOk(pub('/chat'))).enabled, false);
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}`, { publicWatch: false }, director));
    assert.equal((await pub('/chat')).status, 404);
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}`, { publicWatch: true, chatEnabled: true, chatSlowSec: 3 }, director));
  });

  it('YouTube quota used up: reading stops with a clear message, Facebook carries on', async () => {
    f.yt.quota = true;
    const t = (await h.app.repo.tournamentById(tid))!;
    await h.app.chatReaders.sync(t, true);
    await waitFor(async () => (await expectOk(api(h, 'GET', `/api/tournaments/${tid}/chat`, undefined, director))).sources.youtube.state === 'error', 4000);
    const s = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/chat`, undefined, director));
    assert.match(s.sources.youtube.error, /quota for today is used up/);
    assert.equal(s.sources.facebook.state, 'reading');
    const n = f.yt.calls.length;
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(f.yt.calls.length, n, 'no more YouTube calls after the quota error');
    await h.app.chatReaders.sync(t, false);
  });
});

async function waitFor(pred: () => Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}
