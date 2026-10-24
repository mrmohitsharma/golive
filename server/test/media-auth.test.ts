import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addStaff, api, createTournament, expectOk, joinAsGuest, signup, startHarness, type Harness } from './helpers.js';

describe('MediaMTX auth hook', () => {
  let h: Harness;
  let owner: { token: string; orgId: string };
  let directorToken: string;
  let scorerToken: string;
  let cameraGuest: string;
  let commentatorGuest: string;
  let camPath: string;
  let publishKey: string;
  let comPath: string;
  let comKey: string;
  let readKey: string;
  let tournamentId: string;

  const hook = (body: object, secret = h.config.MEDIAMTX_HOOK_SECRET) => api(h, 'POST', `/internal/mediamtx/auth?secret=${secret}`, body);

  before(async () => {
    h = await startHarness();
    owner = await signup(h, 'owner@club.test');
    directorToken = await addStaff(h, owner.token, owner.orgId, 'd@club.test', 'director');
    scorerToken = await addStaff(h, owner.token, owner.orgId, 's@club.test', 'scorer');
    tournamentId = await createTournament(h, owner.token, owner.orgId);
    cameraGuest = await joinAsGuest(h, owner.token, tournamentId, 'camera', 'device-1234-abcd');
    commentatorGuest = await joinAsGuest(h, owner.token, tournamentId, 'commentator', 'tablet-9999-abcd', 'Commentator');
    const r = await expectOk(
      api(h, 'POST', `/api/tournaments/${tournamentId}/cameras/register`, { name: 'Cam A', deviceId: 'device-1234-abcd', platform: 'ios' }, cameraGuest),
    );
    camPath = r.camera.streamPath;
    publishKey = /:cam:([0-9a-f]+)/.exec(r.publish.srtUrl)![1];
    const c = await expectOk(
      api(h, 'POST', `/api/tournaments/${tournamentId}/commentators/register`, { name: 'Vikram', deviceId: 'tablet-9999-abcd' }, commentatorGuest),
    );
    comPath = c.commentator.streamPath;
    assert.match(c.publish.whipUrl, new RegExp(`/webrtc/${comPath}/whip$`));
    comKey = c.publish.bearer.split(':')[1];
    readKey = (await h.app.repo.tournamentById(tournamentId))!.read_key;
  });
  after(async () => h.close());

  it('requires the hook secret', async () => {
    assert.equal((await hook({ action: 'publish', path: camPath, password: publishKey, protocol: 'srt' }, 'wrong-secret-xxxxxxx')).status, 401);
  });

  it('cameras publish only over SRT with their own key', async () => {
    assert.equal((await hook({ action: 'publish', path: camPath, user: 'cam', password: publishKey, protocol: 'srt' })).status, 200);
    assert.equal((await hook({ action: 'publish', path: camPath, user: 'cam', password: 'bad', protocol: 'srt' })).status, 401);
    assert.equal((await hook({ action: 'publish', path: camPath, user: 'cam', password: publishKey, protocol: 'webrtc' })).status, 401);
    assert.equal((await hook({ action: 'publish', path: camPath, user: 'engine', password: readKey, protocol: 'srt' })).status, 401);
    assert.equal((await hook({ action: 'publish', path: 'cam-unknown', password: publishKey, protocol: 'srt' })).status, 401);
  });

  it('commentators publish over WebRTC (WHIP) with their key; a camera key cannot publish commentary', async () => {
    assert.equal((await hook({ action: 'publish', path: comPath, user: 'com', password: comKey, protocol: 'webrtc' })).status, 200);
    assert.equal((await hook({ action: 'publish', path: comPath, user: 'com', password: publishKey, protocol: 'webrtc' })).status, 401);
    assert.equal((await hook({ action: 'publish', path: comPath, user: 'com', password: comKey, protocol: 'rtmp' })).status, 401);
  });

  it('reads: engine key, internal user, and watch roles (owner, director, commentator)', async () => {
    assert.equal((await hook({ action: 'read', path: camPath, user: 'engine', password: readKey, protocol: 'srt' })).status, 200);
    assert.equal((await hook({ action: 'read', path: comPath, user: 'engine', password: readKey, protocol: 'srt' })).status, 200);
    assert.equal(
      (await hook({ action: 'read', path: camPath, user: h.config.INTERNAL_MEDIA_USER, password: h.config.INTERNAL_MEDIA_PASS, protocol: 'rtsp' })).status,
      200,
    );
    for (const token of [owner.token, directorToken, commentatorGuest]) {
      assert.equal((await hook({ action: 'read', path: camPath, token, protocol: 'webrtc' })).status, 200);
    }
  });

  it('denies reads for scorers, camera guests, other clubs, publish keys and anonymous', async () => {
    const rival = await signup(h, 'rival@club.test', 'Rival');
    for (const token of [scorerToken, cameraGuest, rival.token]) {
      assert.equal((await hook({ action: 'read', path: camPath, token, protocol: 'webrtc' })).status, 401);
    }
    assert.equal((await hook({ action: 'read', path: camPath, user: 'cam', password: publishKey, protocol: 'srt' })).status, 401);
    assert.equal((await hook({ action: 'read', path: camPath, protocol: 'webrtc' })).status, 401);
  });

  it('playback (recordings) and the control API are internal only', async () => {
    const internal = { user: h.config.INTERNAL_MEDIA_USER, password: h.config.INTERNAL_MEDIA_PASS };
    assert.equal((await hook({ action: 'playback', path: camPath, ...internal })).status, 200);
    assert.equal((await hook({ action: 'playback', path: camPath, token: directorToken })).status, 401);
    assert.equal((await hook({ action: 'api', ...internal })).status, 200);
    assert.equal((await hook({ action: 'api', token: owner.token })).status, 401);
  });

  it('archived tournaments stop accepting publishers', async () => {
    await h.app.repo.updateTournament(tournamentId, { archived: true });
    assert.equal((await hook({ action: 'publish', path: camPath, password: publishKey, protocol: 'srt' })).status, 401);
    await h.app.repo.updateTournament(tournamentId, { archived: false });
  });
});
