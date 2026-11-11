/**
 * Event branding: the watch page theme (by kind of event), the event's own logo (top left of
 * the watch page; the Go Live logo when there is none), a logo watermark in the video (bottom
 * right) and a TV-style scrolling ticker along the bottom of the video. The watermark and the
 * ticker are drawn by the graphics overlay, so they are part of the stream everywhere
 * (watch page, YouTube, Facebook, Instagram, replays and clips).
 */

export type ThemeFont = 'sport' | 'elegant' | 'festive' | 'clean';

export interface Theme {
  id: string;
  label: string;
  group: 'Sports' | 'Wedding & family' | 'Cultural & religious' | 'Corporate & awards';
  bg: string;
  panel: string;
  panel2: string;
  line: string;
  ink: string;
  muted: string;
  /** Main colour: buttons, highlights, ticker. */
  accent: string;
  /** Second colour: LIVE badge, alerts. */
  live: string;
  font: ThemeFont;
}

const t = (id: string, label: string, group: Theme['group'], bg: string, panel: string, accent: string, live: string, font: ThemeFont, extra: Partial<Theme> = {}): Theme => ({
  id,
  label,
  group,
  bg,
  panel,
  panel2: extra.panel2 ?? panel,
  line: extra.line ?? 'rgba(255,255,255,.1)',
  ink: extra.ink ?? '#f4f6f5',
  muted: extra.muted ?? '#a7b0ac',
  accent,
  live,
  font,
});

export const THEMES: Theme[] = [
  // Sports: stadium broadcast look, condensed bold type.
  t('cricket', 'Cricket', 'Sports', '#07142b', '#0d2247', '#ffb81c', '#e4002b', 'sport', { panel2: '#12305f' }),
  t('football', 'Football', 'Sports', '#06170e', '#0c2b1a', '#36e27b', '#ff3b3b', 'sport', { panel2: '#123a24' }),
  t('golf', 'Golf', 'Sports', '#0b0e10', '#15191c', '#e0b532', '#e53935', 'sport', { panel2: '#1b2024', line: '#252b30' }),
  t('kabaddi', 'Kabaddi', 'Sports', '#1d0d05', '#3a1608', '#ff8a00', '#e53935', 'sport', { panel2: '#4a1d0b' }),
  t('basketball', 'Basketball', 'Sports', '#120b06', '#2a1508', '#ff6a13', '#ff2d55', 'sport', { panel2: '#361c0b' }),
  t('racket', 'Tennis & badminton', 'Sports', '#0b1a14', '#123326', '#d4ff3a', '#ff4d4d', 'sport', { panel2: '#173f30' }),
  t('marathon', 'Marathon & athletics', 'Sports', '#0a0f1a', '#14203a', '#c6ff00', '#ff3d00', 'sport', { panel2: '#1a2a4a' }),
  // Wedding & family: warm, soft, elegant serif.
  t('wedding', 'Wedding', 'Wedding & family', '#1a1013', '#2b1a1f', '#e8c27a', '#d9667a', 'elegant', { panel2: '#362228', muted: '#c9b3b8' }),
  t('engagement', 'Engagement & sangeet', 'Wedding & family', '#1c0e1a', '#2e1730', '#f3b2d6', '#ff5c8a', 'elegant', { panel2: '#3a1e3c', muted: '#cdb1c6' }),
  t('birthday', 'Birthday & anniversary', 'Wedding & family', '#160f24', '#261a3d', '#ffb3d9', '#8c7bff', 'festive', { panel2: '#31224d', muted: '#c2b4d6' }),
  // Cultural & religious: festival colours.
  t('festival', 'Festival (Diwali, Holi, Eid)', 'Cultural & religious', '#1a0707', '#3a0f0f', '#ffc23d', '#ff5a1f', 'festive', { panel2: '#4a1414', muted: '#d6b9a8' }),
  t('garba', 'Garba & Navratri', 'Cultural & religious', '#1a0618', '#3a0d36', '#ff4fd8', '#ffb000', 'festive', { panel2: '#4a1145', muted: '#d4b0cf' }),
  t('devotional', 'Satsang, kirtan & puja', 'Cultural & religious', '#1a1006', '#33210c', '#ff9933', '#e04f2b', 'elegant', { panel2: '#412a10', muted: '#d6c0a3' }),
  t('concert', 'Concert & college fest', 'Cultural & religious', '#0d0618', '#1d0e36', '#b36bff', '#ff2e88', 'festive', { panel2: '#271248', muted: '#bfaee0' }),
  // Corporate & awards: clean and confident.
  t('conference', 'Conference & seminar', 'Corporate & awards', '#0b1220', '#14213a', '#4fb3ff', '#e53935', 'clean', { panel2: '#1a2a48' }),
  t('awards', 'Award night & gala', 'Corporate & awards', '#0a0a0a', '#1a1712', '#d4af37', '#c0392b', 'elegant', { panel2: '#241f17', muted: '#c2b9a5' }),
  t('launch', 'Product launch', 'Corporate & awards', '#050b18', '#0d1a33', '#3d7bff', '#ff3b6b', 'clean', { panel2: '#12234a' }),
  t('school', 'School & annual day', 'Corporate & awards', '#0b1430', '#152557', '#ffd23f', '#ff5d5d', 'clean', { panel2: '#1b2f6b' }),
];

