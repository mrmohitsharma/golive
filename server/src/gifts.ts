import crypto from 'node:crypto';
import type { Config } from './config.js';
import type { Repo, TournamentRow } from './repo.js';
import type { Sealer } from './crypto.js';
import { HttpError } from './errors.js';

/**
 * V9 gift credits: viewers send the organiser a gift (a sticker with an amount, their name and
 * a message) during a live show, paid by UPI through Cashfree. GST comes out first (by default),
 * then Go Live's share, the gateway fee and TDS; the rest is paid to the club's verified bank
 * account once the gift is older than the hold period (7 days). Every number is an admin setting.
 */

export interface Sticker {
  id: string;
  name: string;
  emoji: string;
  amount: number;
}

export interface GiftSettings {
  enabled: boolean;
  /** What viewers and organisers see: "Gift credits", "Shagun"… */
  label: string;
  /** The button on the watch page. */
  button: string;
  sharePct: number;
  gstPct: number;
  /** gift_first: the gift includes GST, taken out before the share. share_only: GST is inside our share. */
  gstMode: 'gift_first' | 'share_only';
  tdsPct: number;
  tdsBase: 'gross' | 'net';
  feePct: number;
  feePaidBy: 'organiser' | 'platform';
  holdDays: number;
  minPayoutInr: number;
  // Fraud limits
  minGiftInr: number;
  maxGiftInr: number;
  perDeviceDailyInr: number;
  perDeviceHourlyCount: number;
  perIpHourlyCount: number;
  clubDailyInr: number;
  onlyWhileLive: boolean;
  /** Cashfree needs a phone on every order; viewers are not asked, so this one is sent. */
  payerPhone: string;
  stickers: Sticker[];
  blockedWords: string[];
}

export const DEFAULT_GIFT_SETTINGS: GiftSettings = {
  enabled: true,
  label: 'Gift credits',
  button: 'Gift',
  sharePct: 15,
  gstPct: 18,
  gstMode: 'gift_first',
  tdsPct: 0.1,
  tdsBase: 'gross',
  feePct: 2,
  feePaidBy: 'organiser',
  holdDays: 7,
  minPayoutInr: 100,
  minGiftInr: 10,
  maxGiftInr: 10000,
  perDeviceDailyInr: 25000,
  perDeviceHourlyCount: 20,
  perIpHourlyCount: 40,
  clubDailyInr: 200000,
  onlyWhileLive: true,
  payerPhone: '9664403568',
  stickers: [
    { id: 'clap', name: 'Clap', emoji: '👏', amount: 21 },
    { id: 'fire', name: 'Fire', emoji: '🔥', amount: 51 },
    { id: 'trophy', name: 'Trophy', emoji: '🏆', amount: 101 },
    { id: 'diamond', name: 'Diamond', emoji: '💎', amount: 501 },
    { id: 'crown', name: 'Crown', emoji: '👑', amount: 1100 },
  ],
  blockedWords: [],
};

/** Settings a club can have its own value for (Admin > Clubs). */
export const OVERRIDABLE = ['enabled', 'sharePct', 'minGiftInr', 'maxGiftInr', 'perDeviceDailyInr', 'clubDailyInr'] as const;
export type GiftOverrides = Partial<Pick<GiftSettings, (typeof OVERRIDABLE)[number]>>;

export interface EventGifts {
  enabled: boolean;
  /** Overrides the platform button text for this event ("Shagun", "Seva"). */
  button: string | null;
  stickers: Sticker[];
  allowCustom: boolean;
  inVideo: boolean;
  topSupporters: boolean;
  /** Hold messages until the organiser approves them (the money is the same). */
  approval: boolean;
  goal: { amount: number | null; text: string };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: unknown, lo: number, hi: number, d: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d);
const str = (s: unknown, max: number, d = '') => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : d);

export function cleanStickers(v: unknown, fallback: Sticker[]): Sticker[] {
  if (!Array.isArray(v)) return fallback;
  const out: Sticker[] = [];
  for (const x of v.slice(0, 12)) {
    const o = (x ?? {}) as Record<string, unknown>;
    const name = str(o.name, 24);
    const amount = typeof o.amount === 'number' ? Math.round(o.amount) : NaN;
    if (!name || !(amount >= 1 && amount <= 1_000_000)) continue;
    const id = str(o.id, 24).toLowerCase().replace(/[^a-z0-9-]/g, '') || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24) || `s${out.length + 1}`;
    out.push({ id: out.some((s) => s.id === id) ? `${id}-${out.length}` : id, name, emoji: str(o.emoji, 8) || '🎁', amount });
  }
  return out.sort((a, b) => a.amount - b.amount);
}

