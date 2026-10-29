import crypto from 'node:crypto';
import type { Config } from './config.js';
import type { Repo, TournamentRow } from './repo.js';
import { HttpError } from './errors.js';
import type { MomentOption, MomentRow, MomentsService, PrizeHooks, RunRow } from './moments.js';
import type { ViewershipService } from './viewership.js';
import { Messenger, maskPhone, normalisePhone } from './messaging.js';

const OTP_TTL_MS = 10 * 60_000;
const OTP_MAX_TRIES = 5;
const OTP_MAX_SENDS = 3;
/** Prizes that still count against the stock (an expired one goes back, or to a reserve). */
const HOLDING = "('won', 'claimed', 'sent')";

export interface WinRow {
  id: string;
  tournament_id: string;
  moment_id: string;
  run_key: string;
  viewer_id: string;
  prize: string;
  sponsor: string | null;
  status: 'won' | 'reserve' | 'claimed' | 'sent' | 'expired';
  reserve_rank: number | null;
  claim_code: string;
  claim_expires_at: Date | null;
  phone: string | null;
  email: string | null;
  otp_hash: string | null;
  otp_expires_at: Date | null;
  otp_tries: number;
  otp_sends: number;
  consent_at: Date | null;
  notified_at: Date | null;
  claimed_at: Date | null;
  sent_at: Date | null;
  created_at: Date;
}

