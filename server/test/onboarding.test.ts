import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addStaff, api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';
import { youtubeVideoId } from '../src/youtube.js';

describe('onboarding: invites made automatically', () => {
  let h: Harness;
  let owner: { token: string; orgId: string; userId: string };

  before(async () => {
    h = await startHarness();
    owner = await signup(h, 'org@club.test', 'Quick Events');
  });
  after(async () => h.close());

  it('a new event already has a camera, scorer and commentator code, with WhatsApp links', async () => {
    const tid = await createTournament(h, owner.token, owner.orgId, { name: 'Sunday Cup' });
    const codes = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/join-codes`, undefined, owner.token));
    assert.deepEqual(codes.codes.map((c: any) => c.role).sort(), ['camera', 'commentator', 'scorer']);
    const director = await addStaff(h, owner.token, owner.orgId, 'dir@club.test', 'director');
    const inv = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/invites`, undefined, director));
    assert.deepEqual(inv.invites.map((i: any) => i.role), ['camera', 'scorer', 'commentator']);
    const cam = inv.invites[0];
    assert.equal(cam.expiresAt, null);
    assert.match(cam.joinUrl, /^https:\/\/live\.example\.com\/join\/[A-Z0-9]+$/);
    assert.match(cam.shareText, /^Join Sunday Cup on Go Live to be a camera: https:/);
    assert.equal(cam.whatsapp, `https://wa.me/?text=${encodeURIComponent(cam.shareText)}`);
    // Same codes next time: nothing new is created.
    const again = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/invites`, undefined, owner.token));
    assert.deepEqual(again.invites.map((i: any) => i.code), inv.invites.map((i: any) => i.code));
  });

  it('a revoked invite is replaced by a fresh one', async () => {
    const tid = await createTournament(h, owner.token, owner.orgId, { name: 'Revoke Cup' });
    const inv = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/invites`, undefined, owner.token));
    await expectOk(api(h, 'DELETE', `/api/tournaments/${tid}/join-codes/${inv.invites[0].code}`, undefined, owner.token));
    const next = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/invites`, undefined, owner.token));
    assert.notEqual(next.invites[0].code, inv.invites[0].code);
    assert.equal(next.invites[1].code, inv.invites[1].code);
  });
});

describe('onboarding: paste a YouTube stream key', () => {
  let h: Harness;
  let owner: { token: string; orgId: string; userId: string };

  before(async () => {
    h = await startHarness();
    owner = await signup(h, 'key@club.test', 'Key Club');
  });
  after(async () => h.close());

  it('reads video ids from the links people paste', () => {
    for (const link of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://www.youtube.com/live/dQw4w9WgXcQ?feature=share',
      'https://studio.youtube.com/video/dQw4w9WgXcQ/livestreaming',
      'dQw4w9WgXcQ',
    ]) assert.equal(youtubeVideoId(link), 'dQw4w9WgXcQ', link);
    assert.equal(youtubeVideoId('https://example.com/watch?v=nope'), null);
  });

  it('a key is enough to stream to YouTube; the video link makes the watch page play it', async () => {
    const tid = await createTournament(h, owner.token, owner.orgId, { name: 'Key Cup' });
    const bad = await api(h, 'PUT', `/api/tournaments/${tid}/youtube/key`, { streamKey: 'abcd efgh ijkl' }, owner.token);
    assert.equal(bad.body.error.code, 'bad_stream_key');
    let r = await expectOk(api(h, 'PUT', `/api/tournaments/${tid}/youtube/key`, { streamKey: 'abcd-efgh-ijkl-mnop' }, owner.token));
    assert.deepEqual([r.youtube.source, r.youtube.connected, r.youtube.watchUrl], ['key', true, null]);
    const out = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/outputs`, undefined, owner.token));
    const yt = out.outputs.platforms.find((p: any) => p.platform === 'youtube');
    assert.equal(yt.configured, true);
    const row = (await h.db.query('SELECT yt_ingest_url, yt_stream_key_enc FROM tournaments WHERE id = $1', [tid])).rows[0];
    assert.equal(row.yt_ingest_url, 'rtmps://a.rtmps.youtube.com/live2');
    assert.ok(!String(row.yt_stream_key_enc).includes('abcd-efgh'), 'stored encrypted');
    r = await expectOk(api(h, 'PUT', `/api/tournaments/${tid}/youtube/key`, { videoUrl: 'https://youtu.be/dQw4w9WgXcQ' }, owner.token));
    assert.equal(r.youtube.watchUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal((await api(h, 'PUT', `/api/tournaments/${tid}/youtube/key`, { videoUrl: 'not a link' }, owner.token)).body.error.code, 'bad_video_url');
    const broadcast = await api(h, 'POST', `/api/tournaments/${tid}/youtube/broadcast`, {}, owner.token);
    assert.equal(broadcast.status, 409);
    r = await expectOk(api(h, 'DELETE', `/api/tournaments/${tid}/youtube/key`, undefined, owner.token));
    assert.deepEqual([r.youtube.source, r.youtube.connected, r.youtube.watchUrl], ['org', false, null]);
  });
});

