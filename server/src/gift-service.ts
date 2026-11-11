import crypto from 'node:crypto';
import type pg from 'pg';
import type { Config } from './config.js';
import type { Repo, TournamentRow } from './repo.js';
import type { Sealer } from './crypto.js';
import type { PaymentsService } from './payments.js';
import type { ChatService } from './chat.js';
import type { GraphicsService } from './graphics.js';
import type { Mailer } from './email.js';
import { HttpError } from './errors.js';
import { TtlCache } from './ttl-cache.js';
import {
  AGREEMENT_VERSION,
  agreementText,
  applyOverrides,
  eventGifts,
  giftSplit,
  IFSC,
  mergeGiftSettings,
  PAN,
  sealPayee,
  sha256,
  type AgreementRow,
  type EventGifts,
  type GiftRow,
  type GiftSettings,
  type PayeeRow,
  type PayoutRow,
  type Sticker,
} from './gifts.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);

export class GiftService {
  /** Is this event on air now (set by the app from the hub). */
  isLive: (tournamentId: string) => boolean = () => false;
  private hits = new Map<string, number[]>();
  /** Hot reads: settings and readiness (30 s), each event's public gift view (5 s). Dropped on change. */
  private cache = new TtlCache();

  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
    private readonly payments: PaymentsService,
    private readonly chat: ChatService,
    private readonly graphics: GraphicsService,
    private readonly mailer: Mailer,
    private readonly sealer: Sealer,
  ) {
    payments.giftConfirm = async (orderId) => {
      const g = await this.byOrder(orderId);
      if (!g) return null;
      return `gift ${(await this.confirm(g)).status}`;
    };
  }

  private get db() {
    return this.repo.db;
  }
  private get base() {
    return this.config.PUBLIC_BASE_URL.replace(/\/$/, '');
  }

  // ---------------------------------------------------------------- settings
  async settings(): Promise<GiftSettings> {
    return this.cache.get('settings', 30_000, async () => {
      const r = (await this.db.query<{ gifts: unknown }>('SELECT gifts FROM platform_settings WHERE id')).rows[0];
      return mergeGiftSettings(r?.gifts);
    });
  }

  async saveSettings(v: unknown): Promise<GiftSettings> {
    const s = mergeGiftSettings(v);
    await this.db.query('UPDATE platform_settings SET gifts = $1 WHERE id', [JSON.stringify(s)]);
    this.cache.drop('*');
    return s;
  }

  async overrides(orgId: string): Promise<Record<string, unknown>> {
    return this.cache.get(`ov:${orgId}`, 30_000, async () => {
      const r = (await this.db.query<{ gift_overrides: Record<string, unknown> }>('SELECT gift_overrides FROM org_billing WHERE org_id = $1', [orgId])).rows[0];
      return r?.gift_overrides ?? {};
    });
  }

  async saveOverrides(orgId: string, v: Record<string, unknown>): Promise<void> {
    await this.db.query('INSERT INTO org_billing (org_id) VALUES ($1) ON CONFLICT DO NOTHING', [orgId]);
    await this.db.query('UPDATE org_billing SET gift_overrides = $2 WHERE org_id = $1', [orgId, JSON.stringify(v)]);
    this.cache.drop('*');
  }

  /** A club's payout set-up changed: readiness and every public view are read again. */
  private clubChanged(orgId: string): void {
    this.cache.drop(`ready:${orgId}`);
    this.cache.drop('view:*');
  }

  /** An event's gifts changed (a gift paid, approved, hidden; its set-up saved). */
  eventChanged(tid: string): void {
    this.cache.drop(`view:${tid}`);
  }

  /** The platform settings with the club's own values on top. */
  async forOrg(orgId: string): Promise<GiftSettings> {
    return applyOverrides(await this.settings(), await this.overrides(orgId));
  }

  // ---------------------------------------------------------------- payout readiness
  async payee(orgId: string): Promise<PayeeRow | null> {
    return (await this.db.query<PayeeRow>('SELECT * FROM payee_accounts WHERE org_id = $1', [orgId])).rows[0] ?? null;
  }

  async agreement(orgId: string): Promise<AgreementRow | null> {
    return (await this.db.query<AgreementRow>('SELECT * FROM payout_agreements WHERE org_id = $1 AND revoked_at IS NULL ORDER BY sent_at DESC LIMIT 1', [orgId])).rows[0] ?? null;
  }

  async signedAgreement(orgId: string): Promise<AgreementRow | null> {
    return (
      (await this.db.query<AgreementRow>('SELECT * FROM payout_agreements WHERE org_id = $1 AND revoked_at IS NULL AND signed_at IS NOT NULL ORDER BY signed_at DESC LIMIT 1', [orgId])).rows[0] ??
      null
    );
  }

  /** Why a club cannot take gifts yet, or null when it can. */
  async notReady(orgId: string): Promise<string | null> {
    return this.cache.get(`ready:${orgId}`, 30_000, () => this.readiness(orgId));
  }

  private async readiness(orgId: string): Promise<string | null> {
    const s = await this.forOrg(orgId);
    if (!s.enabled) return `${s.label} are switched off for this club.`;
    const p = await this.payee(orgId);
    if (!p) return 'Add your payout details (Club > Gifts & payouts).';
    if (p.status !== 'verified') return p.status === 'rejected' ? `Your payout details were not accepted: ${p.status_note ?? 'check them and save again'}.` : 'Your payout details are waiting for Go Live to verify them.';
    if (!(await this.signedAgreement(orgId))) return 'Sign the payout agreement sent to your email.';
    if (!this.payments.enabled) return 'Online payments are not set up on this server yet.';
    return null;
  }

  async savePayee(orgId: string, v: { legalName: string; pan: string; accountHolder: string; account: string; ifsc: string; gstin?: string | null; email: string }): Promise<PayeeRow> {
    const pan = v.pan.toUpperCase().replace(/\s/g, '');
    const ifsc = v.ifsc.toUpperCase().replace(/\s/g, '');
    const account = v.account.replace(/\s/g, '');
    if (!PAN.test(pan)) throw new HttpError(400, 'bad_pan', 'PAN must look like ABCDE1234F.');
    if (!IFSC.test(ifsc)) throw new HttpError(400, 'bad_ifsc', 'IFSC must look like HDFC0001234.');
    if (!/^\d{9,18}$/.test(account)) throw new HttpError(400, 'bad_account', 'Bank account number must be 9 to 18 digits.');
    const sealed = sealPayee(this.sealer, { pan, account });
    await this.db.query(
      `INSERT INTO payee_accounts (org_id, legal_name, pan_enc, pan_last4, account_holder, account_enc, account_last4, ifsc, gstin, email, status, status_note, verified_by, verified_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', NULL, NULL, NULL, now())
       ON CONFLICT (org_id) DO UPDATE SET legal_name = $2, pan_enc = $3, pan_last4 = $4, account_holder = $5, account_enc = $6, account_last4 = $7, ifsc = $8, gstin = $9, email = $10,
         status = 'pending', status_note = NULL, verified_by = NULL, verified_at = NULL, updated_at = now()`,
      [orgId, v.legalName.trim().slice(0, 120), sealed.pan_enc, sealed.pan_last4, v.accountHolder.trim().slice(0, 120), sealed.account_enc, sealed.account_last4, ifsc, v.gstin?.trim().toUpperCase() || null, v.email.trim().toLowerCase()],
    );
    // New bank details: any agreement signed for the old account must be signed again.
    await this.db.query('UPDATE payout_agreements SET revoked_at = now() WHERE org_id = $1 AND revoked_at IS NULL', [orgId]);
    this.clubChanged(orgId);
    return (await this.payee(orgId))!;
  }

  async verifyPayee(orgId: string, ok: boolean, note: string | null, by: string): Promise<PayeeRow> {
    const r = await this.db.query<PayeeRow>(
      `UPDATE payee_accounts SET status = $2, status_note = $3, verified_by = $4, verified_at = CASE WHEN $2 = 'verified' THEN now() ELSE NULL END WHERE org_id = $1 RETURNING *`,
      [orgId, ok ? 'verified' : 'rejected', note, by],
    );
    if (!r.rows[0]) throw new HttpError(404, 'payee_not_found', 'This club has no payout details.');
    this.clubChanged(orgId);
    return r.rows[0];
  }

  /** Full bank details, for the admin's bank file only. */
  unsealed(p: PayeeRow) {
    return { pan: this.sealer.open(p.pan_enc), account: this.sealer.open(p.account_enc) };
  }

  // ---------------------------------------------------------------- the agreement
  async sendAgreement(orgId: string, by: string): Promise<AgreementRow> {
    const p = await this.payee(orgId);
    if (!p) throw new HttpError(409, 'no_payee', 'Add your payout details first.');
    const org = await this.repo.orgById(orgId);
    const s = await this.forOrg(orgId);
    const text = agreementText({
      entity: this.config.LEGAL_ENTITY,
      address: this.config.LEGAL_ADDRESS,
      brand: this.config.BRAND_NAME,
      club: org?.name ?? 'your club',
      payee: p,
      s,
      date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }),
    });
    const token = crypto.randomBytes(24).toString('base64url');
    await this.db.query('UPDATE payout_agreements SET revoked_at = now() WHERE org_id = $1 AND signed_at IS NULL AND revoked_at IS NULL', [orgId]);
    const a = (
      await this.db.query<AgreementRow>(
        `INSERT INTO payout_agreements (org_id, version, text, text_hash, sent_to, token_hash, sent_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '14 days') RETURNING *`,
        [orgId, AGREEMENT_VERSION, text, sha256(text), p.email, sha256(token), by],
      )
    ).rows[0];
    await this.mailer.send({
      to: p.email,
      subject: `Sign your ${s.label} payout agreement`,
      body: [
        `Hello ${p.legal_name},`,
        `To receive ${s.label} from viewers of ${org?.name ?? 'your club'}'s live broadcasts, please read and sign the payout agreement.`,
        'Open the link, read the agreement, type your full name and confirm. The link works for 14 days and only for you: do not forward this email.',
      ],
      button: { text: 'Read and sign', url: `${this.base}/agreement/${token}` },
      kind: 'gift_agreement',
      ref: a.id,
      orgId,
    });
    return a;
  }

  async agreementByToken(token: string): Promise<AgreementRow | null> {
    return (await this.db.query<AgreementRow>('SELECT * FROM payout_agreements WHERE token_hash = $1', [sha256(token)])).rows[0] ?? null;
  }

  async sign(token: string, v: { name: string; ip: string; agent: string }): Promise<AgreementRow> {
    const a = await this.agreementByToken(token);
    if (!a || a.revoked_at) throw new HttpError(404, 'agreement_not_found', 'This link is no longer valid. Ask for a new one from Club > Gifts & payouts.');
    if (a.signed_at) return a;
    if (a.expires_at.getTime() < Date.now()) throw new HttpError(410, 'agreement_expired', 'This link has expired. Send a new one from Club > Gifts & payouts.');
    const name = v.name.replace(/\s+/g, ' ').trim();
    if (name.length < 3) throw new HttpError(400, 'name_required', 'Type your full name to sign.');
    const r = await this.db.query<AgreementRow>(
      'UPDATE payout_agreements SET signed_at = now(), signer_name = $2, signer_ip = $3, signer_agent = $4 WHERE id = $1 AND signed_at IS NULL RETURNING *',
      [a.id, name.slice(0, 120), v.ip, v.agent.slice(0, 300)],
    );
    const signed = r.rows[0] ?? (await this.agreementByToken(token))!;
    this.clubChanged(a.org_id);
    const s = await this.forOrg(a.org_id);
    const copy = [
      `Signed by ${signed.signer_name} on ${signed.signed_at!.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST from IP ${signed.signer_ip}.`,
      `Agreement fingerprint (SHA-256): ${signed.text_hash}`,
      ...signed.text.split('\n\n'),
    ];
    await this.mailer.send({ to: signed.sent_to, subject: `Signed: ${s.label} payout agreement`, body: ['Thank you. Here is your signed copy.', ...copy], kind: 'gift_agreement_signed', ref: `${signed.id}:club`, orgId: a.org_id });
    await this.mailer.toTeam({ subject: `Payout agreement signed: ${signed.signer_name}`, body: copy, kind: 'gift_agreement_signed', ref: `${signed.id}:team` });
    return signed;
  }

  // ---------------------------------------------------------------- viewers
  async byId(id: string): Promise<GiftRow | null> {
    return (await this.db.query<GiftRow>('SELECT * FROM gifts WHERE id = $1', [id])).rows[0] ?? null;
  }
  async byOrder(orderId: string): Promise<GiftRow | null> {
    return (await this.db.query<GiftRow>('SELECT * FROM gifts WHERE order_id = $1', [orderId])).rows[0] ?? null;
  }

  async eventConfig(t: TournamentRow): Promise<{ s: GiftSettings; e: EventGifts }> {
    const s = await this.forOrg(t.org_id);
    return { s, e: eventGifts(t, s) };
  }

  /** Can a viewer gift now, and if not, why (shown on the watch page only when useful). */
  async openReason(t: TournamentRow): Promise<string | null> {
    const { s, e } = await this.eventConfig(t);
    if (!e.enabled) return 'off';
    const nr = await this.notReady(t.org_id);
    if (nr) return nr;
    if (s.onlyWhileLive && !this.isLive(t.id)) return `${s.label} open when the broadcast is live.`;
    return null;
  }

  async totals(tid: string) {
    const r = (await this.db.query<{ n: number; sum: string | null }>("SELECT count(*)::int AS n, sum(amount_inr) AS sum FROM gifts WHERE tournament_id = $1 AND status = 'paid'", [tid])).rows[0];
    return { count: r.n, raised: Number(r.sum ?? 0) };
  }

  async top(tid: string, n = 10) {
    return (
      await this.db.query<{ name: string; total: string; count: number }>(
        `SELECT sender_name AS name, sum(amount_inr) AS total, count(*)::int AS count FROM gifts WHERE tournament_id = $1 AND status = 'paid' AND NOT hidden
         GROUP BY lower(sender_name), sender_name ORDER BY sum(amount_inr) DESC LIMIT $2`,
        [tid, n],
      )
    ).rows.map((r) => ({ name: r.name, total: Number(r.total), count: r.count }));
  }

  /** What every viewer's watch page polls: cached 5 s per event, dropped when a gift lands. */
  async publicView(t: TournamentRow) {
    return this.cache.get(`view:${t.id}`, 5_000, () => this.buildPublicView(t));
  }

  /** Same, without even reading the event when the view is cached (the public poll route). */
  async publicViewById(tid: string, load: () => Promise<TournamentRow>) {
    return this.cache.get(`view:${tid}`, 5_000, async () => this.buildPublicView(await load()));
  }

  private async buildPublicView(t: TournamentRow) {
    const { s, e } = await this.eventConfig(t);
    if (!e.enabled) return { enabled: false };
    const reason = await this.openReason(t);
    const totals = await this.totals(t.id);
    const recent = (
      await this.db.query<GiftRow>("SELECT * FROM gifts WHERE tournament_id = $1 AND status = 'paid' AND approved AND NOT hidden ORDER BY paid_at DESC LIMIT 20", [t.id])
    ).rows;
    return {
      enabled: true,
      open: reason === null,
      reason,
      label: s.label,
      button: e.button ?? s.button,
      stickers: e.stickers,
      allowCustom: e.allowCustom,
      min: s.minGiftInr,
      max: s.maxGiftInr,
      goal: e.goal.amount ? { amount: e.goal.amount, text: e.goal.text, raised: totals.raised } : null,
      top: e.topSupporters ? await this.top(t.id, 5) : [],
      recent: recent.map((g) => ({ id: g.id, name: g.sender_name, message: g.message, amount: Number(g.amount_inr), emoji: g.sticker?.emoji ?? '🎁', at: (g.paid_at ?? g.created_at).toISOString() })),
    };
  }

  private limit(key: string, max: number, windowMs: number, msg: string) {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((x) => now - x < windowMs);
    if (list.length >= max) throw new HttpError(429, 'gift_limit', msg);
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 20000) this.hits.clear();
  }

  /** A viewer starts a gift: checks, limits, a UPI order. Returns where to pay. */
  async create(t: TournamentRow, v: { name: string; message?: string | null; stickerId?: string | null; amount?: number | null; device: string; ip: string }) {
    const { s, e } = await this.eventConfig(t);
    const reason = !e.enabled ? 'off' : (await this.notReady(t.org_id)) ?? (s.onlyWhileLive && !this.isLive(t.id) ? `${s.label} open when the broadcast is live.` : null);
    if (reason) throw new HttpError(409, 'gifts_closed', reason === 'off' ? `${s.label} are not on for this event.` : reason);
    const name = v.name.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (name.length < 2) throw new HttpError(400, 'name_required', 'Type your name (it shows with your gift).');
    let sticker: Partial<Sticker> = { name: 'Gift', emoji: '🎁' };
    let amount: number;
    if (v.stickerId) {
      const st = e.stickers.find((x) => x.id === v.stickerId);
      if (!st) throw new HttpError(400, 'bad_sticker', 'That sticker is not offered any more. Pick another.');
      sticker = { id: st.id, name: st.name, emoji: st.emoji };
      amount = st.amount;
    } else {
      if (!e.allowCustom) throw new HttpError(400, 'pick_sticker', 'Pick one of the stickers.');
      amount = Math.round(Number(v.amount) * 100) / 100;
    }
    if (!(amount >= s.minGiftInr)) throw new HttpError(400, 'gift_too_small', `The smallest gift is ₹${s.minGiftInr}.`);
    if (amount > s.maxGiftInr) throw new HttpError(400, 'gift_too_big', `The largest gift is ₹${s.maxGiftInr.toLocaleString('en-IN')}.`);
    // Messages: abuse masked like chat; blocked words (admin list) refused.
    let message = v.message ? this.chat.clean(v.message.slice(0, 120)) : null;
    if (message && s.blockedWords.some((w) => message!.toLowerCase().includes(w))) throw new HttpError(400, 'message_blocked', 'Your message has words that are not allowed. Change it and try again.');
    if (message && /(https?:\/\/|www\.)/i.test(message)) message = message.replace(/(https?:\/\/|www\.)\S*/gi, '…');
    const device = hash(`dev:${v.device}`);
    const ip = hash(`ip:${v.ip}`);
    // Fraud limits: per device per hour (count) and day (₹), per network per hour, per club per day.
    this.limit(`d:${device}`, s.perDeviceHourlyCount, 3_600_000, 'Too many gifts from this phone in the last hour. Try again later.');
    this.limit(`i:${ip}`, s.perIpHourlyCount, 3_600_000, 'Too many gifts from this network in the last hour. Try again later.');
    const day = (
      await this.db.query<{ dev: string | null; club: string | null }>(
        `SELECT sum(amount_inr) FILTER (WHERE device_hash = $1) AS dev, sum(amount_inr) FILTER (WHERE org_id = $2) AS club
           FROM gifts WHERE status = 'paid' AND paid_at > now() - interval '1 day' AND (device_hash = $1 OR org_id = $2)`,
        [device, t.org_id],
      )
    ).rows[0];
    if (Number(day.dev ?? 0) + amount > s.perDeviceDailyInr) throw new HttpError(429, 'gift_limit', `Gifts from one phone are limited to ₹${s.perDeviceDailyInr.toLocaleString('en-IN')} a day.`);
    if (Number(day.club ?? 0) + amount > s.clubDailyInr) throw new HttpError(429, 'gift_limit', `This club has reached today's gift limit. Thank you for your support!`);
    const orderId = `gf_${crypto.randomBytes(12).toString('hex')}`;
    const g = (
      await this.db.query<GiftRow>(
        `INSERT INTO gifts (tournament_id, org_id, order_id, sender_name, message, sticker, amount_inr, approved, device_hash, ip_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [t.id, t.org_id, orderId, name, message, JSON.stringify(sticker), amount.toFixed(2), !e.approval, device, ip],
      )
    ).rows[0];
    try {
      const o = await this.payments.createGiftOrder({
        orderId,
        amount,
        customerId: `gift_${device.slice(0, 20)}`,
        phone: s.payerPhone,
        returnUrl: `${this.base}/gift/${g.id}/done`,
        note: `${s.label} for ${t.name}`,
        tags: { kind: 'gift', tournament_id: t.id, org_id: t.org_id },
      });
      await this.db.query('UPDATE gifts SET session_id = $2 WHERE id = $1', [g.id, o.sessionId]);
    } catch (err) {
      await this.db.query("UPDATE gifts SET status = 'failed' WHERE id = $1", [g.id]);
      throw err;
    }
    return { gift: (await this.byId(g.id))!, checkoutUrl: `${this.base}/gift/${g.id}` };
  }

  /** Asks Cashfree for the order; on PAID fixes the split and shows the gift. Safe to repeat. */
  async confirm(g: GiftRow): Promise<GiftRow> {
    if (g.status !== 'created') return g;
    const order = await this.payments.getOrder(g.order_id);
    const st = order.order_status ?? '';
    if (st === 'PAID') {
      if (Math.round(Number(order.order_amount) * 100) !== Math.round(Number(g.amount_inr) * 100) || (order.order_currency && order.order_currency !== 'INR')) {
        throw new HttpError(409, 'amount_mismatch', 'The paid amount does not match the gift.');
      }
      const s = await this.forOrg(g.org_id);
      const sp = giftSplit(Number(g.amount_inr), s);
      const t = await this.repo.tournamentById(g.tournament_id);
      const e = t ? eventGifts(t, s) : null;
      const upd = await this.db.query<GiftRow>(
        `UPDATE gifts SET status = 'paid', paid_at = now(), payable_at = now() + make_interval(days => $2::int), gst_inr = $3, fee_inr = $4, share_inr = $5, tds_inr = $6, net_inr = $7, split = $8, in_video = $9
         WHERE id = $1 AND status = 'created' RETURNING *`,
        [g.id, s.holdDays, sp.gst, sp.fee, sp.share, sp.tds, sp.net, JSON.stringify(sp), Boolean(e?.inVideo)],
      );
      const paid = upd.rows[0];
      if (paid) this.eventChanged(paid.tournament_id);
      if (paid && paid.approved) await this.show(paid);
      return paid ?? (await this.byId(g.id))!;
    }
    if (st === 'EXPIRED' || st === 'TERMINATED') await this.db.query("UPDATE gifts SET status = 'expired' WHERE id = $1 AND status = 'created'", [g.id]);
    return (await this.byId(g.id))!;
  }

  /** Puts a paid, approved gift in chat (highlighted) and, when chosen, in the video. */
  private async show(g: GiftRow): Promise<void> {
    const amount = Number(g.amount_inr);
    const emoji = g.sticker?.emoji ?? '🎁';
    const row = await this.chat
      .add(g.tournament_id, {
        source: 'watch',
        author: g.sender_name,
        authorKey: `gift:${g.id}`,
        text: g.message || `sent ${g.sticker?.name && g.sticker.name !== 'Gift' ? g.sticker.name : 'a gift'}`,
        gift: { amount, emoji, name: g.sticker?.name ?? 'Gift' },
      })
      .catch(() => null);
    if (row) await this.db.query('UPDATE gifts SET chat_message_id = $2 WHERE id = $1', [g.id, row.id]);
    if (g.in_video) this.graphics.gift(g.tournament_id, { id: g.id, name: g.sender_name, amount, emoji, sticker: g.sticker?.name ?? 'Gift', message: g.message });
  }

  async moderate(g: GiftRow, v: { approve?: boolean; hidden?: boolean }): Promise<GiftRow> {
    this.eventChanged(g.tournament_id);
    if (v.approve && !g.approved) {
      const r = (await this.db.query<GiftRow>('UPDATE gifts SET approved = true WHERE id = $1 RETURNING *', [g.id])).rows[0];
      if (r.status === 'paid' && !r.hidden) await this.show(r);
      g = r;
    }
    if (typeof v.hidden === 'boolean' && v.hidden !== g.hidden) {
      g = (await this.db.query<GiftRow>('UPDATE gifts SET hidden = $2 WHERE id = $1 RETURNING *', [g.id, v.hidden])).rows[0];
      if (g.chat_message_id) {
        const m = await this.chat.byId(Number(g.chat_message_id));
        if (m) await this.chat.update(m, { hidden: v.hidden });
      }
      if (v.hidden) this.graphics.gift(g.tournament_id, { id: g.id, hide: true });
    }
    return g;
  }

  async forEvent(tid: string, limit = 200): Promise<GiftRow[]> {
    return (await this.db.query<GiftRow>("SELECT * FROM gifts WHERE tournament_id = $1 AND status IN ('paid', 'refunded') ORDER BY paid_at DESC LIMIT $2", [tid, limit])).rows;
  }

  // ---------------------------------------------------------------- money for the club
  async clubSummary(orgId: string) {
    const r = (
      await this.db.query<Record<string, string | null>>(
        `SELECT
           coalesce(sum(amount_inr), 0) AS gross, coalesce(sum(net_inr), 0) AS net,
           coalesce(sum(net_inr) FILTER (WHERE payout_id IS NULL AND payable_at <= now()), 0) AS payable,
           coalesce(sum(net_inr) FILTER (WHERE payout_id IS NULL AND payable_at > now()), 0) AS held,
           count(*) AS n
         FROM gifts WHERE org_id = $1 AND status = 'paid'`,
        [orgId],
      )
    ).rows[0];
    const paid = (await this.db.query<{ s: string | null }>("SELECT sum(net_inr) AS s FROM gift_payouts WHERE org_id = $1 AND status = 'paid'", [orgId])).rows[0];
    return { gifts: Number(r.n), gross: Number(r.gross), net: Number(r.net), payable: Number(r.payable), held: Number(r.held), paidOut: Number(paid.s ?? 0) };
  }

  async clubGifts(orgId: string, limit = 500) {
    return (
      await this.db.query<GiftRow & { event_name: string }>(
        "SELECT g.*, t.name AS event_name FROM gifts g JOIN tournaments t ON t.id = g.tournament_id WHERE g.org_id = $1 AND g.status IN ('paid', 'refunded') ORDER BY g.paid_at DESC LIMIT $2",
        [orgId, limit],
      )
    ).rows;
  }

  // ---------------------------------------------------------------- payouts (admin)
  /** Groups every payable gift (older than the hold) of ready clubs into a payout each. */
  async runPayouts(by: string): Promise<PayoutRow[]> {
    const s = await this.settings();
    const clubs = (
      await this.db.query<{ org_id: string; net: string }>(
        `SELECT g.org_id, sum(g.net_inr) AS net FROM gifts g JOIN payee_accounts p ON p.org_id = g.org_id AND p.status = 'verified'
          WHERE g.status = 'paid' AND g.payout_id IS NULL AND g.payable_at <= now() GROUP BY g.org_id`,
      )
    ).rows;
    const out: PayoutRow[] = [];
    for (const c of clubs) {
      if (Number(c.net) < s.minPayoutInr) continue;
      if (!(await this.signedAgreement(c.org_id))) continue;
      const row = await this.repo.tx(async (q: pg.PoolClient) => {
        const gifts = (
          await q.query<GiftRow>("SELECT * FROM gifts WHERE org_id = $1 AND status = 'paid' AND payout_id IS NULL AND payable_at <= now() FOR UPDATE", [c.org_id])
        ).rows;
        if (!gifts.length) return null;
        const sum = (k: keyof GiftRow) => r2(gifts.reduce((a, g) => a + Number(g[k] ?? 0), 0));
        const p = (
          await q.query<PayoutRow>(
            `INSERT INTO gift_payouts (org_id, gift_count, gross_inr, gst_inr, fee_inr, share_inr, tds_inr, net_inr, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [c.org_id, gifts.length, sum('amount_inr'), sum('gst_inr'), sum('fee_inr'), sum('share_inr'), sum('tds_inr'), sum('net_inr'), by],
          )
        ).rows[0];
        await q.query('UPDATE gifts SET payout_id = $2 WHERE id = ANY($1::uuid[])', [gifts.map((g) => g.id), p.id]);
        return p;
      });
      if (row) out.push(row);
    }
    return out;
  }

  async payouts(where: { orgId?: string; status?: string } = {}, limit = 200): Promise<PayoutRow[]> {
    const cond: string[] = [];
    const vals: unknown[] = [];
    if (where.orgId) cond.push(`p.org_id = $${vals.push(where.orgId)}`);
    if (where.status) cond.push(`p.status = $${vals.push(where.status)}`);
    vals.push(limit);
    return (
      await this.db.query<PayoutRow>(
        `SELECT p.*, o.name AS org_name FROM gift_payouts p JOIN orgs o ON o.id = p.org_id ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY p.created_at DESC LIMIT $${vals.length}`,
        vals,
      )
    ).rows;
  }

  async payoutById(id: string): Promise<PayoutRow | null> {
    return (await this.db.query<PayoutRow>('SELECT p.*, o.name AS org_name FROM gift_payouts p JOIN orgs o ON o.id = p.org_id WHERE p.id = $1', [id])).rows[0] ?? null;
  }

  async markPaid(id: string, utr: string, by: string): Promise<PayoutRow> {
    const r = await this.db.query<PayoutRow>("UPDATE gift_payouts SET status = 'paid', utr = $2, paid_by = $3, paid_at = now() WHERE id = $1 AND status = 'due' RETURNING *", [id, utr.trim().slice(0, 40), by]);
    if (!r.rows[0]) throw new HttpError(409, 'payout_not_due', 'Only a payout that is due can be marked paid.');
    const p = r.rows[0];
    const payee = await this.payee(p.org_id);
    const s = await this.settings();
    if (payee)
      await this.mailer.send({
        to: payee.email,
        subject: `${s.label} payout sent: ₹${Number(p.net_inr).toLocaleString('en-IN')}`,
        body: [
          `We sent ₹${Number(p.net_inr).toLocaleString('en-IN')} to your account ending ${payee.account_last4} (bank reference ${p.utr}).`,
          `${p.gift_count} gifts, ₹${Number(p.gross_inr).toLocaleString('en-IN')} in total: GST ₹${Number(p.gst_inr)}, gateway fees ₹${Number(p.fee_inr)}, Go Live share ₹${Number(p.share_inr)}, TDS ₹${Number(p.tds_inr)}.`,
          'The full statement is in Club > Gifts & payouts.',
        ],
        kind: 'gift_payout',
        ref: p.id,
        orgId: p.org_id,
      });
    return p;
  }

  async cancelPayout(id: string): Promise<void> {
    await this.repo.tx(async (q) => {
      const r = await q.query("UPDATE gift_payouts SET status = 'cancelled' WHERE id = $1 AND status = 'due' RETURNING id", [id]);
      if (!r.rows[0]) throw new HttpError(409, 'payout_not_due', 'Only a payout that is due can be cancelled.');
      await q.query('UPDATE gifts SET payout_id = NULL WHERE payout_id = $1', [id]);
    });
  }

  async payoutGifts(id: string) {
    return (
      await this.db.query<GiftRow & { event_name: string }>('SELECT g.*, t.name AS event_name FROM gifts g JOIN tournaments t ON t.id = g.tournament_id WHERE g.payout_id = $1 ORDER BY g.paid_at', [id])
    ).rows;
  }

  /** A gift refunded outside (Cashfree dashboard) before it was paid out. */
  async markRefunded(g: GiftRow): Promise<GiftRow> {
    if (g.status !== 'paid') throw new HttpError(409, 'not_paid', 'Only a paid gift can be marked refunded.');
    if (g.payout_id) throw new HttpError(409, 'paid_out', 'This gift is in a payout already. Cancel the payout first (if it is not paid yet).');
    const r = (await this.db.query<GiftRow>("UPDATE gifts SET status = 'refunded', hidden = true WHERE id = $1 RETURNING *", [g.id])).rows[0];
    this.eventChanged(g.tournament_id);
    if (g.chat_message_id) {
      const m = await this.chat.byId(Number(g.chat_message_id));
      if (m) await this.chat.update(m, { hidden: true });
    }
    return r;
  }
}