/** Fisher–Yates with a cryptographic random number: the order of a draw. */
function shuffle<T>(a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

const hashOtp = (code: string, otp: string, secret: string) => crypto.createHmac('sha256', secret).update(`otp:${code}:${otp}`).digest('hex');

/**
 * Prizes (viewership step 4). The server picks every winner, within the limits set per game:
 * prizes in stock, winners per run, one prize per viewer and per phone number per event, the
 * viewer watched long enough (and unmuted, if asked). Every draw is logged. Winners claim with
 * their phone (one-time code), email and consent; an unclaimed prize goes to the next reserve.
 * Sharing is never needed to win or claim.
 */
export class PrizesService implements PrizeHooks {
  /** Wins waiting to be told to the viewer's watch page (via the next report). */
  private toTell = new Map<string, unknown[]>();

  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
    private readonly moments: MomentsService,
    private readonly viewership: ViewershipService,
    private readonly messenger: Messenger,
    private readonly now: () => number = Date.now,
  ) {}

  private get base() {
    return this.config.PUBLIC_BASE_URL.replace(/\/$/, '');
  }

  claimUrl(code: string): string {
    return `${this.base}/claim/${code}`;
  }

  private winDto(w: WinRow) {
    return {
      id: w.id,
      prize: w.prize,
      sponsor: w.sponsor,
      status: w.status,
      claimUrl: this.claimUrl(w.claim_code),
      claimBy: w.claim_expires_at ? new Date(w.claim_expires_at).toISOString() : null,
    };
  }

  // ---------------------------------------------------------------- limits
  async remaining(m: MomentRow): Promise<number> {
    if (!m.prize_stock) return 0;
    const n = Number((await this.repo.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM wins WHERE moment_id = $1 AND status IN ${HOLDING}`, [m.id])).rows[0].n);
    return Math.max(0, m.prize_stock - n);
  }

  /** Watched long enough, unmuted if asked, counted (not a bot), and under the prizes-per-viewer limit. */
  async eligible(m: MomentRow, viewerId: string): Promise<boolean> {
    await this.viewership.flush().catch(() => {});
    const v = (
      await this.repo.db.query<{ watched_sec: number; unmuted_sec: number; flagged: boolean; tournament_id: string }>(
        'SELECT watched_sec, unmuted_sec, flagged, tournament_id FROM viewers WHERE id = $1',
        [viewerId],
      )
    ).rows[0];
    if (!v || v.flagged || v.watched_sec < m.min_watch_sec) return false;
    if (m.need_unmuted && v.unmuted_sec <= 0) return false;
    const t = await this.repo.tournamentById(v.tournament_id);
    const has = Number(
      (await this.repo.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM wins WHERE tournament_id = $1 AND viewer_id = $2 AND status IN ${HOLDING}`, [v.tournament_id, viewerId])).rows[0]
        .n,
    );
    return has < (t?.prizes_per_viewer ?? 1);
  }

  /** May this viewer win this game now (stock, per-run limit, pace, eligibility)? */
  async canWin(m: MomentRow, viewerId: string, runKey: string | null): Promise<boolean> {
    if ((await this.remaining(m)) <= 0) return false;
    if (runKey && m.winners_per_run) {
      const n = Number((await this.repo.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM wins WHERE moment_id = $1 AND run_key = $2 AND status IN ${HOLDING}`, [m.id, runKey])).rows[0].n);
      if (n >= m.winners_per_run) return false;
    }
    if (m.pace_per_hour) {
      const n = Number(
        (await this.repo.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM wins WHERE moment_id = $1 AND created_at > to_timestamp($2 / 1000.0)`, [m.id, this.now() - 3600_000])).rows[0].n,
      );
      if (n >= m.pace_per_hour) return false;
    }
    return this.eligible(m, viewerId);
  }

  private async createWin(m: MomentRow, runKey: string, viewerId: string, status: 'won' | 'reserve', rank: number | null, phone: string | null): Promise<WinRow> {
    const code = crypto.randomBytes(9).toString('base64url');
    const w = (
      await this.repo.db.query<WinRow>(
        `INSERT INTO wins (tournament_id, moment_id, run_key, viewer_id, prize, sponsor, status, reserve_rank, claim_code, claim_expires_at, phone)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [m.tournament_id, m.id, runKey, viewerId, m.prize, m.sponsor, status, rank, code, status === 'won' ? new Date(this.now() + m.claim_hours * 3600_000) : null, phone],
      )
    ).rows[0];
    if (status === 'won') await this.tell(w);
    return w;
  }

  /** A new winner: their watch page shows "You won!" on its next report; a known number gets an SMS too. */
  private async tell(w: WinRow): Promise<void> {
    const list = this.toTell.get(w.viewer_id) ?? [];
    list.push(this.winDto(w));
    this.toTell.set(w.viewer_id, list);
    if (w.phone) {
      const t = await this.repo.tournamentById(w.tournament_id);
      await this.messenger
        .send([{ kind: 'winner', phone: w.phone, vars: [w.prize.slice(0, 30), (t?.name ?? 'Go Live').slice(0, 30), this.claimUrl(w.claim_code)], tournamentId: w.tournament_id }])
        .catch(() => 0);
    }
    await this.repo.db.query('UPDATE wins SET notified_at = now() WHERE id = $1', [w.id]);
  }

  /** Wins to show on this viewer's page (taken once). */
  takeWins(viewerId: string): unknown[] {
    const list = this.toTell.get(viewerId);
    if (!list) return [];
    this.toTell.delete(viewerId);
    return list;
  }

  /** Wins this viewer holds in an event (for a returning viewer's page). */
  async winsOf(viewerId: string) {
    return (await this.repo.db.query<WinRow>(`SELECT * FROM wins WHERE viewer_id = $1 AND status IN ('won', 'claimed', 'sent') ORDER BY created_at`, [viewerId])).rows.map((w) =>
      this.winDto(w),
    );
  }

  // ---------------------------------------------------------------- hooks from the games engine
  /** Right after a play: the spin's winning landing, or the first right quiz answers. */
  async afterPlay(m: MomentRow, viewerId: string, runKey: string, outcome: { answer: string | null; correct: boolean | null; segment?: MomentOption }) {
    if (m.pick === 'spin' && outcome.segment?.win) {
      // The landing already checked the limits; check again under a lock-free re-count.
      if (!(await this.canWin(m, viewerId, runKey))) return null;
      return { win: this.winDto(await this.createWin(m, runKey, viewerId, 'won', null, null)) };
    }
    if (m.pick === 'first_correct' && m.type === 'quiz' && outcome.correct) {
      if (!(await this.canWin(m, viewerId, runKey))) return null;
      return { win: this.winDto(await this.createWin(m, runKey, viewerId, 'won', null, null)) };
    }
    return null;
  }

  /** A prediction was settled: the first right answers win. */
  async afterResolve(m: MomentRow, run: RunRow): Promise<void> {
    const plays = (
      await this.repo.db.query<{ viewer_id: string }>(
        `SELECT viewer_id FROM moment_plays WHERE moment_id = $1 AND run_key = $2 AND correct ORDER BY played_at`,
        [m.id, run.id],
      )
    ).rows;
    const picked: { viewer: string; win: string }[] = [];
    for (const p of plays) {
      if (!(await this.canWin(m, p.viewer_id, run.id))) continue;
      const w = await this.createWin(m, run.id, p.viewer_id, 'won', null, null);
      picked.push({ viewer: p.viewer_id, win: w.id });
    }
    await this.log(m, run.id, 'first_correct', plays.length, picked, 'settle');
  }

  private async log(m: MomentRow, runKey: string, method: string, eligible: number, picked: object[], by: string) {
    await this.repo.db.query(
      `INSERT INTO draw_log (tournament_id, moment_id, run_key, method, eligible, picked, by) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (moment_id, run_key) DO NOTHING`,
      [m.tournament_id, m.id, runKey, method, eligible, JSON.stringify(picked), by],
    );
  }

  // ---------------------------------------------------------------- the lucky draw
  /** Enter a lucky draw: phone and consent only. One entry per number and per viewer. */
  async enter(viewerId: string, tournamentId: string, momentId: string, runKey: string, phoneInput: string): Promise<{ created: boolean }> {
    const m = await this.moments.get(tournamentId, momentId);
    if (m.type !== 'draw' || !m.enabled) throw new HttpError(409, 'moment_off', 'This draw has ended.');
    if (await this.repo.db.query('SELECT 1 FROM draw_log WHERE moment_id = $1', [m.id]).then((r) => r.rowCount)) throw new HttpError(409, 'draw_done', 'The draw has already happened.');
    const phone = normalisePhone(phoneInput);
    const v = (await this.repo.db.query<{ ref_id: string | null; tournament_id: string }>('SELECT ref_id, tournament_id FROM viewers WHERE id = $1', [viewerId])).rows[0];
    if (!v || v.tournament_id !== tournamentId) throw new HttpError(401, 'bad_view_token', 'Reload the page.');
    const r = await this.repo.db.query(
      `INSERT INTO draw_entries (moment_id, tournament_id, viewer_id, ref_id, phone, consent_at) VALUES ($1, $2, $3, $4, $5, now()) ON CONFLICT DO NOTHING`,
      [m.id, tournamentId, viewerId, v.ref_id, phone],
    );
    await this.repo.db.query(
      `INSERT INTO moment_plays (moment_id, tournament_id, run_key, viewer_id, played_at, answer) VALUES ($1, $2, $3, $4, now(), 'entered')
       ON CONFLICT (moment_id, run_key, viewer_id) DO UPDATE SET played_at = COALESCE(moment_plays.played_at, now()), answer = 'entered'`,
      [m.id, tournamentId, runKey, viewerId],
    );
    if (r.rowCount) {
      const t = await this.repo.tournamentById(tournamentId);
      await this.messenger.send([{ kind: 'draw_entry', phone, vars: [(t?.name ?? 'Go Live').slice(0, 30)], tournamentId }]).catch(() => 0);
    }
    return { created: Boolean(r.rowCount) };
  }

  /**
   * Runs a draw for a game's run: winners and reserves at random among the eligible. For the
   * lucky draw (type "draw") only entrants still watching can win. Runs once per run.
   */
  async draw(t: TournamentRow, m: MomentRow, runKey: string, by: string) {
    if (m.pick !== 'draw') throw new HttpError(409, 'not_a_draw', 'This game does not pick winners by draw.');
    if ((await this.repo.db.query('SELECT 1 FROM draw_log WHERE moment_id = $1 AND run_key = $2', [m.id, runKey])).rowCount) {
      throw new HttpError(409, 'draw_done', 'This draw has already run.');
    }
    await this.viewership.flush().catch(() => {});
    let pool: { viewer: string; phone: string | null }[];
    if (m.type === 'draw') {
      const watching = this.viewership.watchingViewers(t.id);
      pool = (await this.repo.db.query<{ viewer_id: string; phone: string }>('SELECT viewer_id, phone FROM draw_entries WHERE moment_id = $1', [m.id])).rows
        .filter((e) => watching.has(e.viewer_id))
        .map((e) => ({ viewer: e.viewer_id, phone: e.phone }));
    } else {
      const where = runKey === 'all' ? '' : 'AND run_key = $2';
      pool = (
        await this.repo.db.query<{ viewer_id: string }>(
          `SELECT DISTINCT viewer_id FROM moment_plays WHERE moment_id = $1 AND played_at IS NOT NULL ${where}`,
          runKey === 'all' ? [m.id] : [m.id, runKey],
        )
      ).rows.map((p) => ({ viewer: p.viewer_id, phone: null }));
    }
    const eligible: typeof pool = [];
    const phones = new Set<string>();
    for (const p of shuffle(pool)) {
      if (!(await this.eligible(m, p.viewer))) continue;
      if (p.phone) {
        if (phones.has(p.phone)) continue;
        // One prize per phone number per event.
        const had = await this.repo.db.query(`SELECT 1 FROM wins WHERE tournament_id = $1 AND phone = $2 AND status IN ${HOLDING}`, [t.id, p.phone]);
        if (had.rowCount) continue;
        phones.add(p.phone);
      }
      eligible.push(p);
    }
    const n = Math.min(m.winners_per_run ?? Infinity, await this.remaining(m));
    const winners = eligible.slice(0, n);
    const reserves = eligible.slice(n, n + m.reserves);
    const picked: object[] = [];
    for (const w of winners) picked.push({ viewer: w.viewer, win: (await this.createWin(m, runKey, w.viewer, 'won', null, w.phone)).id });
    let rank = 1;
    for (const r of reserves) picked.push({ viewer: r.viewer, reserve: rank, win: (await this.createWin(m, runKey, r.viewer, 'reserve', rank++, r.phone)).id });
    await this.log(m, runKey, m.type === 'draw' ? 'lucky_draw' : 'draw', pool.length, picked, by);
    return { pool: pool.length, eligible: eligible.length, winners: winners.length, reserves: reserves.length };
  }

  /** Every few seconds: draws for closed runs, lucky draws whose time came, expired claims. */
  async tick(t: TournamentRow): Promise<void> {
    const ms = (await this.moments.list(t.id)).filter((m) => m.enabled && m.pick === 'draw');
    if (ms.length) {
      const logged = new Set(
        (await this.repo.db.query<{ k: string }>("SELECT moment_id || ':' || run_key AS k FROM draw_log WHERE tournament_id = $1", [t.id])).rows.map((r) => r.k),
      );
      const runs = await this.moments.runs(t.id, 6 * 3600_000);
      for (const m of ms) {
        if (m.type === 'draw') {
          const clock = this.viewership.streamClockSec(t);
          if (m.draw_at_sec != null && clock != null && clock >= m.draw_at_sec && !logged.has(`${m.id}:draw`)) await this.draw(t, m, 'draw', 'schedule').catch(() => null);
          continue;
        }
        for (const r of runs) {
          if (r.moment_id !== m.id || r.fired_by === 'missed' || new Date(r.closes_at).getTime() > this.now() - 5000 || logged.has(`${m.id}:${r.id}`)) continue;
          await this.draw(t, m, r.id, 'schedule').catch(() => null);
        }
      }
    }
    await this.expire(t.id);
  }

  /** Claim time is up: the prize goes to the next reserve of the same draw. */
  async expire(tournamentId: string): Promise<number> {
    const gone = (
      await this.repo.db.query<WinRow>(
        `UPDATE wins SET status = 'expired' WHERE tournament_id = $1 AND status = 'won' AND claim_expires_at < to_timestamp($2 / 1000.0) RETURNING *`,
        [tournamentId, this.now()],
      )
    ).rows;
    for (const w of gone) {
      const m = await this.moments.get(tournamentId, w.moment_id).catch(() => null);
      if (!m) continue;
      const next = (
        await this.repo.db.query<WinRow>(
          `UPDATE wins SET status = 'won', claim_expires_at = $2 WHERE id = (
             SELECT id FROM wins WHERE moment_id = $1 AND run_key = $3 AND status = 'reserve' ORDER BY reserve_rank LIMIT 1) RETURNING *`,
          [w.moment_id, new Date(this.now() + m.claim_hours * 3600_000), w.run_key],
        )
      ).rows[0];
      if (next) await this.tell(next);
    }
    return gone.length;
  }

  // ---------------------------------------------------------------- claiming
  async byCode(code: string): Promise<WinRow | null> {
    return (await this.repo.db.query<WinRow>('SELECT * FROM wins WHERE claim_code = $1', [code])).rows[0] ?? null;
  }

  async claimInfo(code: string) {
    const w = await this.byCode(code);
    if (!w || w.status === 'reserve') return null;
    const t = await this.repo.tournamentById(w.tournament_id);
    return {
      prize: w.prize,
      sponsor: w.sponsor,
      event: t?.name ?? '',
      status: w.status,
      claimBy: w.claim_expires_at ? new Date(w.claim_expires_at).toISOString() : null,
      phoneHint: w.phone ? maskPhone(w.phone) : null,
      termsUrl: `${this.base}/prize-terms/${w.tournament_id}`,
    };
  }

  private open(w: WinRow | null): WinRow {
    if (!w || w.status === 'reserve') throw new HttpError(404, 'claim_not_found', 'This prize link is not valid.');
    if (w.status === 'claimed' || w.status === 'sent') throw new HttpError(409, 'already_claimed', 'This prize is already claimed.');
    if (w.status === 'expired' || (w.claim_expires_at && new Date(w.claim_expires_at).getTime() < this.now())) {
      throw new HttpError(410, 'claim_expired', 'The time to claim this prize has passed.');
    }
    return w;
  }

  /** Step 1 of a claim: a one-time code to the phone (the draw's number if the winner entered one). */
  async sendOtp(code: string, phoneInput?: string | null): Promise<{ sentTo: string }> {
    const w = this.open(await this.byCode(code));
    const phone = w.phone ?? (phoneInput ? normalisePhone(phoneInput) : null);
    if (!phone) throw new HttpError(400, 'need_phone', 'Enter your mobile number.');
    if (w.phone && phoneInput && normalisePhone(phoneInput) !== w.phone) throw new HttpError(400, 'wrong_phone', 'Use the number you entered the draw with.');
    if (w.otp_sends >= OTP_MAX_SENDS) throw new HttpError(429, 'otp_limit', 'Too many codes sent. Contact the organiser to claim this prize.');
    const had = await this.repo.db.query(`SELECT 1 FROM wins WHERE tournament_id = $1 AND phone = $2 AND id <> $3 AND status IN ('claimed', 'sent')`, [w.tournament_id, phone, w.id]);
    if (had.rowCount) throw new HttpError(409, 'one_per_phone', 'This number has already claimed a prize in this event.');
    const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await this.repo.db.query('UPDATE wins SET phone = $2, otp_hash = $3, otp_expires_at = $4, otp_tries = 0, otp_sends = otp_sends + 1 WHERE id = $1', [
      w.id,
      phone,
      hashOtp(w.claim_code, otp, this.config.JWT_SECRET),
      new Date(this.now() + OTP_TTL_MS),
    ]);
    await this.messenger.send([{ kind: 'otp', phone, vars: [otp], tournamentId: w.tournament_id }]);
    return { sentTo: maskPhone(phone) };
  }

  /** Step 2: the code, an email and consent: the prize is claimed. */
  async verify(code: string, otp: string, email: string): Promise<{ status: string }> {
    const w = this.open(await this.byCode(code));
    if (!w.otp_hash || !w.otp_expires_at || new Date(w.otp_expires_at).getTime() < this.now()) throw new HttpError(400, 'otp_expired', 'The code has expired. Send a new one.');
    if (w.otp_tries >= OTP_MAX_TRIES) throw new HttpError(429, 'otp_tries', 'Too many wrong codes. Send a new one.');
    const ok = crypto.timingSafeEqual(Buffer.from(hashOtp(w.claim_code, otp.trim(), this.config.JWT_SECRET)), Buffer.from(w.otp_hash));
    if (!ok) {
      await this.repo.db.query('UPDATE wins SET otp_tries = otp_tries + 1 WHERE id = $1', [w.id]);
      throw new HttpError(400, 'otp_wrong', 'That code is not right. Check the SMS and try again.');
    }
    const r = await this.repo.db.query(
      `UPDATE wins SET status = 'claimed', email = $2, consent_at = now(), claimed_at = now(), otp_hash = NULL WHERE id = $1 AND status = 'won'`,
      [w.id, email.trim().toLowerCase()],
    );
    if (!r.rowCount) throw new HttpError(409, 'already_claimed', 'This prize is already claimed.');
    return { status: 'claimed' };
  }

  // ---------------------------------------------------------------- the organiser's view
  async list(t: TournamentRow, withContacts: boolean) {
    const rows = (
      await this.repo.db.query<WinRow & { title: string; ref_name: string | null }>(
        `SELECT w.*, m.title, i.name AS ref_name FROM wins w JOIN moments m ON m.id = w.moment_id
           JOIN viewers v ON v.id = w.viewer_id LEFT JOIN influencers i ON i.id = v.ref_id
          WHERE w.tournament_id = $1 ORDER BY w.created_at DESC`,
        [t.id],
      )
    ).rows;
    return rows.map((w) => ({
      id: w.id,
      game: w.title,
      prize: w.prize,
      sponsor: w.sponsor,
      status: w.status,
      reserveRank: w.reserve_rank,
      phone: w.phone ? (withContacts ? `+${w.phone}` : maskPhone(w.phone)) : null,
      email: w.email ? (withContacts ? w.email : w.email.replace(/^(.).*(@.*)$/, '$1***$2')) : null,
      viaInfluencer: w.ref_name,
      wonAt: w.created_at.toISOString(),
      claimBy: w.claim_expires_at ? new Date(w.claim_expires_at).toISOString() : null,
      claimedAt: w.claimed_at ? w.claimed_at.toISOString() : null,
      sentAt: w.sent_at ? w.sent_at.toISOString() : null,
    }));
  }

  async stock(t: TournamentRow) {
    const ms = (await this.moments.list(t.id)).filter((m) => m.pick);
    const out = [];
    for (const m of ms) {
      const entries = m.type === 'draw' ? Number((await this.repo.db.query<{ n: string }>('SELECT count(*)::text AS n FROM draw_entries WHERE moment_id = $1', [m.id])).rows[0].n) : null;
      out.push({ id: m.id, title: m.title, prize: m.prize, sponsor: m.sponsor, pick: m.pick, stock: m.prize_stock, left: await this.remaining(m), entries });
    }
    return out;
  }

  async drawLog(t: TournamentRow) {
    return (
      await this.repo.db.query<{ moment_id: string; run_key: string; method: string; eligible: number; picked: unknown[]; by: string; created_at: Date; title: string }>(
        'SELECT d.*, m.title FROM draw_log d JOIN moments m ON m.id = d.moment_id WHERE d.tournament_id = $1 ORDER BY d.created_at DESC',
        [t.id],
      )
    ).rows.map((d) => ({
      game: d.title,
      runKey: d.run_key,
      method: d.method,
      eligible: d.eligible,
      winners: d.picked.filter((p) => !(p as { reserve?: number }).reserve).length,
      reserves: d.picked.filter((p) => (p as { reserve?: number }).reserve).length,
      by: d.by,
      at: d.created_at.toISOString(),
    }));
  }

  async markSent(t: TournamentRow, winId: string): Promise<void> {
    const r = await this.repo.db.query(`UPDATE wins SET status = 'sent', sent_at = now() WHERE id = $1 AND tournament_id = $2 AND status = 'claimed'`, [winId, t.id]);
    if (!r.rowCount) throw new HttpError(409, 'not_claimed', 'Only a claimed prize can be marked as sent.');
  }
}