describe('onboarding: event types', () => {
  let h: Harness;
  let owner: { token: string; orgId: string; userId: string };

  before(async () => {
    h = await startHarness();
    owner = await signup(h, 'types@club.test', 'Many Events');
  });
  after(async () => h.close());

  it('lists the kinds of event with their labels', async () => {
    const r = await expectOk(api(h, 'GET', '/api/event-types'));
    assert.deepEqual(r.eventTypes.map((e: any) => e.id), ['golf', 'cricket', 'football', 'wedding', 'concert', 'conference', 'other']);
    const conf = r.eventTypes.find((e: any) => e.id === 'conference');
    assert.deepEqual([conf.captionTitle, conf.captionSubtitle, conf.positionLabel, conf.scoring], ['Speaker', 'Title and company', null, false]);
  });

  it('a wedding starts without golf graphics; golf keeps them; existing events are golf', async () => {
    const w = await expectOk(api(h, 'POST', `/api/orgs/${owner.orgId}/tournaments`, { name: 'Ananya & Rohan', eventType: 'wedding' }, owner.token));
    assert.equal(w.tournament.eventType, 'wedding');
    assert.equal(w.tournament.profile.captionTitle, 'Names');
    const g = (await h.db.query('SELECT graphics FROM tournaments WHERE id = $1', [w.tournament.id])).rows[0].graphics;
    assert.deepEqual([g.scoreBug.visible, g.holeCard.auto], [false, false]);
    const golf = await expectOk(api(h, 'POST', `/api/orgs/${owner.orgId}/tournaments`, { name: 'Open' }, owner.token));
    assert.deepEqual([golf.tournament.eventType, golf.tournament.profile.positionLabel], ['golf', 'Hole']);
    const changed = await expectOk(api(h, 'PATCH', `/api/tournaments/${golf.tournament.id}`, { eventType: 'cricket' }, owner.token));
    assert.equal(changed.tournament.eventType, 'cricket');
    assert.equal((await api(h, 'POST', `/api/orgs/${owner.orgId}/tournaments`, { name: 'X', eventType: 'polo' }, owner.token)).status, 400);
  });
});

describe('onboarding: join links open the app', () => {
  it('serves Android App Links and iOS Universal Links only when configured', async () => {
    const off = await startHarness();
    try {
      assert.equal((await fetch(`${off.baseUrl}/.well-known/assetlinks.json`)).status, 404);
      assert.equal((await fetch(`${off.baseUrl}/.well-known/apple-app-site-association`)).status, 404);
    } finally {
      await off.close();
    }
    const h = await startHarness({ env: { ANDROID_CERT_SHA256: 'aa:bb:cc, DD:EE:FF', IOS_APP_ID: 'TEAM123.com.cogolfers.cogolferLive', PLAY_STORE_URL: 'https://play.google.com/store/apps/details?id=com.cogolfers.cogolfer_live' } });
    try {
      const a = await (await fetch(`${h.baseUrl}/.well-known/assetlinks.json`)).json();
      assert.deepEqual(a[0].target, { namespace: 'android_app', package_name: 'com.cogolfers.cogolfer_live', sha256_cert_fingerprints: ['AA:BB:CC', 'DD:EE:FF'] });
      const r = await fetch(`${h.baseUrl}/.well-known/apple-app-site-association`);
      assert.match(r.headers.get('content-type') ?? '', /application\/json/);
      const aasa = await r.json();
      assert.deepEqual(aasa.applinks.details[0].appIDs, ['TEAM123.com.cogolfers.cogolferLive']);
      assert.deepEqual(aasa.applinks.details[0].components.map((c: any) => c['/']), ['/join/*', '/app/login/*']);
      const owner = await signup(h, 'links@club.test');
      const tid = await createTournament(h, owner.token, owner.orgId, { name: 'Link Cup' });
      const inv = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/invites`, undefined, owner.token));
      const page = await (await fetch(inv.invites[0].joinUrl.replace('https://live.example.com', h.baseUrl))).text();
      assert.match(page, /Get it on Google Play/);
      assert.match(page, /Link Cup/);
    } finally {
      await h.close();
    }
  });
});

describe('onboarding: one-tap camera setup', () => {
  let h: Harness;
  let owner: { token: string; orgId: string; userId: string };
  let tid: string;

  before(async () => {
    h = await startHarness();
    owner = await signup(h, 'cams@club.test', 'Cam Club');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'Cam Cup', eventType: 'wedding' });
  });
  after(async () => h.close());

  it('cameras without a name become Cam 1, Cam 2…; a phone that rejoins keeps its name', async () => {
    const inv = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/invites`, undefined, owner.token));
    const join = async (device: string) =>
      (await expectOk(api(h, 'POST', '/api/join', { code: inv.invites[0].code, deviceId: device, name: 'Volunteer' }))).token as string;
    const reg = async (token: string, device: string, name?: string) =>
      expectOk(api(h, 'POST', `/api/tournaments/${tid}/cameras/register`, { deviceId: device, platform: 'android', ...(name ? { name } : {}) }, token));
    const a = await join('device-aaaaaaaa');
    const b = await join('device-bbbbbbbb');
    assert.equal((await reg(a, 'device-aaaaaaaa')).camera.name, 'Cam 1');
    assert.equal((await reg(b, 'device-bbbbbbbb')).camera.name, 'Cam 2');
    assert.equal((await reg(a, 'device-aaaaaaaa')).camera.name, 'Cam 1', 'rejoin keeps the name');
    assert.equal((await reg(a, 'device-aaaaaaaa', 'Stage left')).camera.name, 'Stage left');
    const c = await join('device-cccccccc');
    assert.equal((await reg(c, 'device-cccccccc')).camera.name, 'Cam 3');
  });

  it('upload test accepts bytes from signed-in phones only', async () => {
    const body = Buffer.alloc(300_000, 7);
    const r = await fetch(`${h.baseUrl}/api/speedtest/upload`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${owner.token}` }, body });
    assert.deepEqual(await r.json(), { bytes: 300_000 });
    const anon = await fetch(`${h.baseUrl}/api/speedtest/upload`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body });
    assert.equal(anon.status, 401);
  });
});