export function mergeGiftSettings(stored: unknown): GiftSettings {
  const d = DEFAULT_GIFT_SETTINGS;
  const s = (stored ?? {}) as Partial<GiftSettings>;
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : d.enabled,
    label: str(s.label, 30) || d.label,
    button: str(s.button, 20) || d.button,
    sharePct: clamp(s.sharePct, 0, 90, d.sharePct),
    gstPct: clamp(s.gstPct, 0, 40, d.gstPct),
    gstMode: s.gstMode === 'share_only' ? 'share_only' : 'gift_first',
    tdsPct: clamp(s.tdsPct, 0, 30, d.tdsPct),
    tdsBase: s.tdsBase === 'net' ? 'net' : 'gross',
    feePct: clamp(s.feePct, 0, 10, d.feePct),
    feePaidBy: s.feePaidBy === 'platform' ? 'platform' : 'organiser',
    holdDays: clamp(s.holdDays, 0, 60, d.holdDays),
    minPayoutInr: clamp(s.minPayoutInr, 0, 100000, d.minPayoutInr),
    minGiftInr: clamp(s.minGiftInr, 1, 100000, d.minGiftInr),
    maxGiftInr: clamp(s.maxGiftInr, 1, 1000000, d.maxGiftInr),
    perDeviceDailyInr: clamp(s.perDeviceDailyInr, 1, 10000000, d.perDeviceDailyInr),
    perDeviceHourlyCount: clamp(s.perDeviceHourlyCount, 1, 1000, d.perDeviceHourlyCount),
    perIpHourlyCount: clamp(s.perIpHourlyCount, 1, 10000, d.perIpHourlyCount),
    clubDailyInr: clamp(s.clubDailyInr, 1, 100000000, d.clubDailyInr),
    onlyWhileLive: typeof s.onlyWhileLive === 'boolean' ? s.onlyWhileLive : d.onlyWhileLive,
    payerPhone: typeof s.payerPhone === 'string' && /^\d{10}$/.test(s.payerPhone.replace(/\D/g, '').slice(-10)) ? s.payerPhone.replace(/\D/g, '').slice(-10) : d.payerPhone,
    stickers: cleanStickers(s.stickers, d.stickers),
    blockedWords: Array.isArray(s.blockedWords) ? s.blockedWords.map((w) => str(w, 40).toLowerCase()).filter(Boolean).slice(0, 500) : d.blockedWords,
  };
}

export function applyOverrides(s: GiftSettings, o: unknown): GiftSettings {
  const ov = (o ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...s };
  for (const k of OVERRIDABLE) if (ov[k] !== undefined && ov[k] !== null && typeof ov[k] === typeof s[k]) out[k] = ov[k];
  return mergeGiftSettings(out);
}

export function eventGifts(t: { gifts?: unknown }, s: GiftSettings): EventGifts {
  const g = (t.gifts ?? {}) as Partial<EventGifts>;
  const goal = (g.goal ?? {}) as Partial<EventGifts['goal']>;
  return {
    enabled: Boolean(g.enabled),
    button: str(g.button, 20) || null,
    stickers: cleanStickers(g.stickers, s.stickers),
    allowCustom: typeof g.allowCustom === 'boolean' ? g.allowCustom : true,
    inVideo: typeof g.inVideo === 'boolean' ? g.inVideo : true,
    topSupporters: typeof g.topSupporters === 'boolean' ? g.topSupporters : true,
    approval: Boolean(g.approval),
    goal: { amount: typeof goal.amount === 'number' && goal.amount > 0 ? Math.round(goal.amount) : null, text: str(goal.text, 80) },
  };
}

export interface GiftSplit {
  gross: number;
  gst: number;
  /** Gateway fee (whoever pays it). */
  fee: number;
  /** Go Live's share. */
  share: number;
  tds: number;
  /** What the organiser receives. */
  net: number;
  mode: GiftSettings['gstMode'];
  sharePct: number;
  gstPct: number;
  tdsPct: number;
  feePct: number;
  feePaidBy: GiftSettings['feePaidBy'];
}

/**
 * The split of one gift. gift_first: GST is taken out of the gift first (the gift includes it),
 * then Go Live's share of what is left. share_only: Go Live's share of the gift includes the GST.
 * Then the gateway fee (when the organiser pays it) and TDS on the gross or on the payout.
 */
