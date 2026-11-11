import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { requireAuth } from '../auth.js';
import { requireTournament } from '../authz.js';
import { HttpError } from '../errors.js';
import { brandingOf, logoUrl, patchBranding, publicBranding, publicUpi, THEMES, tickerItems, UPI_SIZES } from '../branding.js';
import { drawUpiQr, readUpiQr, UPI_ID } from '../upi-qr.js';
import type { TournamentRow } from '../repo.js';

const MAX_LOGO_BYTES = 1_500_000;
const MAX_QR_BYTES = 3_000_000;

/** Image type from the first bytes (never trust the data: URL's label). */
export function sniff(buf: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

/**
 * V8 event branding: theme (by kind of event) and colour, own logo (paid per event; the Go Live
 * logo otherwise), logo watermark and the scrolling ticker in the video (graphics overlay).
 */
export function registerBrandingRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, billing, graphics } = ctx;
  const user = requireAuth(config, 'user');
  const any = requireAuth(config);
  const dir = path.join(config.MEDIA_DIR, 'branding');
  const tid = (req: { params: unknown }) => z.string().uuid().parse((req.params as { id: string }).id);

  const view = async (t: TournamentRow) => {
    const b = brandingOf(t);
    const p = await billing.pricingFor(t.org_id);
    return {
      branding: { ...b, logoUrl: logoUrl(b) },
      preview: publicBranding(b),
      tickerItems: tickerItems(b),
      themes: THEMES,
      upi: publicUpi(b),
      upiSizes: UPI_SIZES,
      prices: { branding: billing.enabled ? p.brandingPrice : 0, ticker: billing.enabled ? p.tickerPrice : 0, upiQr: billing.enabled ? p.upiQrPrice : 0 },
      owned: { branding: await billing.addonOn(t, 'branding'), ticker: await billing.addonOn(t, 'ticker'), upiQr: await billing.upiQrOn(t) },
    };
  };
  const save = async (t: TournamentRow, next: ReturnType<typeof brandingOf>) => {
    await repo.setTournamentJson(t.id, 'branding', next);
    await graphics.publish(t.id).catch(() => {});
    return (await repo.tournamentById(t.id))!;
  };

  app.get('/api/tournaments/:id/branding', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'direct');
    return view(t);
  });

  /** Theme, colour, watermark and ticker. Directors change the ticker live from the control room. */
  app.patch('/api/tournaments/:id/branding', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'direct');
    const body = z.record(z.string(), z.unknown()).parse(req.body);
    const cur = brandingOf(t);
    const next = patchBranding(cur, body);
    if (next.ticker.enabled && !cur.ticker.enabled && !(await billing.addonOn(t, 'ticker'))) {
      const p = await billing.pricingFor(t.org_id);
      throw new HttpError(402, 'ticker_not_bought', `The scrolling ticker costs ${p.tickerPrice} credits for this event. Buy it first.`);
    }
    const upi = body.upi as Record<string, unknown> | undefined;
    if (upi?.show === true && !cur.upi.qr) throw new HttpError(409, 'no_upi_qr', 'Add the UPI QR first (Event > Branding).');
    if (upi?.show === true && !cur.upi.show && !(await billing.upiQrOn(t))) {
      const p = await billing.pricingFor(t.org_id);
      throw new HttpError(402, 'upi_qr_not_bought', `The UPI QR costs ${p.upiQrPrice} credits for this event. Buy it first.`);
    }
    return view(await save(t, next));
  });

  app.post('/api/tournaments/:id/branding/buy', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    const { what } = z.object({ what: z.enum(['branding', 'ticker']) }).parse(req.body);
    await billing.buyAddon(t, what, req.principal!.kind === 'user' ? req.principal!.email : 'director');
    return view((await repo.tournamentById(t.id))!);
  });

  /** The event's own logo (PNG, JPG or WebP up to 1.5 MB), sent as a data: URL. */
  app.post('/api/tournaments/:id/branding/logo', { preHandler: user, bodyLimit: 2_200_000 }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    if (!(await billing.addonOn(t, 'branding'))) {
      const p = await billing.pricingFor(t.org_id);
      throw new HttpError(402, 'branding_not_bought', `Your own logo costs ${p.brandingPrice} credits for this event. Buy it first.`);
    }
    const { dataUrl } = z.object({ dataUrl: z.string().max(2_100_000) }).parse(req.body);
    const m = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(dataUrl);
    if (!m) throw new HttpError(400, 'bad_logo', 'Upload a PNG, JPG or WebP image.');
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > MAX_LOGO_BYTES) throw new HttpError(400, 'logo_too_big', 'The logo must be 1.5 MB or smaller.');
    const ext = sniff(buf);
    if (!ext) throw new HttpError(400, 'bad_logo', 'Upload a PNG, JPG or WebP image (SVG and other files are not accepted).');
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
    const file = `${t.id}-${hash}.${ext}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), buf);
    const cur = brandingOf(t);
    if (cur.logo && cur.logo.file !== file) fs.rmSync(path.join(dir, cur.logo.file), { force: true });
    return view(await save(t, { ...cur, logo: { file, v: hash } }));
  });

  app.delete('/api/tournaments/:id/branding/logo', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    const cur = brandingOf(t);
    if (cur.logo) fs.rmSync(path.join(dir, cur.logo.file), { force: true });
    return view(await save(t, { ...cur, logo: null }));
  });

  // ---------------------------------------------------------------- V9: the organiser's UPI QR
  app.post('/api/tournaments/:id/upi/buy', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    await billing.buyUpiQr(t, req.principal!.kind === 'user' ? req.principal!.email : 'director');
    return view((await repo.tournamentById(t.id))!);
  });

  /**
   * The QR: a picture of the organiser's UPI QR (PNG or JPG, read to check it is a UPI QR), or a
   * UPI ID we draw a QR for. The picture is shown as uploaded; money goes straight to them.
   */
  app.post('/api/tournaments/:id/upi', { preHandler: user, bodyLimit: 4_300_000 }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    if (!(await billing.upiQrOn(t))) {
      const p = await billing.pricingFor(t.org_id);
      throw new HttpError(402, 'upi_qr_not_bought', `The UPI QR costs ${p.upiQrPrice} credits for this event. Buy it first.`);
    }
    const body = z
      .object({ dataUrl: z.string().max(4_200_000).optional(), upiId: z.string().trim().max(320).optional(), payee: z.string().trim().max(80).optional(), caption: z.string().max(60).optional() })
      .parse(req.body);
    let buf: Buffer;
    let ext: 'png' | 'jpg';
    let target: { upiId: string; payee: string | null };
    if (body.dataUrl) {
      const m = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(body.dataUrl);
      if (!m) throw new HttpError(400, 'bad_qr', 'Upload a PNG or JPG picture of your UPI QR.');
      buf = Buffer.from(m[1], 'base64');
      if (buf.length > MAX_QR_BYTES) throw new HttpError(400, 'qr_too_big', 'The picture must be 3 MB or smaller.');
      const kind = sniff(buf);
      if (kind !== 'png' && kind !== 'jpg') throw new HttpError(400, 'bad_qr', 'Upload a PNG or JPG picture of your UPI QR (a screenshot works).');
      ext = kind;
      const read = readUpiQr(buf, kind);
      if (read === 'not_qr') throw new HttpError(400, 'qr_not_found', 'No QR code found in this picture. Crop it closer to the QR, or type your UPI ID instead.');
      if (read === 'not_upi') throw new HttpError(400, 'qr_not_upi', 'This QR is not a UPI payment QR. Upload the QR from your UPI app (PhonePe, Google Pay, Paytm, BHIM) or type your UPI ID.');
      target = { upiId: read.upiId, payee: body.payee || read.payee };
    } else if (body.upiId) {
      const id = body.upiId.toLowerCase();
      if (!UPI_ID.test(id)) throw new HttpError(400, 'bad_upi_id', 'Enter a UPI ID like name@okhdfcbank.');
      target = { upiId: id, payee: body.payee || null };
      buf = await drawUpiQr(target);
      ext = 'png';
    } else throw new HttpError(400, 'qr_missing', 'Upload your UPI QR or type your UPI ID.');
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
    const file = `${t.id}-${hash}.${ext}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), buf);
    const cur = brandingOf(t);
    if (cur.upi.qr && cur.upi.qr.file !== file) fs.rmSync(path.join(dir, cur.upi.qr.file), { force: true });
    return view(await save(t, { ...cur, upi: { ...cur.upi, qr: { file, v: hash }, upiId: target.upiId, payee: target.payee, caption: body.caption ?? cur.upi.caption } }));
  });

  app.delete('/api/tournaments/:id/upi', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    const cur = brandingOf(t);
    if (cur.upi.qr) fs.rmSync(path.join(dir, cur.upi.qr.file), { force: true });
    return view(await save(t, { ...cur, upi: { ...cur.upi, qr: null, upiId: null, payee: null, show: false } }));
  });

  /** Logo files for the watch page and the overlay (names carry a content hash: cache a year). */
  app.get('/api/public/branding/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    const m = /^[0-9a-f-]{36}-[0-9a-f]{10}\.(png|jpg|webp)$/.exec(file);
    if (!m) throw new HttpError(404, 'not_found', 'Not found.');
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) throw new HttpError(404, 'not_found', 'Not found.');
    reply.type(m[1] === 'png' ? 'image/png' : m[1] === 'jpg' ? 'image/jpeg' : 'image/webp');
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(fs.readFileSync(p));
  });
}
