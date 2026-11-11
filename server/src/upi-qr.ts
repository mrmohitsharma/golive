import jsqrModule from 'jsqr';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import QRCode from 'qrcode';

type JsQr = (data: Uint8ClampedArray, width: number, height: number, opts?: { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' }) => { data: string } | null;
// jsqr is CommonJS with `exports.default`: under Node ESM the function sits one level down.
const jsQR: JsQr = ((jsqrModule as unknown as { default?: JsQr }).default ?? jsqrModule) as unknown as JsQr;

/**
 * V9: the organiser's own UPI QR. Money goes straight from the viewer's UPI app to the organiser;
 * Go Live never touches it (and cannot see whether anyone paid). We only read the QR to check it
 * really is a UPI QR and to show the UPI ID and name next to it, or draw one from a UPI ID.
 */
export interface UpiTarget {
  upiId: string;
  payee: string | null;
}

/** A UPI ID (VPA): name@bank. */
export const UPI_ID = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;

/** Reads `upi://pay?pa=…&pn=…` (any case). null when it is not a UPI payment link. */
export function parseUpiLink(text: string): UpiTarget | null {
  const t = text.trim();
  if (!/^upi:\/\/pay\?/i.test(t)) return null;
  const q = new URLSearchParams(t.slice(t.indexOf('?') + 1));
  const get = (k: string) => {
    for (const [key, v] of q) if (key.toLowerCase() === k) return v;
    return null;
  };
  const pa = (get('pa') ?? '').trim();
  if (!UPI_ID.test(pa)) return null;
  const pn = (get('pn') ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { upiId: pa.toLowerCase(), payee: pn || null };
}

/** The UPI link for a UPI ID (no amount: apps refuse pre-filled amounts to personal UPI IDs more often). */
export function upiLink(target: UpiTarget, note?: string): string {
  const p = new URLSearchParams({ pa: target.upiId, cu: 'INR' });
  if (target.payee) p.set('pn', target.payee);
  if (note) p.set('tn', note.slice(0, 50));
  return 'upi://pay?' + p.toString().replace(/\+/g, '%20');
}

/** Pixels of a PNG or JPG (WebP cannot be read here). */
function pixels(buf: Buffer, kind: 'png' | 'jpg'): { data: Uint8ClampedArray; width: number; height: number } {
  if (kind === 'png') {
    const p = PNG.sync.read(buf);
    return { data: new Uint8ClampedArray(p.data.buffer, p.data.byteOffset, p.data.length), width: p.width, height: p.height };
  }
  const j = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 256, maxResolutionInMP: 40 });
  return { data: new Uint8ClampedArray(j.data.buffer, j.data.byteOffset, j.data.length), width: j.width, height: j.height };
}

/** Finds the QR in a picture and reads it. 'not_qr' = no QR found; 'not_upi' = a QR, but not a UPI one. */
export function readUpiQr(buf: Buffer, kind: 'png' | 'jpg'): UpiTarget | 'not_qr' | 'not_upi' {
  let img: ReturnType<typeof pixels>;
  try {
    img = pixels(buf, kind);
  } catch {
    return 'not_qr';
  }
  const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  if (!code) return 'not_qr';
  return parseUpiLink(code.data) ?? 'not_upi';
}

/** A clean, high-contrast PNG QR for a UPI ID (when the organiser types the ID instead of uploading). */
export function drawUpiQr(target: UpiTarget): Promise<Buffer> {
  return QRCode.toBuffer(upiLink(target), { type: 'png', width: 720, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
}