export function giftSplit(amount: number, s: Pick<GiftSettings, 'sharePct' | 'gstPct' | 'gstMode' | 'tdsPct' | 'tdsBase' | 'feePct' | 'feePaidBy'>): GiftSplit {
  const gross = r2(amount);
  const fee = r2((gross * s.feePct) / 100);
  let gst: number;
  let share: number;
  if (s.gstMode === 'gift_first') {
    gst = r2((gross * s.gstPct) / (100 + s.gstPct));
    share = r2(((gross - gst) * s.sharePct) / 100);
  } else {
    share = r2((gross * s.sharePct) / 100);
    gst = r2((share * s.gstPct) / (100 + s.gstPct));
  }
  const feeOrg = s.feePaidBy === 'organiser' ? fee : 0;
  const beforeTds = r2(gross - (s.gstMode === 'gift_first' ? gst : 0) - share - feeOrg);
  const tds = r2(((s.tdsBase === 'gross' ? gross : beforeTds) * s.tdsPct) / 100);
  const net = Math.max(0, r2(beforeTds - tds));
  return { gross, gst, fee, share, tds, net, mode: s.gstMode, sharePct: s.sharePct, gstPct: s.gstPct, tdsPct: s.tdsPct, feePct: s.feePct, feePaidBy: s.feePaidBy };
}

export interface GiftRow {
  id: string;
  tournament_id: string;
  org_id: string;
  order_id: string;
  session_id: string | null;
  status: 'created' | 'paid' | 'failed' | 'expired' | 'refunded';
  sender_name: string;
  message: string | null;
  sticker: { id?: string; name?: string; emoji?: string };
  amount_inr: string;
  gst_inr: string | null;
  fee_inr: string | null;
  share_inr: string | null;
  tds_inr: string | null;
  net_inr: string | null;
  split: GiftSplit | null;
  approved: boolean;
  hidden: boolean;
  in_video: boolean;
  chat_message_id: string | null;
  paid_at: Date | null;
  payable_at: Date | null;
  payout_id: string | null;
  created_at: Date;
}

export const giftPublicDto = (g: GiftRow) => ({
  id: g.id,
  name: g.sender_name,
  message: g.message,
  amount: Number(g.amount_inr),
  emoji: g.sticker?.emoji ?? '🎁',
  sticker: g.sticker?.name ?? null,
  at: (g.paid_at ?? g.created_at).toISOString(),
});

export const giftStaffDto = (g: GiftRow) => ({
  ...giftPublicDto(g),
  status: g.status,
  approved: g.approved,
  hidden: g.hidden,
  inVideo: g.in_video,
  net: g.net_inr == null ? null : Number(g.net_inr),
  payableAt: g.payable_at?.toISOString() ?? null,
  paidOut: Boolean(g.payout_id),
});

export interface PayeeRow {
  org_id: string;
  legal_name: string;
  pan_enc: string;
  pan_last4: string;
  account_holder: string;
  account_enc: string;
  account_last4: string;
  ifsc: string;
  gstin: string | null;
  email: string;
  status: 'pending' | 'verified' | 'rejected';
  status_note: string | null;
  verified_by: string | null;
  verified_at: Date | null;
  updated_at: Date;
}

export const payeeDto = (p: PayeeRow | null) =>
  p && {
    legalName: p.legal_name,
    pan: `••••••${p.pan_last4}`,
    accountHolder: p.account_holder,
    account: `••••${p.account_last4}`,
    ifsc: p.ifsc,
    gstin: p.gstin,
    email: p.email,
    status: p.status,
    statusNote: p.status_note,
    verifiedAt: p.verified_at?.toISOString() ?? null,
  };

export interface AgreementRow {
  id: string;
  org_id: string;
  version: string;
  text: string;
  text_hash: string;
  sent_to: string;
  sent_by: string | null;
  sent_at: Date;
  expires_at: Date;
  signed_at: Date | null;
  signer_name: string | null;
  signer_ip: string | null;
  signer_agent: string | null;
  revoked_at: Date | null;
}

export const agreementDto = (a: AgreementRow | null) =>
  a && {
    id: a.id,
    version: a.version,
    sentTo: a.sent_to,
    sentAt: a.sent_at.toISOString(),
    expiresAt: a.expires_at.toISOString(),
    signedAt: a.signed_at?.toISOString() ?? null,
    signerName: a.signer_name,
    fingerprint: a.text_hash.slice(0, 16),
    state: a.revoked_at ? 'revoked' : a.signed_at ? 'signed' : a.expires_at.getTime() < Date.now() ? 'expired' : 'sent',
  };

export interface PayoutRow {
  id: string;
  org_id: string;
  gift_count: number;
  gross_inr: string;
  gst_inr: string;
  fee_inr: string;
  share_inr: string;
  tds_inr: string;
  net_inr: string;
  status: 'due' | 'paid' | 'cancelled';
  utr: string | null;
  created_by: string | null;
  created_at: Date;
  paid_by: string | null;
  paid_at: Date | null;
  org_name?: string;
}

