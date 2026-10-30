import type pg from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Repo, TournamentRow } from './repo.js';
import { HttpError } from './errors.js';

/**
 * Billing rules (set in /admin, overridable per club):
 *  - Each tournament gets `freeCameras` camera slots; more are bought per tournament.
 *  - Each tournament gets `freeMinutes` of live time (Go live → End); after that every
 *    started minute costs `minutePrice` credits, paid from the club's wallet.
 *  - When the wallet cannot pay the next minute the broadcast keeps running for
 *    `graceMinutes`, with warnings, then ends. Grace minutes are charged only if the
 *    club adds credits before the stream ends.
 * Credits are stored in hundredths (cc) so fractional prices are exact.
 */
export const pricingSchema = z.object({
  freeCameras: z.number().int().min(0).max(100),
  freeMinutes: z.number().int().min(0).max(100_000),
  cameraPrice: z.number().min(0).max(1_000_000),
  minutePrice: z.number().min(0).max(1_000_000),
  graceMinutes: z.number().int().min(0).max(120),
  // Destinations (YouTube channels, Facebook, Instagram, other stream keys) included per event,
  // and the price of each extra one, bought per event.
  freeDestinations: z.number().int().min(0).max(100).default(1),
  destinationPrice: z.number().min(0).max(1_000_000).default(50),
  // Influencers & games add-on (viewership engine), bought per event; SMS messages included,
  // then a price per message.
  viewershipPrice: z.number().min(0).max(1_000_000).default(500),
  viewershipMessages: z.number().int().min(0).max(1_000_000).default(500),
  messagePrice: z.number().min(0).max(1_000).default(1),
});
export type Pricing = z.infer<typeof pricingSchema>;

export const DEFAULT_PRICING: Pricing = {
  freeCameras: 2,
  freeMinutes: 10,
  cameraPrice: 100,
  minutePrice: 5,
  graceMinutes: 5,
  freeDestinations: 1,
  destinationPrice: 50,
  viewershipPrice: 500,
  viewershipMessages: 500,
  messagePrice: 1,
};

export const packSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9_-]{1,32}$/i, 'pack id: letters, numbers, - or _'),
  label: z.string().trim().min(1).max(60),
  priceInr: z.number().min(1).max(10_000_000),
  credits: z.number().min(0.01).max(100_000_000),
});
export type CreditPack = z.infer<typeof packSchema>;

export const DEFAULT_PACKS: CreditPack[] = [
  { id: 'starter', label: 'Starter', priceInr: 500, credits: 500 },
  { id: 'club', label: 'Club', priceInr: 1000, credits: 1050 },
  { id: 'season', label: 'Season', priceInr: 5000, credits: 5500 },
];

/** Minutes left at which the director is warned (once each, again after a top-up). */
export const WARN_AT_MINUTES = [10, 2];

export const toCc = (credits: number) => Math.round(credits * 100);
export const fromCc = (cc: number | string | bigint) => Number(cc) / 100;

export interface OrgBillingRow {
  org_id: string;
  balance_cc: string;
  overrides: Partial<Pricing>;
  suspended: boolean;
  suspended_reason: string | null;
  billing_name: string | null;
  billing_phone: string | null;
  billing_email: string | null;
  gstin: string | null;
}

