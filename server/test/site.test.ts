import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTournament, signup, startHarness, type Harness } from './helpers.js';

describe('public website, legal pages and data-retention duties', () => {
  let h: Harness;
  const revoked: string[] = [];

  before(async () => {
    const googleFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/revoke') {
        revoked.push(new URLSearchParams(String(init?.body)).get('token') ?? '');
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    h = await startHarness({
      googleFetch,
      env: { BRAND_NAME: 'Test Live', SUPPORT_EMAIL: 'help@test.example', LEGAL_ENTITY: 'Test Media Pvt Ltd', BILLING_ENABLED: 'true' },
    });
  });
  after(async () => h.close());

  it('serves every page with the brand filled in and no template tokens left', async () => {
    for (const path of ['/', '/signup', '/login', '/account', '/terms', '/privacy', '/delete-account']) {
      const res = await fetch(h.baseUrl + path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
      const html = await res.text();
      assert.ok(html.includes('Test Live'), `${path} shows the brand`);
      assert.ok(!/\{\{[A-Z_> a-z]+\}\}/.test(html), `${path} has no unfilled tokens`);
      assert.ok(html.includes('href="/privacy"'), `${path} links the privacy policy`);
    }
  });

  it('shows set legal details, and flags missing ones instead of inventing them', async () => {
    const privacy = await (await fetch(h.baseUrl + '/privacy')).text();
    assert.ok(privacy.includes('Test Media Pvt Ltd'));
    assert.ok(privacy.includes('help@test.example'));
    assert.ok(privacy.includes('[Registered address: set LEGAL_ADDRESS]'));
  });

  it('privacy policy carries what Google OAuth verification checks for', async () => {
    const privacy = await (await fetch(h.baseUrl + '/privacy')).text();
    for (const must of [
      'https://www.googleapis.com/auth/youtube',
      'Limited Use requirements',
      'https://developers.google.com/terms/api-services-user-data-policy',
      'https://www.youtube.com/t/terms',
      'https://policies.google.com/privacy',
      'https://security.google.com/settings/security/permissions',
      'pages_read_user_content',
    ]) {
      assert.ok(privacy.includes(must), `privacy policy mentions ${must}`);
    }
  });

  it('redirects common legal URLs and serves assets', async () => {
    const r = await fetch(h.baseUrl + '/privacy-policy', { redirect: 'manual' });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/privacy');
    const css = await fetch(h.baseUrl + '/site/site.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);
    assert.equal((await fetch(h.baseUrl + '/site/../package.json')).status, 404);
    assert.equal((await fetch(h.baseUrl + '/site/secret.txt')).status, 404);
  });

  it('publishes standard prices for the website', async () => {
    const d = (await (await fetch(h.baseUrl + '/api/public/pricing')).json()) as { billing: boolean; pricing: { freeCameras: number }; packs: unknown[] };
    assert.equal(d.billing, true);
    assert.equal(d.pricing.freeCameras, 2);
    assert.ok(d.packs.length >= 1);
  });

  it('deletes YouTube and Facebook comments after 30 days but keeps watch-page chat', async () => {
    const { token, orgId } = await signup(h, 'purge@example.com');
    const tid = await createTournament(h, token, orgId);
    const ins = (source: string, ext: string | null, daysAgo: number) =>
      h.db.query(
        `INSERT INTO chat_messages (tournament_id, source, external_id, author, author_key, text, is_question, created_at)
         VALUES ($1, $2, $3, 'A', 'k', 'hi', false, now() - make_interval(days => $4))`,
        [tid, source, ext, daysAgo],
      );
    await ins('youtube', 'y-old', 31);
    await ins('youtube', 'y-new', 2);
    await ins('facebook', 'f-old', 45);
    await ins('watch', null, 90);
    const removed = await h.app.chat.purgePlatformComments();
    assert.equal(removed, 2);
    const left = (await h.db.query<{ source: string; external_id: string | null }>('SELECT source, external_id FROM chat_messages WHERE tournament_id = $1 ORDER BY id', [tid])).rows;
    assert.deepEqual(left.map((r) => r.external_id ?? r.source), ['y-new', 'watch']);
  });

  it('revokes the Google token when YouTube is disconnected', async () => {
    const { orgId, userId } = await signup(h, 'revoke@example.com');
    await h.app.repo.saveOrgYoutube(orgId, { channelId: 'UC1', channelTitle: 'Club TV', refreshTokenEnc: h.app.sealer.seal('refresh-123'), userId });
    await h.app.youtube.disconnect(orgId);
    assert.deepEqual(revoked, ['refresh-123']);
    assert.equal(await h.app.repo.orgYoutube(orgId), null);
  });
});