const BY_ID = new Map(THEMES.map((x) => [x.id, x]));

/** The theme an event starts with, from its kind (cricket → cricket, wedding → wedding…). */
export function defaultThemeId(eventType: string | null | undefined): string {
  const map: Record<string, string> = { golf: 'golf', cricket: 'cricket', football: 'football', wedding: 'wedding', concert: 'concert', conference: 'conference', other: 'conference' };
  return map[eventType ?? 'golf'] ?? 'conference';
}

export const TICKER_SPEEDS = { slow: 70, normal: 110, fast: 160 } as const;

export interface Branding {
  theme: string;
  /** Owner's own main colour over the theme's (#rrggbb), or null. */
  accent: string | null;
  /** The event's own logo file (paid), or null = the Go Live logo. */
  logo: { file: string; v: string } | null;
  watermark: { enabled: boolean; size: 'small' | 'medium' | 'large'; opacity: number };
  ticker: { enabled: boolean; label: string; lines: string[]; sponsors: string[]; speed: keyof typeof TICKER_SPEEDS };
  /**
   * V9: the organiser's own UPI QR (paid per event). `qr` is the picture (uploaded, or drawn from
   * the UPI ID); `show` puts it on the video, bottom right, `size` px tall on a 1080p picture.
   * The watch page shows it whenever there is one.
   */
  upi: { qr: { file: string; v: string } | null; upiId: string | null; payee: string | null; caption: string; show: boolean; size: number };
}

export const UPI_SIZES = { S: 220, M: 300, L: 400 } as const;
export const UPI_DEFAULT_CAPTION = 'Scan to pay with any UPI app';

export function defaultBranding(eventType: string | null | undefined): Branding {
  return {
    theme: defaultThemeId(eventType),
    accent: null,
    logo: null,
    watermark: { enabled: true, size: 'medium', opacity: 0.7 },
    ticker: { enabled: false, label: 'LIVE', lines: [], sponsors: [], speed: 'normal' },
    upi: { qr: null, upiId: null, payee: null, caption: UPI_DEFAULT_CAPTION, show: false, size: UPI_SIZES.M },
  };
}

const HEX = /^#[0-9a-f]{6}$/i;
const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function brandingOf(t: { event_type?: string | null; branding?: unknown }): Branding {
  const d = defaultBranding(t.event_type);
  const s = (t.branding ?? {}) as Partial<Branding>;
  const w = (s.watermark ?? {}) as Partial<Branding['watermark']>;
  const k = (s.ticker ?? {}) as Partial<Branding['ticker']>;
  const u = (s.upi ?? {}) as Partial<Branding['upi']>;
  const qr = u.qr && typeof u.qr.file === 'string' && /^[a-z0-9-]+\.(png|jpg)$/.test(u.qr.file) ? { file: u.qr.file, v: String(u.qr.v ?? '') } : null;
  return {
    theme: typeof s.theme === 'string' && BY_ID.has(s.theme) ? s.theme : d.theme,
    accent: typeof s.accent === 'string' && HEX.test(s.accent) ? s.accent.toLowerCase() : null,
    logo: s.logo && typeof s.logo.file === 'string' && /^[a-z0-9-]+\.(png|jpg|webp)$/.test(s.logo.file) ? { file: s.logo.file, v: String(s.logo.v ?? '') } : null,
    watermark: {
      enabled: typeof w.enabled === 'boolean' ? w.enabled : d.watermark.enabled,
      size: w.size === 'small' || w.size === 'large' ? w.size : 'medium',
      opacity: typeof w.opacity === 'number' ? Math.min(1, Math.max(0.2, w.opacity)) : d.watermark.opacity,
    },
    ticker: {
      enabled: Boolean(k.enabled),
      label: clean(k.label, 16) || 'LIVE',
      lines: Array.isArray(k.lines) ? k.lines.map((x) => clean(x, 160)).filter(Boolean).slice(0, 20) : [],
      sponsors: Array.isArray(k.sponsors) ? k.sponsors.map((x) => clean(x, 120)).filter(Boolean).slice(0, 10) : [],
      speed: k.speed === 'slow' || k.speed === 'fast' ? k.speed : 'normal',
    },
    upi: {
      qr,
      upiId: typeof u.upiId === 'string' && /^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,63}$/i.test(u.upiId) ? u.upiId.toLowerCase() : null,
      payee: clean(u.payee, 80) || null,
      caption: typeof u.caption === 'string' ? clean(u.caption, 60) : d.upi.caption,
      show: Boolean(qr && u.show),
      size: typeof u.size === 'number' && Number.isFinite(u.size) ? Math.round(Math.min(440, Math.max(160, u.size))) : d.upi.size,
    },
  };
}

