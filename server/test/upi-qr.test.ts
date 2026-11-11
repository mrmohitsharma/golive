import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import QRCode from 'qrcode';
import { api, createTournament, expectOk, signup, startHarness, type Harness } from './helpers.js';
import { drawUpiQr, parseUpiLink, readUpiQr, upiLink } from '../src/upi-qr.js';
import { DEFAULT_PRICING } from '../src/billing.js';

const dataUrl = (buf: Buffer, type = 'image/png') => `data:${type};base64,${buf.toString('base64')}`;
/** A "screenshot": the QR in the middle of a bigger grey picture, as JPG. */
async function screenshotJpg(text: string): Promise<Buffer> {
  const qr = PNG.sync.read(await QRCode.toBuffer(text, { width: 400, margin: 2 }));
  const W = 900, H = 1400;
  const out = Buffer.alloc(W * H * 4, 0xdd);
  for (let y = 0; y < qr.height; y++) qr.data.copy(out, ((y + 500) * W + 250) * 4, y * qr.width * 4, (y + 1) * qr.width * 4);
  return jpeg.encode({ data: out, width: W, height: H }, 90).data;
}

describe('V9 UPI QR: reading and drawing', () => {
  it('reads UPI links in any case and refuses others', () => {
    assert.deepEqual(parseUpiLink('UPI://pay?PA=Sharks.Club@okhdfcbank&pn=Sharks%20CC&am=10'), { upiId: 'sharks.club@okhdfcbank', payee: 'Sharks CC' });
    assert.equal(parseUpiLink('upi://pay?pa=not-an-id'), null);
    assert.equal(parseUpiLink('https://example.com/?pa=a@b'), null);
    assert.equal(upiLink({ upiId: 'a.b@ybl', payee: 'A B' }, 'GCL Final'), 'upi://pay?pa=a.b%40ybl&cu=INR&pn=A%20B&tn=GCL%20Final');
  });

  it('a drawn QR, a JPG screenshot, a non-UPI QR and a picture without a QR', async () => {
    const drawn = await drawUpiQr({ upiId: 'sharks@okaxis', payee: 'Sharks Cricket Club' });
    assert.deepEqual(readUpiQr(drawn, 'png'), { upiId: 'sharks@okaxis', payee: 'Sharks Cricket Club' });
    assert.deepEqual(readUpiQr(await screenshotJpg('upi://pay?pa=titans@ybl&pn=Titans'), 'jpg'), { upiId: 'titans@ybl', payee: 'Titans' });
    assert.equal(readUpiQr(await QRCode.toBuffer('https://gogetslive.com'), 'png'), 'not_upi');
    const blank = new PNG({ width: 64, height: 64 });
    blank.data.fill(255);
    assert.equal(readUpiQr(PNG.sync.write(blank), 'png'), 'not_qr');
  });
});