export const payoutDto = (p: PayoutRow) => ({
  id: p.id,
  orgId: p.org_id,
  orgName: p.org_name ?? null,
  gifts: p.gift_count,
  gross: Number(p.gross_inr),
  gst: Number(p.gst_inr),
  fee: Number(p.fee_inr),
  share: Number(p.share_inr),
  tds: Number(p.tds_inr),
  net: Number(p.net_inr),
  status: p.status,
  utr: p.utr,
  createdAt: p.created_at.toISOString(),
  paidAt: p.paid_at?.toISOString() ?? null,
});

export const AGREEMENT_VERSION = 'GL-GIFTS-2026-11';

/** The payout agreement text, with the club's details and today's settings written into it. */
export function agreementText(v: { entity: string; address: string; brand: string; club: string; payee: Pick<PayeeRow, 'legal_name' | 'account_holder' | 'account_last4' | 'ifsc'>; s: GiftSettings; date: string }): string {
  const s = v.s;
  const gst = s.gstMode === 'gift_first' ? `GST at ${s.gstPct}% is treated as included in each gift and is taken out first` : `GST at ${s.gstPct}% is included in ${v.entity}'s share`;
  return [
    `${v.brand} ${s.label}: Payout Agreement (version ${AGREEMENT_VERSION})`,
    `This agreement is between ${v.entity}, ${v.address} ("Go Live", operator of ${v.brand}) and ${v.payee.legal_name} ("the Organiser"), who runs the club "${v.club}" on ${v.brand}. Date sent: ${v.date}.`,
    `1. What this covers. Viewers of the Organiser's live broadcasts on ${v.brand} may send ${s.label} (gifts with an amount, a name and a message). Go Live collects these payments through its payment gateway on the Organiser's behalf and pays the Organiser as set out below.`,
    `2. How each gift is split. For each gift: ${gst}; Go Live keeps a service share of ${s.sharePct}% ${s.gstMode === 'gift_first' ? 'of the amount after GST' : 'of the gift'}; the payment gateway fee (currently about ${s.feePct}%) is paid by ${s.feePaidBy === 'organiser' ? 'the Organiser' : 'Go Live'}; tax deducted at source (currently ${s.tdsPct}% under section 194-O of the Income-tax Act, or as the law requires) is deducted and deposited in the Organiser's PAN. The remainder is the Organiser's payout. Go Live may change these rates for future gifts with 15 days' notice by email; gifts already received keep the rates in force when they were paid.`,
    `3. Payouts. A gift becomes payable ${s.holdDays} days after it is paid. Payable amounts are paid to the bank account ${v.payee.account_holder}, account ending ${v.payee.account_last4}, IFSC ${v.payee.ifsc}, in a weekly payout, when they total at least ₹${s.minPayoutInr}. Each payout comes with a statement of every gift, the GST, fees, share, TDS and net amount. Go Live issues a GST invoice for its share.`,
    `4. Refunds and disputes. Gifts are voluntary and are not refunded once shown, except a failed, duplicate or wrongly charged payment. If a payment is reversed by a bank or the gateway (a chargeback), the amount is deducted from the Organiser's next payout or, if none is due, the Organiser repays it within 15 days.`,
    `5. The Organiser's promises. The Organiser's details (legal name, PAN, bank account) are true and the account is in the Organiser's name. The Organiser will not use gifts for anything unlawful, will not send gifts to its own broadcasts to move money, and is responsible for its own taxes on the payouts, including any tax on gifts received.`,
    `6. Holds and suspension. Go Live may hold a payout and switch gifts off for the Organiser's events if it reasonably suspects fraud, misuse, a breach of this agreement or of the ${v.brand} Terms of service, or if the law or the payment gateway requires it, and will tell the Organiser why where the law allows.`,
    `7. Ending. Either party may end this agreement by email. Gifts already paid are still paid out under it, less any refunds and chargebacks.`,
    `8. Law. This agreement is governed by the laws of India and is subject to the ${v.brand} Terms of service. The courts at Gurugram, Haryana have jurisdiction.`,
    `9. Signing. The Organiser signs this agreement electronically by opening the link sent to its email address, typing its full name and confirming. Go Live keeps a record of the time, the IP address, the browser and a fingerprint of this text, and emails a signed copy to both parties.`,
  ].join('\n\n');
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;

export function sealPayee(sealer: Sealer, v: { pan: string; account: string }) {
  return { pan_enc: sealer.seal(v.pan), pan_last4: v.pan.slice(-4), account_enc: sealer.seal(v.account), account_last4: v.account.slice(-4) };
}

export type GiftDeps = { config: Config; repo: Repo };
export type { TournamentRow };
