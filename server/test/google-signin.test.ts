import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { api, expectOk, signup, startHarness, type Harness } from './helpers.js';

const WEB_ID = 'web-client.apps.googleusercontent.com';
const ANDROID_ID = 'android-client.apps.googleusercontent.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };

/** A Google-style ID token signed with our test key. */
function idToken(claims: Record<string, unknown>, opts: { kid?: string; aud?: string } = {}) {
  return jwt.sign(
    { iss: 'https://accounts.google.com', aud: opts.aud ?? WEB_ID, email_verified: true, ...claims },
    privateKey,
    { algorithm: 'RS256', keyid: opts.kid ?? 'k1', expiresIn: 600 },
  );
}

describe('sign in with Google', () => {
  let h: Harness;
  let certFetches = 0;

  before(async () => {
    const googleFetch = (async (url: string | URL) => {
      if (String(url).includes('/oauth2/v3/certs')) {
        certFetches++;
        return new Response(JSON.stringify({ keys: [{ kid: 'k1', kty: 'RSA', alg: 'RS256', use: 'sig', n: jwk.n, e: jwk.e }] }), {
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    h = await startHarness({ env: { GOOGLE_SIGNIN_CLIENT_IDS: `${WEB_ID},${ANDROID_ID}` }, googleFetch });
  });
  after(async () => h.close());

  it('tells the website and app which client ID to use', async () => {
    const c = await expectOk(api(h, 'GET', '/api/auth/config'));
    assert.deepEqual(c, { signupEnabled: true, google: { clientId: WEB_ID } });
  });

  it('a new person gets an account in one step, with no organisation until they name it', async () => {
    const r = await api(h, 'POST', '/api/auth/google', { idToken: idToken({ sub: 'g-1', email: 'Asha@Club.test', name: 'Asha Rao' }) });
    assert.equal(r.status, 201);
    assert.equal(r.body.newUser, true);
    assert.equal(r.body.user.email, 'asha@club.test');
    assert.equal(r.body.user.name, 'Asha Rao');
    assert.deepEqual(r.body.orgs, []);
    const org = await expectOk(api(h, 'POST', '/api/orgs', { name: 'Asha Events' }, r.body.token));
    assert.equal(org.org.role, 'owner');
    // Returning: same Google identity, same account, now with the organisation.
    const again = await expectOk(api(h, 'POST', '/api/auth/google', { idToken: idToken({ sub: 'g-1', email: 'asha@club.test' }) }));
    assert.equal(again.newUser, false);
    assert.equal(again.user.id, r.body.user.id);
    assert.equal(again.orgs[0].name, 'Asha Events');
    assert.equal(certFetches, 1, 'keys are cached');
  });

  it('accepts the Android client ID and can create the organisation in the same call', async () => {
    const r = await expectOk(
      api(h, 'POST', '/api/auth/google', { idToken: idToken({ sub: 'g-2', email: 'ravi@club.test' }, { aud: ANDROID_ID }), orgName: 'Ravi Sports' }),
    );
    assert.equal(r.orgs[0].name, 'Ravi Sports');
    assert.equal(r.user.name, 'ravi', 'name falls back to the email');
  });

  it('links an existing email account; that account can then use either way', async () => {
    const owner = await signup(h, 'meera@club.test', 'Meera Golf');
    const r = await expectOk(api(h, 'POST', '/api/auth/google', { idToken: idToken({ sub: 'g-3', email: 'meera@club.test', name: 'Meera' }) }));
    assert.equal(r.newUser, false);
    assert.equal(r.user.id, owner.userId);
    assert.equal(r.orgs[0].id, owner.orgId);
    await expectOk(api(h, 'POST', '/api/auth/login', { email: 'meera@club.test', password: 'password123' }));
  });

  it('a Google-only account gets a clear message on password sign-in', async () => {
    const r = await api(h, 'POST', '/api/auth/login', { email: 'asha@club.test', password: 'whatever1' });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'use_google');
  });

  it('refuses wrong audience, unknown key, unverified email, expired and tampered tokens', async () => {
    const codes = async (body: object) => (await api(h, 'POST', '/api/auth/google', body)).body.error.code;
    assert.equal(await codes({ idToken: idToken({ sub: 'x', email: 'x@club.test' }, { aud: 'someone-else' }) }), 'google_token_invalid');
    assert.equal(await codes({ idToken: idToken({ sub: 'x', email: 'x@club.test' }, { kid: 'other' }) }), 'google_token_invalid');
    assert.equal(await codes({ idToken: idToken({ sub: 'x', email: 'x@club.test', email_verified: false }) }), 'google_email_unverified');
    const expired = jwt.sign({ iss: 'accounts.google.com', aud: WEB_ID, sub: 'x', email: 'x@club.test', email_verified: true, exp: Math.floor(Date.now() / 1000) - 3600 }, privateKey, {
      algorithm: 'RS256',
      keyid: 'k1',
    });
    assert.equal(await codes({ idToken: expired }), 'google_token_invalid');
    const good = idToken({ sub: 'x', email: 'x@club.test' });
    const [hd, , sig] = good.split('.');
    const forged = Buffer.from(JSON.stringify({ iss: 'accounts.google.com', aud: WEB_ID, sub: 'admin', email: 'boss@club.test', email_verified: true, exp: 9e9 })).toString('base64url');
    assert.equal(await codes({ idToken: `${hd}.${forged}.${sig}` }), 'google_token_invalid');
  });

  it('is off when no client ID is configured', async () => {
    const off = await startHarness();
    try {
      assert.equal((await expectOk(api(off, 'GET', '/api/auth/config'))).google, null);
      const r = await api(off, 'POST', '/api/auth/google', { idToken: idToken({ sub: 'x', email: 'x@club.test' }) });
      assert.equal(r.body.error.code, 'google_signin_off');
    } finally {
      await off.close();
    }
  });
});