describe('V9 UPI QR on the video and the watch page', () => {
  let h: Harness;
  let owner: { token: string; orgId: string; userId: string };
  let tid: string;
  const wallet = async () => expectOk(api(h, 'GET', `/api/orgs/${owner.orgId}/billing`, undefined, owner.token));

  before(async () => {
    h = await startHarness({ env: { BILLING_ENABLED: 'true', MEDIA_DIR: `/tmp/golive-upi-test-${process.pid}` } });
    const a = await signup(h, 'staff@upi.test', 'Go Live');
    await h.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [a.userId]);
    await expectOk(api(h, 'PUT', '/api/admin/settings', { pricing: { ...DEFAULT_PRICING, upiQrPrice: 99 } }, a.token));
    owner = await signup(h, 'owner@upi.test', 'Sharks Cricket Club');
    tid = await createTournament(h, owner.token, owner.orgId, { name: 'Sharks vs Titans', eventType: 'cricket' } as any);
    await expectOk(api(h, 'POST', `/api/admin/orgs/${owner.orgId}/credits`, { credits: 150, note: 'test' }, a.token));
  });
  after(async () => h.close());

  it('needs buying first (99 credits, once)', async () => {
    const v = await expectOk(api(h, 'GET', `/api/tournaments/${tid}/branding`, undefined, owner.token));
    assert.equal(v.prices.upiQr, 99);
    assert.equal(v.owned.upiQr, false);
    assert.equal(v.upi, null);
    const no = await api(h, 'POST', `/api/tournaments/${tid}/upi`, { upiId: 'sharks@okaxis' }, owner.token);
    assert.equal(no.status, 402);
    assert.equal((await api(h, 'PATCH', `/api/tournaments/${tid}/branding`, { upi: { show: true } }, owner.token)).body.error.code, 'no_upi_qr');
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/upi/buy`, {}, owner.token));
    await expectOk(api(h, 'POST', `/api/tournaments/${tid}/upi/buy`, {}, owner.token)); // twice: charged once
    const w = await wallet();
    assert.equal(w.balance, 51);
    assert.deepEqual(w.transactions.filter((t: any) => t.kind === 'upiqr').map((t: any) => t.credits), [-99]);
  });

  it('upload: a UPI QR screenshot is read; other pictures are refused with a clear reason', async () => {
    const bad = await api(h, 'POST', `/api/tournaments/${tid}/upi`, { dataUrl: dataUrl(await QRCode.toBuffer('https://example.com')) }, owner.token);
    assert.equal(bad.body.error.code, 'qr_not_upi');
    const blank = new PNG({ width: 40, height: 40 });
    blank.data.fill(255);
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/upi`, { dataUrl: dataUrl(PNG.sync.write(blank)) }, owner.token)).body.error.code, 'qr_not_found');
    assert.equal((await api(h, 'POST', `/api/tournaments/${tid}/upi`, { upiId: 'not an id' }, owner.token)).body.error.code, 'bad_upi_id');
    const v = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/upi`, { dataUrl: dataUrl(await screenshotJpg('upi://pay?pa=Sharks.CC@okhdfcbank&pn=Sharks%20CC'), 'image/jpeg') }, owner.token));
    assert.deepEqual([v.upi.upiId, v.upi.payee], ['sharks.cc@okhdfcbank', 'Sharks CC']);
    assert.match(v.upi.qrUrl, /^\/api\/public\/branding\/[0-9a-f-]{36}-[0-9a-f]{10}\.jpg\?v=/);
    const img = await fetch(h.baseUrl + v.upi.qrUrl);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
  });

  it('the director puts it on air, sizes it and changes the caption; the overlay and watch page get it', async () => {
    const v = await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/branding`, { upi: { show: true, size: 400, caption: 'Scan to support the Sharks' } }, owner.token));
    assert.deepEqual([v.branding.upi.show, v.branding.upi.size, v.branding.upi.caption], [true, 400, 'Scan to support the Sharks']);
    const clamp = await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/branding`, { upi: { size: 9999, upiId: 'thief@ybl' } }, owner.token));
    assert.equal(clamp.branding.upi.size, 440, 'size is kept within limits');
    assert.equal(clamp.branding.upi.upiId, 'sharks.cc@okhdfcbank', 'the UPI ID only changes through the upload');
    const t = (await h.app.repo.tournamentById(tid))!;
    const g = await fetch(`${h.baseUrl}/api/graphics/${tid}/state?k=${t.graphics_key}`).then((r) => r.json() as Promise<any>);
    assert.deepEqual([g.branding.upiQr.size, g.branding.upiQr.caption, g.branding.upiQr.upiId], [440, 'Scan to support the Sharks', 'sharks.cc@okhdfcbank']);
    await h.db.query('UPDATE tournaments SET public_watch = true WHERE id = $1', [tid]);
    const pub = await expectOk(api(h, 'GET', `/api/public/tournaments/${tid}`));
    assert.equal(pub.upi.upiId, 'sharks.cc@okhdfcbank');
    assert.equal(pub.upi.caption, 'Scan to support the Sharks');
    await expectOk(api(h, 'PATCH', `/api/tournaments/${tid}/branding`, { upi: { show: false } }, owner.token));
    const g2 = await fetch(`${h.baseUrl}/api/graphics/${tid}/state?k=${t.graphics_key}`).then((r) => r.json() as Promise<any>);
    assert.equal(g2.branding.upiQr, null, 'off air');
  });

  it('a typed UPI ID becomes a QR; removing takes it off everywhere', async () => {
    const v = await expectOk(api(h, 'POST', `/api/tournaments/${tid}/upi`, { upiId: 'Titans@YBL', payee: 'Titans XI' }, owner.token));
    assert.deepEqual([v.upi.upiId, v.upi.payee], ['titans@ybl', 'Titans XI']);
    const png = Buffer.from(await (await fetch(h.baseUrl + v.upi.qrUrl)).arrayBuffer());
    assert.deepEqual(readUpiQr(png, 'png'), { upiId: 'titans@ybl', payee: 'Titans XI' });
    const gone = await expectOk(api(h, 'DELETE', `/api/tournaments/${tid}/upi`, undefined, owner.token));
    assert.equal(gone.upi, null);
    assert.equal(gone.branding.upi.show, false);
    assert.equal((await fetch(h.baseUrl + v.upi.qrUrl)).status, 404, 'the file is deleted');
  });
});
