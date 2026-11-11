import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';

/** GET with a Host header (fetch drops it): how <brand>.gogetslive.com reaches the server. */
function getHost(baseUrl: string, path: string, host: string): Promise<{ status: number; text: string }> {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    http.get({ hostname: u.hostname, port: u.port, path, headers: { host } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: b }));
    }).on('error', reject);
  });
}

describe('V9 brand channels: <brand>.gogetslive.com, events, follow by email, alerts', () => {
  let h: Harness;
  let owner: { token: string; orgId: string; userId: string };
  let other: { token: string; orgId: string; userId: string };
  let final: string;
  let semi: string;

  before(async () => {
    h = await startHarness();
    owner = await signup(h, 'rahul@gcl.test', 'Gurgaon Cricket League');
    other = await signup(h, 'x@other.test', 'Other Club');
    final = await createTournament(h, owner.token, owner.orgId, { name: 'GCL Final' });
    semi = await createTournament(h, owner.token, owner.orgId, { name: 'GCL Semi' });
  });
  after(async () => h.close());

  it('claims an address; reserved and taken names are refused', async () => {
    for (const [slug, re] of [['www', /reserved/], ['a', /3 to 30/], ['GCL!', /3 to 30/]] as const) {
      const r = await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/channel/check?slug=${encodeURIComponent(slug)}`, undefined, owner.token));
      assert.equal(r.ok, false);
      assert.match(r.problem, re);
    }
    const v = await expectOk(api(h, 'PUT', `/api/orgs/${owner.orgId}/channel`, { slug: 'gcl', name: 'Gurgaon Cricket League', description: 'T20 every weekend', look: { theme: 'cricket', links: [{ label: 'Instagram', url: 'https://instagram.com/gcl' }, { label: 'Bad', url: 'javascript:alert(1)' }], sponsors: ['Sharma Motors'] } }, owner.token));
    assert.equal(v.channel.slug, 'gcl');
    assert.deepEqual(v.channel.look.links.map((l: any) => l.label), ['Instagram']);
    const taken = await api(h, 'PUT', `/api/orgs/${other.orgId}/channel`, { slug: 'gcl', name: 'Copy' }, other.token);
    assert.equal(taken.status, 400);
    assert.match(taken.body.error.message, /taken/);
  });

  it('serves the channel on its subdomain and at /c/<slug>, with events under it', async () => {
    await expectOk(api(h, 'PATCH', `/api/tournaments/${semi}/channel`, { series: 'Season 2026', startsAt: new Date(Date.now() + 2 * 86400_000).toISOString() }, owner.token));
    await h.db.query('UPDATE tournaments SET first_live_at = now() - interval \'1 day\' WHERE id = $1', [final]);
    const sub = await getHost(h.baseUrl, '/', 'gcl.gogetslive.com');
    assert.equal(sub.status, 200);
    const html = sub.text;
    assert.match(html, /<title>Gurgaon Cricket League · live and replays<\/title>/);
    assert.match(html, /window.GL_CHANNEL="gcl"/);
    assert.match(await fetch(h.baseUrl + '/c/gcl').then((r) => r.text()), /GL_CHANNEL_BASE="\/c\/gcl"/);
    const nochan = await getHost(h.baseUrl, '/', 'nobody.gogetslive.com');
    assert.equal(nochan.status, 404);
    // Reserved subdomains and other paths are not channels.
    assert.equal((await getHost(h.baseUrl, '/', 'www.gogetslive.com')).text.includes('GL_CHANNEL'), false);
    const ev = await getHost(h.baseUrl, `/${final}`, 'gcl.gogetslive.com');
    assert.equal(ev.status, 200);
    assert.match(ev.text, new RegExp(`window.GL_TID="${final}"`));
    // The rest of the site still works on the channel's host (API, assets).
    assert.equal((await getHost(h.baseUrl, '/api/public/channels/gcl', 'gcl.gogetslive.com')).status, 200);
    // Another club's event is not served under this channel.
    const theirs = await createTournament(h, other.token, other.orgId, { name: 'Not GCL' });
    assert.equal((await fetch(`${h.baseUrl}/c/gcl/${theirs}`)).status, 404);
    const d = await expectOk(api(h, 'GET', '/api/public/channels/gcl'));
    assert.equal(d.channel.name, 'Gurgaon Cricket League');
    assert.match(d.channel.url, /\/c\/gcl$/);
    assert.equal(d.hero.kind, 'upcoming');
    assert.equal(d.hero.event.name, 'GCL Semi');
    assert.equal(d.past[0].name, 'GCL Final');
    assert.equal(d.upcoming[0].series, 'Season 2026');
    // Hidden from the channel.
    await expectOk(api(h, 'PATCH', `/api/tournaments/${final}/channel`, { hidden: true }, owner.token));
    assert.equal((await expectOk(api(h, 'GET', '/api/public/channels/gcl'))).past.length, 0);
    await expectOk(api(h, 'PATCH', `/api/tournaments/${final}/channel`, { hidden: false }, owner.token));
    // The event's watch data links back to its channel.
    assert.equal((await expectOk(api(h, 'GET', `/api/public/tournaments/${final}`))).channel.name, 'Gurgaon Cricket League');
  });

  it('follow needs the email link; going live emails followers once; reminders an hour before', async () => {
    await expectOk(api(h, 'POST', '/api/public/channels/gcl/follow', { email: 'Fan@Example.com' }));
    assert.equal((await api(h, 'POST', '/api/public/channels/gcl/follow', { email: 'nope' })).status, 400);
    const mail = h.app.mailer.outbox.filter((e: any) => e.kind === 'channel_follow').at(-1)!;
    assert.equal(mail.to, 'fan@example.com');
    // Not verified yet: no alerts.
    assert.equal(await h.app.channels.wentLive(final), 0);
    await h.db.query('UPDATE tournaments SET live_alerted_at = NULL WHERE id = $1', [final]);
    const ok = await fetch(h.baseUrl + new URL(mail.button!.url).pathname).then((r) => r.text());
    assert.match(ok, /You follow Gurgaon Cricket League/);
    assert.equal(await h.app.channels.wentLive(final), 1);
    assert.equal(await h.app.channels.wentLive(final), 0, 'once per go-live');
    const live = h.app.mailer.outbox.filter((e: any) => e.kind === 'channel_live').at(-1)!;
    assert.match(live.subject, /is live now: GCL Final/);
    assert.ok(live.button!.url.endsWith(`/c/gcl/${final}`));
    // Reminder for an event starting in an hour.
    await expectOk(api(h, 'PATCH', `/api/tournaments/${semi}/channel`, { startsAt: new Date(Date.now() + 60 * 60_000).toISOString() }, owner.token));
    assert.equal(await h.app.channels.remindDue(), 1);
    assert.equal(await h.app.channels.remindDue(), 0);
    // Unfollow from the email.
    const unf = live.body.join(' ').match(/\/unfollow\/([A-Za-z0-9_-]+)/)![1];
    await fetch(`${h.baseUrl}/unfollow/${unf}`);
    assert.equal((await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/channel`, undefined, owner.token))).followers.verified, 0);
  });

  it('only the owner changes the brand page', async () => {
    assert.equal((await api(h, 'PUT', `/api/orgs/${owner.orgId}/channel`, { slug: 'gcl', name: 'X' }, other.token)).status, 404);
  });
});
