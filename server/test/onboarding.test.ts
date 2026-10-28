import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addStaff, api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';

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