export interface WalletTxRow {
  id: string;
  org_id: string;
  kind: 'purchase' | 'cameras' | 'minutes' | 'admin' | 'refund' | 'destinations' | 'viewership' | 'messages';
  amount_cc: string;
  quantity: number | null;
  tournament_id: string | null;
  tournament_name?: string | null;
  ref: string | null;
  note: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export function txDto(r: WalletTxRow) {
  return {
    id: Number(r.id),
    kind: r.kind,
    credits: fromCc(r.amount_cc),
    quantity: r.quantity,
    tournamentId: r.tournament_id,
    tournamentName: r.tournament_name ?? null,
    note: r.note,
    by: r.created_by,
    at: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface TournamentBilling {
  enabled: boolean;
  suspended: boolean;
  suspendedReason: string | null;
  balance: number;
  pricing: Pricing;
  cameras: { free: number; extra: number; limit: number; used: number; price: number };
  /** Places the show is streamed to (main platforms + extra destinations). */
  destinations: { free: number; extra: number; limit: number; used: number; price: number };
  minutes: {
    free: number;
    liveSeconds: number;
    billed: number;
    price: number;
    freeSecondsLeft: number;
    /** Seconds of live time left before the grace period: null = unlimited (free pricing). */
    remainingSeconds: number | null;
  };
  grace: { active: boolean; secondsLeft: number | null };
  canGoLive: boolean;
  reason: string | null;
}

type Q = Repo['db'] | pg.PoolClient;

interface Meter {
  lastTick: number;
  carryMs: number;
  warned: Set<number>;
  inGrace: boolean;
  stopRequestedAt: number;
}

export interface BillingHooks {
  /** Which tournaments are live right now (OBS streaming). */
  streaming: () => string[];
  alert: (tournamentId: string, level: 'info' | 'warning' | 'error', message: string) => void;
  /** Ends the broadcast (credits finished, or club suspended). */
  stop: (tournamentId: string, reason: string) => void;
  changed: (tournamentId: string, state: TournamentBilling) => void;
}

export class BillingService {
  private meters = new Map<string, Meter>();
  private timer: NodeJS.Timeout | null = null;
  hooks: BillingHooks | null = null;
  /** How many destinations an event streams to (set by the app wiring: OutputsService.destinationCount). */
  destinationCounter: ((t: TournamentRow) => Promise<number>) | null = null;

  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.config.BILLING_ENABLED;
  }

  start(): void {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), this.config.BILLING_TICK_MS);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ------------------------------------------------------------------ settings
  async settings(): Promise<{ pricing: Pricing; packs: CreditPack[] }> {
    const r = (await this.repo.db.query<{ pricing: Partial<Pricing>; packs: CreditPack[] }>('SELECT pricing, packs FROM platform_settings WHERE id')).rows[0];
    const pricing = { ...DEFAULT_PRICING, ...(r?.pricing ?? {}) };
    const packs = r && Array.isArray(r.packs) && r.packs.length ? r.packs : DEFAULT_PACKS;
    return { pricing, packs };
  }

  async saveSettings(v: { pricing?: Pricing; packs?: CreditPack[] }, by: string): Promise<void> {
    const cur = await this.settings();
    const packs = v.packs ?? cur.packs;
    if (new Set(packs.map((p) => p.id)).size !== packs.length) throw new HttpError(400, 'duplicate_pack', 'Each credit pack needs a different id.');
    await this.repo.db.query('UPDATE platform_settings SET pricing = $1, packs = $2, updated_by = $3, updated_at = now() WHERE id', [
      JSON.stringify(v.pricing ?? cur.pricing),
      JSON.stringify(packs),
      by,
    ]);
  }

  // ------------------------------------------------------------------ wallet
  async orgBilling(orgId: string, q: Q = this.repo.db): Promise<OrgBillingRow> {
    await q.query('INSERT INTO org_billing (org_id) VALUES ($1) ON CONFLICT DO NOTHING', [orgId]);
    return (await q.query<OrgBillingRow>('SELECT * FROM org_billing WHERE org_id = $1', [orgId])).rows[0];
  }

  async pricingFor(orgId: string, row?: OrgBillingRow): Promise<Pricing> {
    const [{ pricing }, b] = await Promise.all([this.settings(), row ? Promise.resolve(row) : this.orgBilling(orgId)]);
    const o = pricingSchema.partial().safeParse(b.overrides ?? {});
    return { ...pricing, ...(o.success ? o.data : {}) };
  }

  async updateOrgBilling(
    orgId: string,
    v: { overrides?: Partial<Pricing>; suspended?: boolean; suspendedReason?: string | null; name?: string | null; phone?: string | null; email?: string | null; gstin?: string | null },
  ): Promise<OrgBillingRow> {
    await this.orgBilling(orgId);
    const sets: string[] = [];
    const vals: unknown[] = [orgId];
    const add = (col: string, val: unknown) => {
      vals.push(val);
      sets.push(`${col} = $${vals.length}`);
    };
    if (v.overrides !== undefined) add('overrides', JSON.stringify(v.overrides));
    if (v.suspended !== undefined) add('suspended', v.suspended);
    if (v.suspendedReason !== undefined) add('suspended_reason', v.suspendedReason);
    if (v.name !== undefined) add('billing_name', v.name);
    if (v.phone !== undefined) add('billing_phone', v.phone);
    if (v.email !== undefined) add('billing_email', v.email);
    if (v.gstin !== undefined) add('gstin', v.gstin);
    if (sets.length) await this.repo.db.query(`UPDATE org_billing SET ${sets.join(', ')}, updated_at = now() WHERE org_id = $1`, vals);
    return this.orgBilling(orgId);
  }

  /** Takes credits if the wallet has enough; returns the new balance, or null. */
  private async debit(
    c: pg.PoolClient,
    orgId: string,
    cc: number,
    tx: { kind: WalletTxRow['kind']; quantity?: number | null; tournamentId?: string | null; ref?: string | null; note?: string | null; by?: string | null },
  ): Promise<number | null> {
    await this.orgBilling(orgId, c);
    const r = await c.query<{ balance_cc: string }>(
      'UPDATE org_billing SET balance_cc = balance_cc - $2, updated_at = now() WHERE org_id = $1 AND balance_cc >= $2 RETURNING balance_cc',
      [orgId, cc],
    );
    if (!r.rows[0]) return null;
    await c.query(
      `INSERT INTO wallet_tx (org_id, kind, amount_cc, quantity, tournament_id, ref, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (kind, ref) WHERE ref IS NOT NULL DO UPDATE
         SET amount_cc = wallet_tx.amount_cc + EXCLUDED.amount_cc, quantity = COALESCE(wallet_tx.quantity, 0) + COALESCE(EXCLUDED.quantity, 0), updated_at = now()`,
      [orgId, tx.kind, -cc, tx.quantity ?? null, tx.tournamentId ?? null, tx.ref ?? null, tx.note ?? null, tx.by ?? null],
    );
    return Number(r.rows[0].balance_cc);
  }

  /**
   * Adds credits once per `ref` (a payment order id), so a webhook and the return page
   * crediting the same payment cannot double-count. Returns false if already credited.
   */
  async credit(orgId: string, cc: number, tx: { kind: 'purchase' | 'refund' | 'admin'; ref?: string | null; note?: string | null; by?: string | null }, q?: pg.PoolClient): Promise<boolean> {
    const run = async (c: pg.PoolClient) => {
      await this.orgBilling(orgId, c);
      const ins = await c.query(
        `INSERT INTO wallet_tx (org_id, kind, amount_cc, ref, note, created_by) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (kind, ref) WHERE ref IS NOT NULL DO NOTHING RETURNING id`,
        [orgId, tx.kind, cc, tx.ref ?? null, tx.note ?? null, tx.by ?? null],
      );
      if (!ins.rows[0]) return false;
      await c.query('UPDATE org_billing SET balance_cc = balance_cc + $2, updated_at = now() WHERE org_id = $1', [orgId, cc]);
      return true;
    };
    const ok = q ? await run(q) : await this.repo.tx(run);
    if (ok) await this.walletChanged(orgId);
    return ok;
  }

  /** Takes credits back for a refund (only if the wallet has them). Returns false if not enough. */
  async takeBack(c: pg.PoolClient, orgId: string, cc: number, tx: { ref: string; note: string; by: string }): Promise<boolean> {
    return (await this.debit(c, orgId, cc, { kind: 'refund', ref: tx.ref, note: tx.note, by: tx.by })) !== null;
  }

  async walletChangedPublic(orgId: string): Promise<void> {
    await this.walletChanged(orgId);
  }

  /** CoGolfers staff add (or remove, negative) credits by hand. */
  async adminAdjust(orgId: string, credits: number, note: string, by: string): Promise<number> {
    const cc = toCc(credits);
    if (cc === 0) throw new HttpError(400, 'zero_amount', 'Enter an amount other than zero.');
    const balance = await this.repo.tx(async (c) => {
      const b = await this.orgBilling(orgId, c);
      if (Number(b.balance_cc) + cc < 0) throw new HttpError(409, 'balance_too_low', `The club only has ${fromCc(b.balance_cc)} credits.`);
      const r = await c.query<{ balance_cc: string }>('UPDATE org_billing SET balance_cc = balance_cc + $2, updated_at = now() WHERE org_id = $1 RETURNING balance_cc', [orgId, cc]);
      await c.query('INSERT INTO wallet_tx (org_id, kind, amount_cc, note, created_by) VALUES ($1, $2, $3, $4, $5)', [orgId, 'admin', cc, note, by]);
      return Number(r.rows[0].balance_cc);
    });
    await this.walletChanged(orgId);
    return fromCc(balance);
  }

  async transactions(orgId: string, limit = 50): Promise<WalletTxRow[]> {
    return (
      await this.repo.db.query<WalletTxRow>(
        `SELECT w.*, t.name AS tournament_name FROM wallet_tx w LEFT JOIN tournaments t ON t.id = w.tournament_id
         WHERE w.org_id = $1 ORDER BY w.created_at DESC, w.id DESC LIMIT $2`,
        [orgId, limit],
      )
    ).rows;
  }

  // ------------------------------------------------------------------ cameras
  async cameraLimit(t: TournamentRow): Promise<number | null> {
    if (!this.enabled) return null;
    const p = await this.pricingFor(t.org_id);
    return p.freeCameras + (t.extra_cameras ?? 0);
  }

  /** Buys extra camera slots for one tournament from the club's wallet. */
  async buyCameras(t: TournamentRow, count: number, by: string): Promise<TournamentBilling> {
    if (!this.enabled) throw new HttpError(409, 'billing_off', 'Camera limits are not used on this server.');
    const b = await this.orgBilling(t.org_id);
    if (b.suspended) throw new HttpError(403, 'club_suspended', suspendedText(b));
    const p = await this.pricingFor(t.org_id, b);
    const cc = toCc(p.cameraPrice) * count;
    await this.repo.tx(async (c) => {
      if (cc > 0) {
        const left = await this.debit(c, t.org_id, cc, { kind: 'cameras', quantity: count, tournamentId: t.id, note: `${count} extra camera${count > 1 ? 's' : ''}`, by });
        if (left === null) {
          throw new HttpError(402, 'insufficient_credits', `${count} extra camera${count > 1 ? 's cost' : ' costs'} ${fromCc(cc)} credits; the club has ${fromCc(b.balance_cc)}. Buy credits first.`);
        }
      }
      await c.query('UPDATE tournaments SET extra_cameras = extra_cameras + $2 WHERE id = $1', [t.id, count]);
    });
    await this.walletChanged(t.org_id);
    const fresh = (await this.repo.tournamentById(t.id))!;
    return this.tournamentState(fresh);
  }

  // ------------------------------------------------------------------ destinations
  /** Destinations included in this event: null = no limit (billing off). */
  async destinationLimit(t: TournamentRow): Promise<{ limit: number; price: number } | null> {
    if (!this.enabled) return null;
    const p = await this.pricingFor(t.org_id);
    return { limit: p.freeDestinations + (t.extra_destinations ?? 0), price: p.destinationPrice };
  }

  /** Buys extra destinations for one event from the club's wallet. */
  async buyDestinations(t: TournamentRow, count: number, by: string): Promise<TournamentBilling> {
    if (!this.enabled) throw new HttpError(409, 'billing_off', 'Destination limits are not used on this server.');
    const b = await this.orgBilling(t.org_id);
    if (b.suspended) throw new HttpError(403, 'club_suspended', suspendedText(b));
    const p = await this.pricingFor(t.org_id, b);
    const cc = toCc(p.destinationPrice) * count;
    await this.repo.tx(async (c) => {
      if (cc > 0) {
        const left = await this.debit(c, t.org_id, cc, {
          kind: 'destinations',
          quantity: count,
          tournamentId: t.id,
          note: `${count} extra destination${count > 1 ? 's' : ''}`,
          by,
        });
        if (left === null) {
          throw new HttpError(402, 'insufficient_credits', `${count} extra destination${count > 1 ? 's cost' : ' costs'} ${fromCc(cc)} credits; the club has ${fromCc(b.balance_cc)}. Buy credits first.`);
        }
      }
      await c.query('UPDATE tournaments SET extra_destinations = extra_destinations + $2 WHERE id = $1', [t.id, count]);
    });
    await this.walletChanged(t.org_id);
    const fresh = (await this.repo.tournamentById(t.id))!;
    return this.tournamentState(fresh);
  }

  // ------------------------------------------------------------------ influencers & games add-on
  /** Is the add-on on for this event? Always on when billing is off on this server. */
  viewershipOn(t: TournamentRow): boolean {
    return !this.enabled || Boolean(t.viewership_on_at);
  }

  requireViewership(t: TournamentRow): void {
    if (!this.viewershipOn(t)) {
      throw new HttpError(402, 'viewership_addon', 'Turn on Influencers & games for this event first (Studio, or the event screen).');
    }
  }

  async viewershipState(t: TournamentRow, messagesUsed: number) {
    const b = await this.orgBilling(t.org_id);
    const p = await this.pricingFor(t.org_id, b);
    return {
      required: this.enabled,
      on: this.viewershipOn(t),
      price: p.viewershipPrice,
      messagesIncluded: p.viewershipMessages,
      messagesUsed,
      messagePrice: p.messagePrice,
      balance: fromCc(b.balance_cc),
    };
  }

  /** Buys the add-on for one event (credits from the club's wallet). */
  async buyViewership(t: TournamentRow, by: string): Promise<void> {
    if (!this.enabled) return;
    if (t.viewership_on_at) return;
    const b = await this.orgBilling(t.org_id);
    if (b.suspended) throw new HttpError(403, 'club_suspended', suspendedText(b));
    const p = await this.pricingFor(t.org_id, b);
    const cc = toCc(p.viewershipPrice);
    await this.repo.tx(async (c) => {
      const r = await c.query('UPDATE tournaments SET viewership_on_at = now() WHERE id = $1 AND viewership_on_at IS NULL', [t.id]);
      if (!r.rowCount || cc <= 0) return;
      const left = await this.debit(c, t.org_id, cc, { kind: 'viewership', quantity: 1, tournamentId: t.id, note: 'Influencers & games', by });
      if (left === null) {
        throw new HttpError(402, 'insufficient_credits', `Influencers & games costs ${fromCc(cc)} credits; the club has ${fromCc(b.balance_cc)}. Buy credits first.`);
      }
    });
    await this.walletChanged(t.org_id);
  }

  /**
   * How many of `n` new messages may go out: the included ones, then as many as the wallet pays
   * for (charged here). One-time codes for prize claims always go out, paid if the wallet can.
   */
  async allowMessages(tournamentId: string, n: number, alreadySent: number, critical: boolean): Promise<number> {
    if (!this.enabled || n <= 0) return n;
    const t = await this.repo.tournamentById(tournamentId);
    if (!t) return 0;
    const b = await this.orgBilling(t.org_id);
    const p = await this.pricingFor(t.org_id, b);
    const free = Math.max(0, p.viewershipMessages - alreadySent);
    const paid = Math.max(0, n - free);
    if (!paid || p.messagePrice <= 0) return n;
    const unit = toCc(p.messagePrice);
    const affordable = Math.min(paid, Math.floor(Number(b.balance_cc) / unit));
    if (affordable > 0) {
      await this.repo.tx(async (c) =>
        this.debit(c, t.org_id, affordable * unit, { kind: 'messages', quantity: affordable, tournamentId: t.id, ref: `msg:${t.id}`, note: 'SMS messages', by: 'system' }),
      );
      await this.walletChanged(t.org_id);
    }
    return critical ? n : Math.min(n, free + affordable);
  }

  // ------------------------------------------------------------------ live minutes
  async tournamentState(t: TournamentRow, row?: OrgBillingRow): Promise<TournamentBilling> {
    const b = row ?? (await this.orgBilling(t.org_id));
    const p = await this.pricingFor(t.org_id, b);
    const used = Number((await this.repo.db.query<{ n: string }>('SELECT count(*)::text AS n FROM cameras WHERE tournament_id = $1', [t.id])).rows[0].n);
    const balanceCc = Number(b.balance_cc);
    const freeSec = p.freeMinutes * 60;
    const live = t.live_seconds ?? 0;
    const billed = t.billed_minutes ?? 0;
    const freeLeft = Math.max(0, freeSec - live);
    let remaining: number | null = null;
    if (this.enabled && p.minutePrice > 0) {
      const prepaid = Math.max(0, billed * 60 - Math.max(0, live - freeSec));
      remaining = freeLeft + prepaid + Math.floor(balanceCc / toCc(p.minutePrice)) * 60;
    }
    const destUsed = this.destinationCounter ? await this.destinationCounter(t) : 0;
    const destLimit = p.freeDestinations + (t.extra_destinations ?? 0);
    const graceLeft = this.meters.get(t.id)?.inGrace ? Math.max(0, p.graceMinutes * 60 - (t.grace_seconds ?? 0)) : null;
    let reason: string | null = null;
    if (this.enabled && b.suspended) reason = suspendedText(b);
    else if (destUsed > destLimit) {
      const more = destUsed - destLimit;
      reason = `This event streams to ${destUsed} destinations and includes ${destLimit}. Add ${more} more (${p.destinationPrice} credits each) or switch ${more === 1 ? 'one' : 'some'} off.`;
    } else if (remaining !== null && remaining <= 0) reason = `No live minutes left: the free ${p.freeMinutes} minutes are used and the club has ${fromCc(balanceCc)} credits (${p.minutePrice} per minute). Buy credits to go live.`;
    return {
      enabled: this.enabled,
      suspended: b.suspended,
      suspendedReason: b.suspended_reason,
      balance: fromCc(balanceCc),
      pricing: p,
      cameras: { free: p.freeCameras, extra: t.extra_cameras ?? 0, limit: p.freeCameras + (t.extra_cameras ?? 0), used, price: p.cameraPrice },
      destinations: { free: p.freeDestinations, extra: t.extra_destinations ?? 0, limit: destLimit, used: destUsed, price: p.destinationPrice },
      minutes: { free: p.freeMinutes, liveSeconds: live, billed, price: p.minutePrice, freeSecondsLeft: freeLeft, remainingSeconds: remaining },
      grace: { active: graceLeft !== null, secondsLeft: graceLeft },
      canGoLive: !this.enabled || reason === null,
      reason: this.enabled ? reason : null,
    };
  }

  /** Before "Go live" and "Start cloud engine". */
  async checkGoLive(t: TournamentRow): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.enabled) return { ok: true };
    const s = await this.tournamentState(t);
    return s.canGoLive ? { ok: true } : { ok: false, error: s.reason ?? 'Billing does not allow going live.' };
  }

  async checkNotSuspended(orgId: string): Promise<void> {
    if (!this.enabled) return;
    const b = await this.orgBilling(orgId);
    if (b.suspended) throw new HttpError(403, 'club_suspended', suspendedText(b));
  }

  /** One metering pass: called every BILLING_TICK_MS (and directly by tests). */
  async tick(): Promise<void> {
    if (!this.enabled || !this.hooks) return;
    const now = this.now();
    const live = new Set(this.hooks.streaming());
    for (const tid of [...this.meters.keys()]) if (!live.has(tid)) await this.sessionEnded(tid);
    for (const tid of live) {
      const t = await this.repo.tournamentById(tid);
      if (!t) continue;
      let m = this.meters.get(tid);
      if (!m) {
        m = { lastTick: now, carryMs: 0, warned: new Set(), inGrace: false, stopRequestedAt: 0 };
        this.meters.set(tid, m);
        await this.repo.db.query('UPDATE tournaments SET live_session_at = COALESCE(live_session_at, now()), grace_seconds = 0 WHERE id = $1', [tid]);
        continue;
      }
      // Cap one step at 30 s: a stalled server does not bill for time it did not see.
      const ms = Math.min(now - m.lastTick, 30_000) + m.carryMs;
      m.lastTick = now;
      const sec = Math.floor(ms / 1000);
      m.carryMs = ms - sec * 1000;
      await this.meter(t, m, sec);
    }
  }

  private async meter(t0: TournamentRow, m: Meter, sec: number): Promise<void> {
    const b = await this.orgBilling(t0.org_id);
    const hooks = this.hooks!;
    if (b.suspended) {
      this.requestStop(t0.id, m, `This club's account is suspended by CoGolfers. The broadcast has been ended.${b.suspended_reason ? ` Reason: ${b.suspended_reason}` : ''}`);
      return;
    }
    const p = await this.pricingFor(t0.org_id, b);
    const t = (
      await this.repo.db.query<TournamentRow>(
        `UPDATE tournaments SET live_seconds = live_seconds + $2, grace_seconds = grace_seconds + CASE WHEN $3 THEN $2 ELSE 0 END WHERE id = $1 RETURNING *`,
        [t0.id, sec, m.inGrace],
      )
    ).rows[0];
    // Daily usage (India time) for the cost and usage reports.
    await this.repo.db
      .query(
        `INSERT INTO usage_daily (day, tournament_id, org_id, mode, live_seconds, camera_seconds)
         VALUES ((now() AT TIME ZONE 'Asia/Kolkata')::date, $1, $2, $3, $4, $4 * (SELECT count(*) FROM cameras WHERE tournament_id = $1))
         ON CONFLICT (day, tournament_id) DO UPDATE SET live_seconds = usage_daily.live_seconds + EXCLUDED.live_seconds,
           camera_seconds = usage_daily.camera_seconds + EXCLUDED.camera_seconds, mode = EXCLUDED.mode`,
        [t.id, t.org_id, t.production_mode, sec],
      )
      .catch(() => {});
    const freeSec = p.freeMinutes * 60;
    const due = Math.ceil(Math.max(0, t.live_seconds - freeSec) / 60) - t.billed_minutes;
    if (due > 0) {
      if (p.minutePrice <= 0) {
        await this.repo.db.query('UPDATE tournaments SET billed_minutes = billed_minutes + $2 WHERE id = $1', [t.id, due]);
      } else {
        const cc = toCc(p.minutePrice) * due;
        const paid = await this.repo.tx(async (c) => {
          const left = await this.debit(c, t.org_id, cc, {
            kind: 'minutes',
            quantity: due,
            tournamentId: t.id,
            ref: `minutes:${t.id}:${(t.live_session_at ?? new Date()).toISOString()}`,
            note: 'Live minutes',
            by: 'system',
          });
          if (left === null) return false;
          await c.query('UPDATE tournaments SET billed_minutes = billed_minutes + $2, grace_seconds = 0 WHERE id = $1', [t.id, due]);
          return true;
        });
        if (paid) {
          if (m.inGrace) {
            m.inGrace = false;
            hooks.alert(t.id, 'info', 'Credits added. The broadcast continues.');
          }
          await this.walletChanged(t.org_id, t.id);
        } else if (!m.inGrace) {
          m.inGrace = true;
          await this.repo.db.query('UPDATE tournaments SET grace_seconds = 0 WHERE id = $1', [t.id]);
          hooks.alert(
            t.id,
            'error',
            p.graceMinutes > 0
              ? `Credits finished. The broadcast will end in ${p.graceMinutes} minutes unless the club buys credits.`
              : 'Credits finished. The broadcast is ending.',
          );
        }
      }
    }
    const fresh = (await this.repo.tournamentById(t.id))!;
    if (m.inGrace && fresh.grace_seconds >= p.graceMinutes * 60) {
      this.requestStop(t.id, m, 'Credits finished and the grace period is over. The broadcast has been ended. Buy credits to go live again.');
    }
    const state = await this.tournamentState(fresh); // balance after this tick's charge
    this.warn(t.id, m, state);
    hooks.changed(t.id, state);
  }

  private warn(tid: string, m: Meter, s: TournamentBilling): void {
    const rem = s.minutes.remainingSeconds;
    if (rem === null) return;
    for (const w of WARN_AT_MINUTES) {
      if (rem > (w + 1) * 60) m.warned.delete(w);
      else if (rem <= w * 60 && rem > 0 && !m.warned.has(w)) {
        // Mark every larger threshold too, so a late start does not fire two warnings at once.
        for (const x of WARN_AT_MINUTES) if (x >= w) m.warned.add(x);
        this.hooks!.alert(tid, 'warning', `About ${Math.max(1, Math.round(rem / 60))} minute${rem >= 90 ? 's' : ''} of live time left. Buy credits to keep the broadcast going.`);
      }
    }
  }

  private requestStop(tid: string, m: Meter, message: string): void {
    const now = this.now();
    if (now - m.stopRequestedAt < 60_000) return;
    m.stopRequestedAt = now;
    this.hooks!.alert(tid, 'error', message);
    this.hooks!.stop(tid, message);
  }

  /**
   * The broadcast stopped: close the session. Minutes are charged per started minute per
   * broadcast, so the unused part of the last paid minute is not carried into the next
   * one, and unpaid grace time is written off rather than taken later.
   */
  private async sessionEnded(tid: string): Promise<void> {
    this.meters.delete(tid);
    const t = await this.repo.tournamentById(tid);
    if (!t) return;
    const p = await this.pricingFor(t.org_id);
    const freeSec = p.freeMinutes * 60;
    const owed = Math.ceil(Math.max(0, t.live_seconds - freeSec) / 60);
    const billed = Math.max(t.billed_minutes, owed);
    const live = t.live_seconds > freeSec ? Math.max(t.live_seconds, freeSec + billed * 60) : t.live_seconds;
    await this.repo.db.query('UPDATE tournaments SET live_session_at = NULL, grace_seconds = 0, billed_minutes = $2, live_seconds = $3 WHERE id = $1', [tid, billed, live]);
    const fresh = await this.repo.tournamentById(tid);
    if (fresh) this.hooks?.changed(tid, await this.tournamentState(fresh));
  }

  private async walletChanged(orgId: string, skip?: string): Promise<void> {
    if (!this.hooks) return;
    // Live tournaments of this club show the new balance immediately.
    for (const tid of this.hooks.streaming()) {
      if (tid === skip) continue;
      const t = await this.repo.tournamentById(tid);
      if (t && t.org_id === orgId) this.hooks.changed(tid, await this.tournamentState(t));
    }
  }
}

export function suspendedText(b: OrgBillingRow): string {
  return `This club's account is suspended by CoGolfers${b.suspended_reason ? `: ${b.suspended_reason}` : ''}. Contact CoGolfers support.`;
}
