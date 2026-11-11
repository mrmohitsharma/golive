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
 *  - Viewers: every viewer-minute while live costs `viewerMinutePrice` (X) credits, on top
 *    of live minutes. Counted from the watch page and embeds (each viewer's real seconds) plus
 *    YouTube and Facebook (their "watching now" count, every minute). A new club gets
 *    `welcomeViewerMinutes` free once, usable on any events. Within one event, viewer-minutes
 *    past `viewerTier2From` cost `viewerTier2Pct`% of X and past `viewerTier3From`
 *    `viewerTier3Pct`% (0 = no tier). Unpaid viewer-minutes follow the same grace rules.
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
  // Viewer-minutes (X credits per viewer per minute), with up to 3 tiers per event.
  viewerMinutePrice: z.number().min(0).max(1).default(0.01),
  viewerTier2From: z.number().int().min(0).max(100_000_000).default(10_000),
  viewerTier2Pct: z.number().min(1).max(100).default(80),
  viewerTier3From: z.number().int().min(0).max(100_000_000).default(50_000),
  viewerTier3Pct: z.number().min(1).max(100).default(60),
  /** V8: own logo on the watch page + logo watermark in the video, per event; the ticker, per event. */
  brandingPrice: z.number().min(0).max(1_000_000).default(100),
  tickerPrice: z.number().min(0).max(1_000_000).default(0),
  /** Free viewer-minutes a new club gets once, for any events. */
  welcomeViewerMinutes: z.number().int().min(0).max(10_000_000).default(100),
  /**
   * V9 simple pricing. Per minute while live, for each camera sending video beyond `freeCameras`
   * and each destination beyond `freeDestinations` (0 = off; then the slots above are used).
   * With a per-minute price there is no slot to buy: switch it on and it is charged while live.
   */
  cameraMinutePrice: z.number().min(0).max(10_000).default(0),
  destinationMinutePrice: z.number().min(0).max(10_000).default(0),
  /** Charge YouTube / Facebook viewers too (they cost us nothing). Off = only our watch page. */
  chargeSocialViewers: z.boolean().default(true),
  /** Credits a new club gets once, in its wallet. */
  welcomeCredits: z.number().min(0).max(1_000_000).default(0),
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
  viewerMinutePrice: 0.01,
  viewerTier2From: 10_000,
  viewerTier2Pct: 80,
  viewerTier3From: 50_000,
  viewerTier3Pct: 60,
  welcomeViewerMinutes: 100,
  brandingPrice: 100,
  tickerPrice: 0,
  cameraMinutePrice: 0,
  destinationMinutePrice: 0,
  chargeSocialViewers: true,
  welcomeCredits: 0,
};

/**
 * V9 "simple plan" (Admin > Pricing > Use the simple plan): one live rate, extras per minute
 * while switched on, viewers on our watch page only, one-off add-ons, welcome credits.
 * Aimed at about 4–5× our running cost (see docs/PRICING.md).
 */
export const SIMPLE_PLAN: Pricing = {
  freeCameras: 2,
  freeMinutes: 0,
  cameraPrice: 0,
  minutePrice: 6,
  graceMinutes: 5,
  freeDestinations: 1,
  destinationPrice: 0,
  viewershipPrice: 499,
  viewershipMessages: 500,
  messagePrice: 1,
  viewerMinutePrice: 0.1333,
  viewerTier2From: 0,
  viewerTier2Pct: 100,
  viewerTier3From: 0,
  viewerTier3Pct: 100,
  welcomeViewerMinutes: 0,
  brandingPrice: 199,
  tickerPrice: 199,
  cameraMinutePrice: 2,
  destinationMinutePrice: 1,
  chargeSocialViewers: false,
  welcomeCredits: 300,
};

/**
 * Credits (in hundredths, not rounded) for the first `minutes` billable viewer-minutes of one
 * event, with the tiers. Cumulative, so charging the difference each minute is exact.
 */
