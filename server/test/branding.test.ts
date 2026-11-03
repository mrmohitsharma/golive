import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';
import { brandingOf, defaultThemeId, patchBranding, THEMES, tickerItems } from '../src/branding.js';
import { DEFAULT_PRICING } from '../src/billing.js';

// A 1x1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('V8 branding: theme, own logo, watermark, ticker', () => {
  let h: Harness;
  let admin: string;
  let owner: { token: string; orgId: string };
  let tid: string;

  before(async () => {
    h = await startHarness({ env: { BILLING_ENABLED: 'true', MEDIA_DIR: `/tmp/golive-branding-test-${process.pid}` } });
    const a = await signup(h, 'staff@brand.test', 'Go Live');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [a.userId]);
    admin = a.token;
    await expectOk(api(h, 'PUT', '/api/admin/settings', { pricing: { ...DEFAULT_PRICING, brandingPrice: 100, tickerPrice: 25 } }, admin));
    owner = await signup(h, 'owner@brand.test', 'Brand Club');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'Wedding Live', eventType: 'wedding' } as any);
  });
  after(async () => h.close());

  it('themes per kind of event; patches are checked; the ticker mixes in sponsors', () => {
    assert.equal(defaultThemeId('cricket'), 'cricket');
    assert.equal(defaultThemeId('other'), 'conference');
    assert.ok(THEMES.length >= 16);
    assert.deepEqual([...new Set(THEMES.map((t) => t.group))], ['Sports', 'Wedding & family', 'Cultural & religious', 'Corporate & awards']);
    let b = brandingOf({ event_type: 'football', branding: {} });
    assert.equal(b.theme, 'football');
    b = patchBranding(b, { theme: 'nope', accent: 'red', watermark: { opacity: 5, size: 'huge' }, ticker: { lines: ['  One  ', '', 'Two', 'Three'], sponsors: ['Acme'], label: 'BREAKING NEWS TODAY!!' } });
    assert.deepEqual([b.theme, b.accent, b.watermark.opacity, b.watermark.size, b.ticker.label], ['football', null, 1, 'medium', 'BREAKING NEWS TO']);
    assert.deepEqual(tickerItems(b).map((x) => (x.sponsor ? `[${x.text}]` : x.text)), ['One', 'Two', '[Acme]', 'Three']);
    assert.equal(patchBranding(b, { accent: '#FF0000' }).accent, '#ff0000');
  });

  it('the watch page gets the theme and the Go Live logo until the owner buys and uploads one', async () => {
    const pub = await expectOk(api(h, 'GET', `/api/public/tournaments/${tid}`));
    assert.equal(pub.branding.theme, 'wedding');
    assert.equal(pub.branding.font, 'elegant');
    assert.equal(pub.branding.logoUrl, null, 'Go Live logo');
    const v = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/branding`, undefined, owner.token));
    assert.deepEqual([v.prices.branding, v.prices.ticker, v.owned.branding, v.owned.ticker], [100, 25, false, false]);
    assert.equal(v.branding.watermark.enabled, true, 'Go Live watermark by default');
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/branding/logo`, { dataUrl: PNG }, owner.token)).body.error.code, 'branding_not_bought');
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/branding/buy`, { what: 'branding' }, owner.token)).body.error.code, 'insufficient_credits');
    await expectOk(api(h, 'POST', `/api/admin/orgs/${owner.orgId}/credits`, { credits: 200, note: 'test' }, admin));
    const bought = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/branding/buy`, { what: 'branding' }, owner.token));
    assert.equal(bought.owned.branding, true);
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/branding/buy`, { what: 'branding' }, owner.token)); // twice: charged once
    const bal = await expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/billing`, undefined, owner.token));
    assert.equal(bal.balance, 100);
    assert.ok(bal.transactions.some((t: any) => t.kind === 'branding' && t.credits === -100));
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/branding/logo`, { dataUrl: 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64') }, owner.token)).body.error.code, 'bad_logo');
    const up = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/branding/logo`, { dataUrl: PNG }, owner.token));
    assert.match(up.branding.logoUrl, /^\/api\/public\/branding\/[0-9a-f-]{36}-[0-9a-f]{10}\.png\?v=/);
    const img = await fetch(h.baseUrl + up.branding.logoUrl);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.match(img.headers.get('cache-control') ?? '', /immutable/);
    assert.equal((await fetch(h.baseUrl + '/api/public/branding/..%2F..%2Fetc%2Fpasswd')).status, 404);
  });

  it('watermark and ticker go into the video overlay; the ticker needs buying when it has a price', async () => {
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/branding`, { theme: 'cricket', accent: '#123456', ticker: { lines: ['Toss at 2 pm', 'Gurgaon XI bat first'], sponsors: ['Sharma Motors'] } }, owner.token));
    const no = await api(h, 'PATCH', `/api/tournaments/${tid}/branding`, { ticker: { enabled: true } }, owner.token);
    assert.equal(no.status, 402);
    assert.equal(no.body.error.code, 'ticker_not_bought');
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/branding/buy`, { what: 'ticker' }, owner.token));
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/branding`, { ticker: { enabled: true, speed: 'fast' }, watermark: { size: 'large', opacity: 0.5 } }, owner.token));
    const t = (await h.app.repo.tournamentById(tid))!;
    const g = await fetch(`${h.baseUrl}/api/graphics/${tid}/state?k=${t.graphics_key}`).then((r) => r.json() as Promise<any>);
    assert.equal(g.branding.colors.accent, '#123456');
    assert.match(g.branding.watermark.logoUrl, /\.png\?v=/);
    assert.deepEqual([g.branding.watermark.size, g.branding.watermark.opacity], ['large', 0.5]);
    assert.deepEqual(g.branding.ticker.items.map((x: any) => x.text), ['Toss at 2 pm', 'Gurgaon XI bat first', 'Sharma Motors']);
    assert.equal(g.branding.ticker.pxPerSec, 160);
    await new Promise((r) => setTimeout(r, 5100)); // the public page is cached for 5 s
    const pub = await expectOk(api(h, 'GET', `/api/public/tournaments/${tid}`));
    assert.equal(pub.branding.theme, 'cricket');
    await expectOk(api(h, 'DELETE', `/api/tournaments/${tid}/branding/logo`, undefined, owner.token));
    const g2 = await fetch(`${h.baseUrl}/api/graphics/${tid}/state?k=${t.graphics_key}`).then((r) => r.json() as Promise<any>);
    assert.equal(g2.branding.watermark.logoUrl, null, 'back to the Go Live logo');
  });
});