/** Applies an owner's partial change (unknown keys and wrong types are ignored). */
export function patchBranding(cur: Branding, p: Record<string, unknown>): Branding {
  const next = structuredClone(cur) as Branding & Record<string, unknown>;
  if (typeof p.theme === 'string' && BY_ID.has(p.theme)) next.theme = p.theme;
  if (p.accent === null || (typeof p.accent === 'string' && HEX.test(p.accent))) next.accent = (p.accent as string | null)?.toLowerCase() ?? null;
  const w = p.watermark && typeof p.watermark === 'object' ? (p.watermark as Record<string, unknown>) : null;
  if (w) Object.assign(next.watermark, w);
  const k = p.ticker && typeof p.ticker === 'object' ? (p.ticker as Record<string, unknown>) : null;
  if (k) Object.assign(next.ticker, k);
  // The director changes only how the QR shows; the QR and UPI ID come from the upload route.
  const u = p.upi && typeof p.upi === 'object' ? (p.upi as Record<string, unknown>) : null;
  if (u) {
    if (typeof u.show === 'boolean') next.upi.show = u.show;
    if (typeof u.size === 'number') next.upi.size = u.size;
    if (typeof u.caption === 'string') next.upi.caption = u.caption;
  }
  return brandingOf({ event_type: null, branding: next });
}

export function themeColors(b: Branding): Theme {
  const th = BY_ID.get(b.theme) ?? THEMES[0];
  return b.accent ? { ...th, accent: b.accent } : th;
}

/** The ticker's items in the order they scroll: the organiser's lines with a sponsor every 2 lines. */
export function tickerItems(b: Branding): { text: string; sponsor: boolean }[] {
  const out: { text: string; sponsor: boolean }[] = [];
  const { lines, sponsors } = b.ticker;
  let s = 0;
  lines.forEach((text, i) => {
    out.push({ text, sponsor: false });
    if (sponsors.length && (i + 1) % 2 === 0) out.push({ text: sponsors[s++ % sponsors.length], sponsor: true });
  });
  if (!lines.length) for (const text of sponsors) out.push({ text, sponsor: true });
  else if (sponsors.length && lines.length < 2) out.push({ text: sponsors[0], sponsor: true });
  return out;
}

/** URL of an event's own logo file (served by /api/public/branding/:file), or null. */
export const logoUrl = (b: Branding) => (b.logo ? `/api/public/branding/${b.logo.file}?v=${encodeURIComponent(b.logo.v)}` : null);

/** URL of the organiser's UPI QR picture (same file route as logos), or null. */
export const upiQrUrl = (b: Branding) => (b.upi.qr ? `/api/public/branding/${b.upi.qr.file}?v=${encodeURIComponent(b.upi.qr.v)}` : null);

/** The watch page's "Pay by UPI" card: null when there is no QR. */
export function publicUpi(b: Branding) {
  if (!b.upi.qr) return null;
  return { qrUrl: upiQrUrl(b), upiId: b.upi.upiId, payee: b.upi.payee, caption: b.upi.caption };
}

/** What the watch page needs: colours, font style and the logo (null = the Go Live logo). */
export function publicBranding(b: Branding) {
  const th = themeColors(b);
  return {
    theme: th.id,
    themeLabel: th.label,
    colors: { bg: th.bg, panel: th.panel, panel2: th.panel2, line: th.line, ink: th.ink, muted: th.muted, accent: th.accent, live: th.live },
    font: th.font,
    logoUrl: logoUrl(b),
  };
}

/** What the graphics overlay (in the video) needs: watermark and ticker, in the theme's colours. */
export function overlayBranding(b: Branding) {
  const th = themeColors(b);
  const items = tickerItems(b);
  return {
    colors: { panel: th.panel, accent: th.accent, live: th.live, ink: th.ink },
    font: th.font,
    watermark: b.watermark.enabled ? { logoUrl: logoUrl(b), size: b.watermark.size, opacity: b.watermark.opacity } : null,
    ticker: b.ticker.enabled && items.length ? { label: b.ticker.label, items, pxPerSec: TICKER_SPEEDS[b.ticker.speed] } : null,
    upiQr: b.upi.show && b.upi.qr ? { url: upiQrUrl(b), caption: b.upi.caption, size: b.upi.size, upiId: b.upi.upiId } : null,
  };
}