export function viewerCostCc(minutes: number, p: Pricing): number {
  const x = p.viewerMinutePrice * 100;
  if (x <= 0 || minutes <= 0) return 0;
  const t2 = p.viewerTier2From > 0 ? p.viewerTier2From : Infinity;
  const t3 = p.viewerTier3From > 0 && p.viewerTier3From > (Number.isFinite(t2) ? t2 : 0) ? p.viewerTier3From : Infinity;
  const a = Math.min(minutes, t2);
  const b = Math.max(0, Math.min(minutes, t3) - t2);
  const c = Math.max(0, minutes - t3);
  return x * (a + (b * p.viewerTier2Pct) / 100 + (c * p.viewerTier3Pct) / 100);
}

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
  /** Welcome allowance left, in viewer-seconds (bigint as string). */
  free_viewer_sec: string;
  billing_name: string | null;
  billing_phone: string | null;
  billing_email: string | null;
  gstin: string | null;
}

export interface WalletTxRow {
  id: string;
  org_id: string;
  kind: 'purchase' | 'cameras' | 'minutes' | 'admin' | 'refund' | 'destinations' | 'viewership' | 'messages' | 'viewers' | 'branding' | 'ticker';
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
  /** `perMinute` > 0: no slots, each camera sending video beyond `free` costs that much a minute while live (`liveNow` of them now). */
  cameras: { free: number; extra: number; limit: number; used: number; price: number; perMinute: number; liveNow: number };
  /** Places the show is streamed to (main platforms + extra destinations). */
  destinations: { free: number; extra: number; limit: number; used: number; price: number; perMinute: number };
  /** Credits per minute at this moment while live: live time + extras + viewers. */
  perMinuteNow: number;
  minutes: {
    free: number;
    liveSeconds: number;
    billed: number;
    price: number;
    freeSecondsLeft: number;
    /** Seconds of live time left before the grace period: null = unlimited (free pricing). */
    remainingSeconds: number | null;
  };
  /** Viewer-minutes of this event (watch page + YouTube + Facebook), and the club's free ones left. */
  viewers: { minutes: number; freeUsed: number; billable: number; price: number; freeLeft: number; perMinuteNow: number };
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
  /** Viewer-seconds counted per second at the last tick (for "time left at this audience"). */
  viewerRate: number;
  /** Cameras sending video at the last tick. */
  liveCameras: number;
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
  /** Writes pending watch-page reports before counting viewer-seconds (set by the app wiring). */
  flushViewers: (() => Promise<void>) | null = null;
  /** How many destinations an event streams to (set by the app wiring: OutputsService.destinationCount). */
  destinationCounter: ((t: TournamentRow) => Promise<number>) | null = null;
  /** How many of an event's cameras are sending video now (set by the app wiring: the hub's health). */
  liveCameraCounter: ((tournamentId: string) => Promise<number>) | null = null;

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
    const np = v.pricing ?? cur.pricing;
    if (np.viewerTier2From > 0 && np.viewerTier3From > 0 && np.viewerTier3From <= np.viewerTier2From) {
      throw new HttpError(400, 'bad_tiers', 'Tier 3 must start at more viewer-minutes than tier 2.');
    }
    if (new Set(packs.map((p) => p.id)).size !== packs.length) throw new HttpError(400, 'duplicate_pack', 'Each credit pack needs a different id.');
    await this.repo.db.query('UPDATE platform_settings SET pricing = $1, packs = $2, updated_by = $3, updated_at = now() WHERE id', [
      JSON.stringify(v.pricing ?? cur.pricing),
      JSON.stringify(packs),
      by,
    ]);
  }

  // ------------------------------------------------------------------ wallet
  async orgBilling(orgId: string, q: Q = this.repo.db): Promise<OrgBillingRow> {
    const hit = (await q.query<OrgBillingRow>('SELECT * FROM org_billing WHERE org_id = $1', [orgId])).rows[0];
    if (hit) return hit;
    // A new club: the welcome viewer-minutes and welcome credits come with its wallet, once.
    const { pricing } = await this.settings();
    const welcomeCc = this.enabled ? toCc(pricing.welcomeCredits) : 0;
    const ins = await q.query('INSERT INTO org_billing (org_id, free_viewer_sec, balance_cc) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING org_id', [
      orgId,
      pricing.welcomeViewerMinutes * 60,
      welcomeCc,
    ]);
    if (ins.rows[0] && welcomeCc > 0) {
      await q.query("INSERT INTO wallet_tx (org_id, kind, amount_cc, ref, note, created_by) VALUES ($1, 'welcome', $2, $3, 'Welcome credits', 'system') ON CONFLICT DO NOTHING", [
        orgId,
        welcomeCc,
        `welcome:${orgId}`,
      ]);
    }
    return (await q.query<OrgBillingRow>('SELECT * FROM org_billing WHERE org_id = $1', [orgId])).rows[0];
  }

  async pricingFor(orgId: string, row?: OrgBillingRow): Promise<Pricing> {
    const [{ pricing }, b] = await Promise.all([this.settings(), row ? Promise.resolve(row) : this.orgBilling(orgId)]);
    const o = pricingSchema.partial().safeParse(b.overrides ?? {});
    return { ...pricing, ...(o.success ? o.data : {}) };
  }

  async updateOrgBilling(
    orgId: string,
    v: {
      overrides?: Partial<Pricing>;
      suspended?: boolean;
      suspendedReason?: string | null;
      name?: string | null;
      phone?: string | null;
      email?: string | null;
      gstin?: string | null;
      freeViewerMinutes?: number;
    },
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
    if (v.freeViewerMinutes !== undefined) add('free_viewer_sec', Math.round(v.freeViewerMinutes * 60));
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
    if (p.cameraMinutePrice > 0) return null; // per minute while live: no slots
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
    if (p.destinationMinutePrice > 0) return null; // per minute while live: no slots
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

  /** Buys the own-logo pack or the ticker for one event (once). Free when the price is 0 or billing is off. */
  async buyAddon(t: TournamentRow, what: 'branding' | 'ticker', by: string): Promise<void> {
    const col = what === 'branding' ? 'branding_paid_at' : 'ticker_paid_at';
    if (t[col] || (await this.addonOn(t, what))) return;
    const p = await this.pricingFor(t.org_id);
    const price = what === 'branding' ? p.brandingPrice : p.tickerPrice;
    const cc = this.enabled ? toCc(price) : 0;
    const b = await this.orgBilling(t.org_id);
    if (this.enabled && b.suspended) throw new HttpError(403, 'club_suspended', suspendedText(b));
    const label = what === 'branding' ? 'Branding: logo, watermark and ticker' : 'Branding: ticker, logo and watermark';
    await this.repo.tx(async (c) => {
      // One purchase turns on the whole branding pack (logo + watermark + ticker).
      const r = await c.query(`UPDATE tournaments SET branding_paid_at = COALESCE(branding_paid_at, now()), ticker_paid_at = COALESCE(ticker_paid_at, now()) WHERE id = $1 AND ${col} IS NULL`, [t.id]);
      if (!r.rowCount || cc <= 0) return;
      const left = await this.debit(c, t.org_id, cc, { kind: what, quantity: 1, tournamentId: t.id, note: label, by });
      if (left === null) throw new HttpError(402, 'insufficient_credits', `${label} costs ${fromCc(cc)} credits; the club has ${fromCc(b.balance_cc)}. Buy credits first.`);
    });
    if (cc > 0) await this.walletChanged(t.org_id);
  }

  /** Whether an add-on is usable for this event: bought, or free (price 0 / billing off). */
  async addonOn(t: TournamentRow, what: 'branding' | 'ticker'): Promise<boolean> {
    if (t.branding_paid_at || t.ticker_paid_at) return true; // one pack: either purchase covers both
    if (!this.enabled) return true;
    const p = await this.pricingFor(t.org_id);
    return (what === 'branding' ? p.brandingPrice : p.tickerPrice) <= 0;
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
    // Credits used per second at the current audience (viewers), on top of live minutes.
    const meter = this.meters.get(t.id);
    const viewerRate = meter?.viewerRate ?? 0;
    const destUsed = this.destinationCounter ? await this.destinationCounter(t) : 0;
    const camsLive = meter?.liveCameras ?? 0;
    // Extras switched on now, charged per minute while live (simple pricing).
    const extrasCcPerMin = extraCamerasCc(camsLive, p) + extraDestinationsCc(destUsed, p);
    const viewerCcPerSec = (viewerRate * p.viewerMinutePrice * 100) / 60;
    const minuteCcPerSec = toCc(p.minutePrice) / 60;
    const burnCcPerSec = minuteCcPerSec + viewerCcPerSec + extrasCcPerMin / 60;
    if (this.enabled && burnCcPerSec > 0) {
      const prepaid = Math.max(0, billed * 60 - Math.max(0, live - freeSec));
      const free = p.minutePrice > 0 ? freeLeft + prepaid : 0;
      remaining = free + Math.floor(balanceCc / burnCcPerSec);
    }
    const vCounted = Number(t.viewer_sec_counted ?? 0);
    const vFree = Number(t.viewer_sec_free ?? 0);
    const vBillable = Number(t.viewer_sec_billable ?? 0);
    const destPerMinute = p.destinationMinutePrice > 0;
    const destLimit = destPerMinute ? Math.max(destUsed, p.freeDestinations) : p.freeDestinations + (t.extra_destinations ?? 0);
    const camPerMinute = p.cameraMinutePrice > 0;
    const graceLeft = this.meters.get(t.id)?.inGrace ? Math.max(0, p.graceMinutes * 60 - (t.grace_seconds ?? 0)) : null;
    let reason: string | null = null;
    if (this.enabled && b.suspended) reason = suspendedText(b);
    else if (destUsed > destLimit) {
      const more = destUsed - destLimit;
      reason = `This event streams to ${destUsed} destinations and includes ${destLimit}. Add ${more} more (${p.destinationPrice} credits each) or switch ${more === 1 ? 'one' : 'some'} off.`;
    } else if (remaining !== null && remaining <= 0 && p.minutePrice > 0) reason = `No live minutes left: the free ${p.freeMinutes} minutes are used and the club has ${fromCc(balanceCc)} credits (${p.minutePrice} per minute). Buy credits to go live.`;
    return {
      enabled: this.enabled,
      suspended: b.suspended,
      suspendedReason: b.suspended_reason,
      balance: fromCc(balanceCc),
      pricing: p,
      cameras: {
        free: p.freeCameras,
        extra: t.extra_cameras ?? 0,
        limit: camPerMinute ? Math.max(used, p.freeCameras) : p.freeCameras + (t.extra_cameras ?? 0),
        used,
        price: camPerMinute ? 0 : p.cameraPrice,
        perMinute: p.cameraMinutePrice,
        liveNow: camsLive,
      },
      destinations: { free: p.freeDestinations, extra: t.extra_destinations ?? 0, limit: destLimit, used: destUsed, price: destPerMinute ? 0 : p.destinationPrice, perMinute: p.destinationMinutePrice },
      perMinuteNow: meter ? Math.round(burnCcPerSec * 60) / 100 : 0,
      minutes: { free: p.freeMinutes, liveSeconds: live, billed, price: p.minutePrice, freeSecondsLeft: freeLeft, remainingSeconds: remaining },
      viewers: {
        minutes: Math.floor(vCounted / 60),
        freeUsed: Math.floor(vFree / 60),
        billable: Math.floor(vBillable / 60),
        price: p.viewerMinutePrice,
        freeLeft: Math.floor(Number(b.free_viewer_sec ?? 0) / 60),
        perMinuteNow: Math.round(viewerRate * 60) / 60,
      },
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
        m = { lastTick: now, carryMs: 0, warned: new Set(), inGrace: false, stopRequestedAt: 0, viewerRate: 0, liveCameras: 0 };
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
    let short = false; // something could not be paid this tick
    let charged = false;
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
        if (paid) charged = true;
        else short = true;
      }
    }
    const v = await this.meterViewers(t, p, m, sec);
    if (v === 'paid') charged = true;
    if (v === 'short') short = true;
    const x = await this.meterExtras(t, p, m, sec);
    if (x === 'paid') charged = true;
    if (x === 'short') short = true;
    if (charged && !short) {
      if (m.inGrace) {
        m.inGrace = false;
        await this.repo.db.query('UPDATE tournaments SET grace_seconds = 0 WHERE id = $1', [t.id]);
        hooks.alert(t.id, 'info', 'Credits added. The broadcast continues.');
      }
      await this.walletChanged(t.org_id, t.id);
    } else if (charged) {
      await this.walletChanged(t.org_id, t.id);
    }
    if (short && !m.inGrace) {
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
    const fresh = (await this.repo.tournamentById(t.id))!;
    if (m.inGrace && fresh.grace_seconds >= p.graceMinutes * 60) {
      this.requestStop(t.id, m, 'Credits finished and the grace period is over. The broadcast has been ended. Buy credits to go live again.');
    }
    const state = await this.tournamentState(fresh); // balance after this tick's charge
    this.warn(t.id, m, state);
    hooks.changed(t.id, state);
  }

  /**
   * Extra cameras (sending video, beyond the free ones) and extra destinations, per minute while
   * live. Fractions of a hundredth accrue; whole hundredths are charged on one growing ledger
   * line per broadcast. 'short' = the wallet could not pay (grace, like live minutes).
   */
  private async meterExtras(t: TournamentRow, p: Pricing, m: Meter, sec: number): Promise<'none' | 'paid' | 'short'> {
    if (p.cameraMinutePrice <= 0 && p.destinationMinutePrice <= 0) return 'none';
    m.liveCameras = this.liveCameraCounter ? await this.liveCameraCounter(t.id) : 0;
    const dests = p.destinationMinutePrice > 0 && this.destinationCounter ? await this.destinationCounter(t) : 0;
    const add = [
      { kind: 'cameras' as const, col: 'cam', cc: (extraCamerasCc(m.liveCameras, p) * sec) / 60, note: 'Extra cameras while live' },
      { kind: 'destinations' as const, col: 'dest', cc: (extraDestinationsCc(dests, p) * sec) / 60, note: 'Extra destinations while live' },
    ];
    let out: 'none' | 'paid' | 'short' = 'none';
    for (const a of add) {
      const r = await this.repo.tx(async (c) => {
        const row = (
          await c.query<{ acc: string; billed: string }>(
            `UPDATE tournaments SET ${a.col}_cc_accrued = ${a.col}_cc_accrued + $2 WHERE id = $1 RETURNING ${a.col}_cc_accrued::text AS acc, ${a.col}_cc_billed::text AS billed`,
            [t.id, a.cc],
          )
        ).rows[0];
        const owed = Math.floor(Number(row.acc)) - Number(row.billed);
        if (owed <= 0) return 'none' as const;
        const left = await this.debit(c, t.org_id, owed, { kind: a.kind, tournamentId: t.id, ref: `${a.col}live:${t.id}:${(t.live_session_at ?? new Date()).toISOString()}`, note: a.note, by: 'system' });
        if (left === null) return 'short' as const;
        await c.query(`UPDATE tournaments SET ${a.col}_cc_billed = ${a.col}_cc_billed + $2 WHERE id = $1`, [t.id, owed]);
        return 'paid' as const;
      });
      if (r === 'short') out = 'short';
      else if (r === 'paid' && out === 'none') out = 'paid';
    }
    return out;
  }

  /** Viewer-seconds of an event while live: watch page (real seconds) + YouTube + Facebook (per minute, when charged). */
  async viewerSeconds(tid: string, social = true): Promise<number> {
    const r = (
      await this.repo.db.query<{ watch: string; social: string }>(
        `SELECT COALESCE((SELECT sum(live_sec) FROM viewers WHERE tournament_id = $1 AND NOT flagged), 0)::text AS watch,
                COALESCE((SELECT sum(COALESCE(youtube, 0) + COALESCE(facebook, 0)) FROM viewer_minutes WHERE tournament_id = $1), 0)::text AS social`,
        [tid],
      )
    ).rows[0];
    return Number(r.watch) + (social ? 60 * Number(r.social) : 0);
  }

  /**
   * Counts new viewer-seconds, takes them from the club's welcome allowance first, then charges
   * X per viewer-minute (with this event's tiers). 'short' = the wallet could not pay (grace).
   */
  private async meterViewers(t: TournamentRow, p: Pricing, m: Meter | null, sec: number): Promise<'none' | 'paid' | 'short'> {
    const total = await this.viewerSeconds(t.id, p.chargeSocialViewers);
    const counted = Number(t.viewer_sec_counted ?? 0);
    const delta = Math.max(0, total - counted);
    if (m && sec > 0) m.viewerRate = m.viewerRate ? m.viewerRate * 0.6 + (delta / sec) * 0.4 : delta / sec;
    const res = await this.repo.tx(async (c) => {
      let billable = Number(t.viewer_sec_billable ?? 0);
      if (delta > 0) {
        const b = await this.orgBilling(t.org_id, c);
        const fromFree = Math.min(delta, Number(b.free_viewer_sec ?? 0));
        if (fromFree > 0) await c.query('UPDATE org_billing SET free_viewer_sec = free_viewer_sec - $2 WHERE org_id = $1', [t.org_id, fromFree]);
        billable += delta - fromFree;
        await c.query(
          'UPDATE tournaments SET viewer_sec_counted = viewer_sec_counted + $2, viewer_sec_free = viewer_sec_free + $3, viewer_sec_billable = viewer_sec_billable + $4 WHERE id = $1',
          [t.id, delta, fromFree, delta - fromFree],
        );
      }
      // Charge whole viewer-minutes; the part of a minute is charged when it completes.
      const owed = Math.floor(viewerCostCc(Math.floor(billable / 60), p)) - Number(t.viewer_cc_billed ?? 0);
      if (owed <= 0) return 'none' as const;
      const minutesNow = Math.floor(billable / 60);
      const left = await this.debit(c, t.org_id, owed, {
        kind: 'viewers',
        quantity: Math.max(0, minutesNow - Math.floor((Number(t.viewer_sec_billable ?? 0)) / 60)),
        tournamentId: t.id,
        ref: `viewers:${t.id}:${(t.live_session_at ?? new Date()).toISOString()}`,
        note: 'Viewer-minutes',
        by: 'system',
      });
      if (left === null) return 'short' as const;
      await c.query('UPDATE tournaments SET viewer_cc_billed = viewer_cc_billed + $2 WHERE id = $1', [t.id, owed]);
      return 'paid' as const;
    });
    return res;
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
    const m = this.meters.get(tid) ?? null;
    this.meters.delete(tid);
    const t0 = await this.repo.tournamentById(tid);
    if (!t0) return;
    const p = await this.pricingFor(t0.org_id);
    // Last viewer-seconds of the show (watch-page reports still on their way, last minute).
    await this.flushViewers?.().catch(() => {});
    const vr = await this.meterViewers(t0, p, m, 0).catch(() => 'none' as const);
    if (vr === 'short') {
      // Like grace minutes: viewer-minutes the wallet could not pay at the end are written off.
      await this.repo.db.query(
        'UPDATE tournaments SET viewer_cc_billed = GREATEST(viewer_cc_billed, $2) WHERE id = $1',
        [tid, Math.floor(viewerCostCc(Math.floor(Number((await this.repo.tournamentById(tid))!.viewer_sec_billable ?? 0) / 60), p))],
      );
    }
    if (vr === 'paid') await this.walletChanged(t0.org_id, tid);
    // Extras the wallet could not pay at the end are written off too; the next broadcast starts clean.
    await this.repo.db.query(
      'UPDATE tournaments SET cam_cc_accrued = cam_cc_billed, dest_cc_accrued = dest_cc_billed WHERE id = $1',
      [tid],
    );
    const t = (await this.repo.tournamentById(tid))!;
    const freeSec = p.freeMinutes * 60;
    const owed = Math.ceil(Math.max(0, t.live_seconds - freeSec) / 60);
    const billed = Math.max(t.billed_minutes, owed);
    const live = t.live_seconds > freeSec ? Math.max(t.live_seconds, freeSec + billed * 60) : t.live_seconds;
    await this.repo.db.query('UPDATE tournaments SET live_session_at = NULL, grace_seconds = 0, billed_minutes = $2, live_seconds = $3 WHERE id = $1', [tid, billed, live]);
    const fresh = await this.repo.tournamentById(tid);
    if (fresh) this.hooks?.changed(tid, await this.tournamentState(fresh));
  }

  /** Called after every wallet change (low-credit email). */
  onWalletChanged: ((orgId: string) => Promise<void>) | null = null;

  private async walletChanged(orgId: string, skip?: string): Promise<void> {
    if (this.onWalletChanged) void this.onWalletChanged(orgId).catch(() => {});
    if (!this.hooks) return;
    // Live tournaments of this club show the new balance immediately.
    for (const tid of this.hooks.streaming()) {
      if (tid === skip) continue;
      const t = await this.repo.tournamentById(tid);
      if (t && t.org_id === orgId) this.hooks.changed(tid, await this.tournamentState(t));
    }
  }
}

/** Hundredths of a credit per minute for the cameras sending video beyond the free ones. */
export function extraCamerasCc(live: number, p: Pricing): number {
  return p.cameraMinutePrice > 0 ? Math.max(0, live - p.freeCameras) * toCc(p.cameraMinutePrice) : 0;
}

/** Hundredths of a credit per minute for destinations beyond the free ones. */
export function extraDestinationsCc(used: number, p: Pricing): number {
  return p.destinationMinutePrice > 0 ? Math.max(0, used - p.freeDestinations) * toCc(p.destinationMinutePrice) : 0;
}

export function suspendedText(b: OrgBillingRow): string {
  return `This club's account is suspended by CoGolfers${b.suspended_reason ? `: ${b.suspended_reason}` : ''}. Contact CoGolfers support.`;
}
