import crypto from 'node:crypto';
import type { Repo, TournamentRow } from './repo.js';
import { HttpError } from './errors.js';
import type { ViewershipService } from './viewership.js';

export const MOMENT_TYPES = ['quiz', 'poll', 'spin', 'prediction', 'draw'] as const;
export const MOMENT_CLOCKS = ['viewer', 'stream', 'director'] as const;
export const MOMENT_AUDIENCES = ['all', 'unmuted', 'ref', 'new', 'returning'] as const;
export type MomentType = (typeof MOMENT_TYPES)[number];
export type MomentClock = (typeof MOMENT_CLOCKS)[number];

export interface MomentOption {
  id: string;
  text: string;
  /** Spin: how likely this segment is (relative). */
  weight?: number;
  /** Spin: landing here wins (the prize comes with step 4). */
  win?: boolean;
}

export interface MomentRow {
  id: string;
  tournament_id: string;
  type: MomentType;
  title: string;
  question: string | null;
  options: MomentOption[];
  correct_option: string | null;
  clock: MomentClock;
  at_sec: number | null;
  repeat_every_sec: number | null;
  repeat_max: number;
  open_sec: number;
  audience: (typeof MOMENT_AUDIENCES)[number];
  audience_ref: string | null;
  late_join: boolean;
  enabled: boolean;
  sort: number;
  created_at: Date;
  pick: 'draw' | 'first_correct' | 'spin' | null;
  prize: string | null;
  sponsor: string | null;
  prize_stock: number | null;
  winners_per_run: number | null;
  reserves: number;
  claim_hours: number;
  min_watch_sec: number;
  need_unmuted: boolean;
  pace_per_hour: number | null;
  draw_at_sec: number | null;
}

export interface RunRow {
  id: string;
  moment_id: string;
  tournament_id: string;
  run_no: number;
  started_at: Date;
  closes_at: Date;
  fired_by: string;
  correct_option: string | null;
}

export interface MomentInput {
  type: MomentType;
  title: string;
  question?: string | null;
  options?: MomentOption[];
  correctOption?: string | null;
  clock: MomentClock;
  atSec?: number | null;
  repeatEverySec?: number | null;
  repeatMax?: number;
  openSec?: number;
  audience?: MomentRow['audience'];
  audienceRef?: string | null;
  lateJoin?: boolean;
  enabled?: boolean;
  sort?: number;
  /** Prize (step 4). */
  pick?: MomentRow['pick'];
  prize?: string | null;
  sponsor?: string | null;
  prizeStock?: number | null;
  winnersPerRun?: number | null;
  reserves?: number;
  claimHours?: number;
  minWatchSec?: number;
  needUnmuted?: boolean;
  pacePerHour?: number | null;
  drawAtSec?: number | null;
}

/** What a play may hand to the prize engine. */
export interface PrizeHooks {
  afterPlay(m: MomentRow, viewerId: string, runKey: string, outcome: { answer: string | null; correct: boolean | null; segment?: MomentOption }): Promise<{ segment?: MomentOption; win?: unknown } | null>;
  afterResolve(m: MomentRow, run: RunRow): Promise<void>;
}

/** Grace for a late answer (network delay) after a run closes. */
const CLOSE_GRACE_MS = 5000;
/** A viewer-clock moment may be played this many seconds before its time (reports lag). */
const VIEWER_CLOCK_SLACK_SEC = 45;

/**
 * Games on the watch page (viewership step 3). Moments are timed on the viewer clock (each viewer
 * their own run), the stream clock (one run for all, opened by the scheduler) or by the director.
 * The page decides when to show a viewer-clock moment; the server checks every play: the run is
 * open, the viewer's clock really got there, the viewer is in the audience, one play each, and it
 * decides results itself (the spin is drawn here, never on the phone).
 */
export class MomentsService {
  /** The prize engine (step 4), set after construction. */
  prizes?: PrizeHooks;

  constructor(
    private readonly repo: Repo,
    private readonly viewership: ViewershipService,
    private readonly now: () => number = Date.now,
  ) {}

  // ---------------------------------------------------------------- setting up
  private validate(m: MomentInput): void {
    const opts = m.options ?? [];
    const ids = new Set(opts.map((o) => o.id));
    if (ids.size !== opts.length) throw new HttpError(400, 'duplicate_option', 'Two answers have the same id.');
    if (['quiz', 'poll', 'prediction', 'spin'].includes(m.type) && opts.length < 2) {
      throw new HttpError(400, 'need_options', m.type === 'spin' ? 'A wheel needs at least 2 segments.' : 'Add at least 2 answers.');
    }
    if (m.type === 'quiz' && (!m.correctOption || !ids.has(m.correctOption))) throw new HttpError(400, 'need_correct', 'Pick the right answer for the quiz.');
    if (m.type === 'spin' && !opts.some((o) => (o.weight ?? 1) > 0)) throw new HttpError(400, 'bad_weights', 'At least one segment needs a chance above 0.');
    if (m.clock !== 'director' && (m.atSec == null || m.atSec < 0)) throw new HttpError(400, 'need_time', 'Say when it shows (seconds on the clock).');
    if ((m.repeatMax ?? 1) > 1 && !m.repeatEverySec) throw new HttpError(400, 'need_repeat', 'Say how often it repeats.');
    if (m.audience === 'ref' && !m.audienceRef) throw new HttpError(400, 'need_influencer', 'Pick the influencer whose viewers see it.');
    if (m.type === 'draw' && m.pick !== 'draw') m.pick = 'draw';
    if (m.pick) {
      if (!m.prize?.trim()) throw new HttpError(400, 'need_prize', 'Describe the prize, e.g. “₹500 voucher from Sponsor X”.');
      if (!m.prizeStock || m.prizeStock < 1) throw new HttpError(400, 'need_stock', 'How many prizes are there?');
      if (m.pick === 'spin' && m.type !== 'spin') throw new HttpError(400, 'bad_pick', 'Wheel prizes are for spin-the-wheel games.');
      if (m.pick === 'spin' && !opts.some((o) => o.win)) throw new HttpError(400, 'need_win_segment', 'Mark at least one wheel segment as a win.');
      if (m.pick === 'first_correct' && m.type !== 'quiz' && m.type !== 'prediction') throw new HttpError(400, 'bad_pick', '“First right answers” is for quizzes and predictions.');
      if (m.pick === 'spin' && !opts.some((o) => !o.win)) throw new HttpError(400, 'need_lose_segment', 'Keep at least one segment that does not win, for when prizes run out.');
    } else if (m.type === 'spin' && opts.some((o) => o.win)) {
      // A wheel can show "win" segments for fun without a prize.
    }
  }

  /** Prize columns (step 4), saved next to the game. */
  private async savePrize(id: string, m: MomentInput): Promise<void> {
    await this.repo.db.query(
      `UPDATE moments SET pick = $2, prize = $3, sponsor = $4, prize_stock = $5, winners_per_run = $6, reserves = $7, claim_hours = $8,
         min_watch_sec = $9, need_unmuted = $10, pace_per_hour = $11, draw_at_sec = $12 WHERE id = $1`,
      [
        id, m.pick ?? null, m.pick ? m.prize?.trim() : null, m.pick ? (m.sponsor?.trim() || null) : null, m.pick ? m.prizeStock : null,
        m.winnersPerRun ?? null, m.reserves ?? 2, m.claimHours ?? 24, m.minWatchSec ?? 120, m.needUnmuted ?? false, m.pacePerHour ?? null, m.drawAtSec ?? null,
      ],
    );
  }

  async list(tournamentId: string): Promise<MomentRow[]> {
    return (await this.repo.db.query<MomentRow>('SELECT * FROM moments WHERE tournament_id = $1 ORDER BY sort, created_at', [tournamentId])).rows;
  }

  async get(tournamentId: string, id: string): Promise<MomentRow> {
    const m = (await this.repo.db.query<MomentRow>('SELECT * FROM moments WHERE id = $1 AND tournament_id = $2', [id, tournamentId])).rows[0];
    if (!m) throw new HttpError(404, 'moment_not_found', 'That game is not on this event.');
    return m;
  }

  async create(t: TournamentRow, m: MomentInput): Promise<MomentRow> {
    this.validate(m);
    const row = (
      await this.repo.db.query<MomentRow>(
        `INSERT INTO moments (tournament_id, type, title, question, options, correct_option, clock, at_sec, repeat_every_sec, repeat_max, open_sec, audience, audience_ref, late_join, enabled, sort)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
        [
          t.id, m.type, m.title, m.question ?? null, JSON.stringify(m.options ?? []), m.correctOption ?? null, m.clock,
          m.clock === 'director' ? null : m.atSec, m.repeatEverySec ?? null, m.repeatMax ?? 1, m.openSec ?? 60,
          m.audience ?? 'all', m.audienceRef ?? null, m.lateJoin ?? false, m.enabled ?? true, m.sort ?? 0,
        ],
      )
    ).rows[0];
    await this.savePrize(row.id, m);
    return this.get(t.id, row.id);
  }

  async update(t: TournamentRow, id: string, patch: Partial<MomentInput>): Promise<MomentRow> {
    const cur = await this.get(t.id, id);
    const merged: MomentInput = {
      type: patch.type ?? cur.type,
      title: patch.title ?? cur.title,
      question: patch.question !== undefined ? patch.question : cur.question,
      options: patch.options ?? cur.options,
      correctOption: patch.correctOption !== undefined ? patch.correctOption : cur.correct_option,
      clock: patch.clock ?? cur.clock,
      atSec: patch.atSec !== undefined ? patch.atSec : cur.at_sec,
      repeatEverySec: patch.repeatEverySec !== undefined ? patch.repeatEverySec : cur.repeat_every_sec,
      repeatMax: patch.repeatMax ?? cur.repeat_max,
      openSec: patch.openSec ?? cur.open_sec,
      audience: patch.audience ?? cur.audience,
      audienceRef: patch.audienceRef !== undefined ? patch.audienceRef : cur.audience_ref,
      lateJoin: patch.lateJoin ?? cur.late_join,
      enabled: patch.enabled ?? cur.enabled,
      sort: patch.sort ?? cur.sort,
      pick: patch.pick !== undefined ? patch.pick : cur.pick,
      prize: patch.prize !== undefined ? patch.prize : cur.prize,
      sponsor: patch.sponsor !== undefined ? patch.sponsor : cur.sponsor,
      prizeStock: patch.prizeStock !== undefined ? patch.prizeStock : cur.prize_stock,
      winnersPerRun: patch.winnersPerRun !== undefined ? patch.winnersPerRun : cur.winners_per_run,
      reserves: patch.reserves ?? cur.reserves,
      claimHours: patch.claimHours ?? cur.claim_hours,
      minWatchSec: patch.minWatchSec ?? cur.min_watch_sec,
      needUnmuted: patch.needUnmuted ?? cur.need_unmuted,
      pacePerHour: patch.pacePerHour !== undefined ? patch.pacePerHour : cur.pace_per_hour,
      drawAtSec: patch.drawAtSec !== undefined ? patch.drawAtSec : cur.draw_at_sec,
    };
    this.validate(merged);
    await this.repo.db.query(
      `UPDATE moments SET type = $2, title = $3, question = $4, options = $5, correct_option = $6, clock = $7, at_sec = $8, repeat_every_sec = $9,
         repeat_max = $10, open_sec = $11, audience = $12, audience_ref = $13, late_join = $14, enabled = $15, sort = $16 WHERE id = $1`,
      [
        id, merged.type, merged.title, merged.question ?? null, JSON.stringify(merged.options ?? []), merged.correctOption ?? null, merged.clock,
        merged.clock === 'director' ? null : merged.atSec, merged.repeatEverySec ?? null, merged.repeatMax ?? 1, merged.openSec ?? 60,
        merged.audience ?? 'all', merged.audienceRef ?? null, merged.lateJoin ?? false, merged.enabled ?? true, merged.sort ?? 0,
      ],
    );
    await this.savePrize(id, merged);
    return this.get(t.id, id);
  }

  async remove(t: TournamentRow, id: string): Promise<void> {
    await this.get(t.id, id);
    await this.repo.db.query('DELETE FROM moments WHERE id = $1', [id]);
  }

  // ---------------------------------------------------------------- shared runs
  async runs(tournamentId: string, sinceMs = 30 * 60_000): Promise<RunRow[]> {
    return (
      await this.repo.db.query<RunRow>(
        `SELECT * FROM moment_runs WHERE tournament_id = $1 AND (closes_at > to_timestamp($2 / 1000.0) OR started_at > to_timestamp($3 / 1000.0)) ORDER BY started_at`,
        [tournamentId, this.now() - sinceMs, this.now() - sinceMs],
      )
    ).rows;
  }

  private async openRun(m: MomentRow, firedBy: string): Promise<RunRow> {
    const startedAt = new Date(this.now());
    return (
      await this.repo.db.query<RunRow>(
        `INSERT INTO moment_runs (moment_id, tournament_id, run_no, started_at, closes_at, fired_by)
         VALUES ($1, $2, (SELECT COALESCE(max(run_no), -1) + 1 FROM moment_runs WHERE moment_id = $1), $3, $4, $5) RETURNING *`,
        [m.id, m.tournament_id, startedAt, new Date(startedAt.getTime() + m.open_sec * 1000), firedBy],
      )
    ).rows[0];
  }

  /** The director fires a game now, for everyone watching. */
  async fire(t: TournamentRow, id: string, by: string): Promise<RunRow> {
    const m = await this.get(t.id, id);
    if (!m.enabled) throw new HttpError(409, 'moment_off', 'This game is switched off.');
    const open = (await this.runs(t.id)).find((r) => r.moment_id === m.id && new Date(r.closes_at).getTime() > this.now());
    if (open) throw new HttpError(409, 'moment_running', 'This game is already running. Wait for it to close.');
    return this.openRun(m, by);
  }

  /** Every few seconds while live: opens stream-clock moments whose time has come. */
  async tick(t: TournamentRow): Promise<number> {
    const clock = this.viewership.streamClockSec(t);
    if (clock == null) return 0;
    const ms = (await this.list(t.id)).filter((m) => m.enabled && m.clock === 'stream' && m.at_sec != null);
    if (!ms.length) return 0;
    const done = (
      await this.repo.db.query<{ moment_id: string; n: number }>(
        'SELECT moment_id, count(*)::int AS n FROM moment_runs WHERE tournament_id = $1 GROUP BY moment_id',
        [t.id],
      )
    ).rows;
    const count = new Map(done.map((d) => [d.moment_id, d.n]));
    let opened = 0;
    for (const m of ms) {
      const n = count.get(m.id) ?? 0;
      if (n >= m.repeat_max) continue;
      const due = m.at_sec! + n * (m.repeat_every_sec ?? 0);
      // Only the run that is due now: if the server was down, missed runs are not opened late.
      if (clock >= due && clock < due + m.open_sec) {
        await this.openRun(m, 'schedule').catch(() => null);
        opened++;
      } else if (clock >= due + m.open_sec) {
        // Skipped (the stream was down): record it as closed so the next repeat lines up.
        await this.repo.db.query(
          `INSERT INTO moment_runs (moment_id, tournament_id, run_no, started_at, closes_at, fired_by) VALUES ($1, $2, $3, $4, $4, 'missed') ON CONFLICT DO NOTHING`,
          [m.id, t.id, n, new Date(new Date(t.first_live_at!).getTime() + due * 1000)],
        );
      }
    }
    return opened;
  }

  /** Settles a prediction: the right answer for its latest run (or a given run). */
  async resolve(t: TournamentRow, id: string, correct: string, runId?: string | null): Promise<RunRow> {
    const m = await this.get(t.id, id);
    if (m.type !== 'prediction') throw new HttpError(409, 'not_prediction', 'Only predictions are settled afterwards.');
    if (!m.options.some((o) => o.id === correct)) throw new HttpError(400, 'bad_option', 'That answer is not one of the choices.');
    const run = runId
      ? (await this.repo.db.query<RunRow>('SELECT * FROM moment_runs WHERE id = $1 AND moment_id = $2', [runId, m.id])).rows[0]
      : (await this.repo.db.query<RunRow>("SELECT * FROM moment_runs WHERE moment_id = $1 AND fired_by <> 'missed' ORDER BY run_no DESC LIMIT 1", [m.id])).rows[0];
    if (!run) throw new HttpError(409, 'no_run', 'This prediction has not run yet.');
    await this.repo.db.query('UPDATE moment_runs SET correct_option = $2 WHERE id = $1', [run.id, correct]);
    await this.repo.db.query('UPDATE moment_plays SET correct = (answer = $2) WHERE moment_id = $1 AND run_key = $3 AND played_at IS NOT NULL', [m.id, correct, run.id]);
    const settled = { ...run, correct_option: correct };
    if (m.pick === 'first_correct') await this.prizes?.afterResolve(m, settled);
    return settled;
  }

  // ---------------------------------------------------------------- what the watch page gets
  /** Moments and shared runs for the page (no right answers until settled). Same for every viewer. */
  async feed(t: TournamentRow, refSlugs: Map<string, string>) {
    const ms = (await this.list(t.id)).filter((m) => m.enabled);
    const runs = (await this.runs(t.id)).filter((r) => r.fired_by !== 'missed');
    return {
      gapSec: t.moment_gap_sec,
      moments: ms.map((m) => ({
        id: m.id,
        type: m.type,
        title: m.title,
        question: m.question,
        options: m.options.map((o) => ({ id: o.id, text: o.text })),
        clock: m.clock,
        atSec: m.at_sec,
        repeatEverySec: m.repeat_every_sec,
        repeatMax: m.repeat_max,
        openSec: m.open_sec,
        audience: m.audience,
        audienceRef: m.audience_ref ? (refSlugs.get(m.audience_ref) ?? null) : null,
        lateJoin: m.late_join,
        prize: m.pick ? { text: m.prize, sponsor: m.sponsor } : null,
      })),
      runs: runs.map((r) => ({
        runKey: r.id,
        momentId: r.moment_id,
        runNo: r.run_no,
        startedAt: new Date(r.started_at).toISOString(),
        closesAt: new Date(r.closes_at).toISOString(),
        correctOption: r.correct_option,
      })),
      serverTime: new Date(this.now()).toISOString(),
    };
  }

  /** What this viewer already saw or played (so a returning viewer gets no repeats). */
  async doneFor(viewerId: string): Promise<string[]> {
    return (await this.repo.db.query<{ k: string }>("SELECT moment_id || ':' || run_key AS k FROM moment_plays WHERE viewer_id = $1", [viewerId])).rows.map(
      (r) => r.k,
    );
  }

  // ---------------------------------------------------------------- a viewer sees / plays
  private async viewer(viewerId: string) {
    const v = (
      await this.repo.db.query<{ id: string; tournament_id: string; ref_id: string | null; visits: number; watched_sec: number; unmuted_sec: number; flagged: boolean }>(
        'SELECT id, tournament_id, ref_id, visits, watched_sec, unmuted_sec, flagged FROM viewers WHERE id = $1',
        [viewerId],
      )
    ).rows[0];
    if (!v) throw new HttpError(401, 'bad_view_token', 'Reload the page.');
    return v;
  }

  /** Checks the run is real and open for this viewer. Returns the moment. */
  private async check(viewerId: string, tournamentId: string, momentId: string, runKey: string, playing: boolean) {
    const m = await this.get(tournamentId, momentId).catch(() => {
      throw new HttpError(404, 'moment_not_found', 'This game has ended.');
    });
    if (!m.enabled) throw new HttpError(409, 'moment_off', 'This game has ended.');
    const v = await this.viewer(viewerId);
    if (v.tournament_id !== tournamentId) throw new HttpError(401, 'bad_view_token', 'Reload the page.');
    const clock = await this.viewership.viewerClock(viewerId);
    // Audience
    if (m.audience === 'ref' && v.ref_id !== m.audience_ref) throw new HttpError(403, 'not_for_you', 'This game is for another audience.');
    if (m.audience === 'new' && v.visits > 1) throw new HttpError(403, 'not_for_you', 'This game is for new viewers.');
    if (m.audience === 'returning' && v.visits <= 1) throw new HttpError(403, 'not_for_you', 'This game is for returning viewers.');
    if (m.audience === 'unmuted' && v.unmuted_sec <= 0 && playing) {
      // Unmuted time may still be on its way (reports every 30 s): accept, the page checked.
    }
    if (/^v\d+$/.test(runKey)) {
      if (m.clock !== 'viewer') throw new HttpError(400, 'bad_run', 'Reload the page.');
      const n = Number(runKey.slice(1));
      if (n >= m.repeat_max) throw new HttpError(409, 'moment_closed', 'This game has ended.');
      const due = (m.at_sec ?? 0) + n * (m.repeat_every_sec ?? 0);
      if (clock + VIEWER_CLOCK_SLACK_SEC < due) throw new HttpError(409, 'too_early', 'Keep watching: this game opens soon.');
      return { m, v, clock, run: null as RunRow | null };
    }
    const run = (await this.repo.db.query<RunRow>('SELECT * FROM moment_runs WHERE id = $1 AND moment_id = $2', [runKey, m.id])).rows[0];
    if (!run || run.fired_by === 'missed') throw new HttpError(404, 'moment_not_found', 'This game has ended.');
    return { m, v, clock, run };
  }

  async seen(viewerId: string, tournamentId: string, momentId: string, runKey: string, kind: 'shown' | 'dismissed'): Promise<void> {
    const { clock } = await this.check(viewerId, tournamentId, momentId, runKey, false);
    if (kind === 'shown') {
      await this.repo.db.query(
        `INSERT INTO moment_plays (moment_id, tournament_id, run_key, viewer_id, watched_at_show) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [momentId, tournamentId, runKey, viewerId, clock],
      );
    } else {
      await this.repo.db.query(
        `INSERT INTO moment_plays (moment_id, tournament_id, run_key, viewer_id, watched_at_show, dismissed_at) VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (moment_id, run_key, viewer_id) DO UPDATE SET dismissed_at = COALESCE(moment_plays.dismissed_at, now())`,
        [momentId, tournamentId, runKey, viewerId, clock],
      );
    }
  }

  /** A viewer plays. Results are decided here. One play per viewer per run. */
  async play(viewerId: string, tournamentId: string, momentId: string, runKey: string, answer: string | null) {
    const { m, clock, run } = await this.check(viewerId, tournamentId, momentId, runKey, true);
    const row = (
      await this.repo.db.query<{ played_at: Date | null; shown_at: Date }>('SELECT played_at, shown_at FROM moment_plays WHERE moment_id = $1 AND run_key = $2 AND viewer_id = $3', [
        momentId,
        runKey,
        viewerId,
      ])
    ).rows[0];
    if (row?.played_at) throw new HttpError(409, 'already_played', 'You already played this one.');
    if (run) {
      const closes = new Date(run.closes_at).getTime();
      const personal = m.late_join && row ? new Date(row.shown_at).getTime() + m.open_sec * 1000 : 0;
      if (this.now() > Math.max(closes, personal) + CLOSE_GRACE_MS) throw new HttpError(409, 'moment_closed', 'Time is up for this one.');
    } else if (row && this.now() > new Date(row.shown_at).getTime() + m.open_sec * 1000 + CLOSE_GRACE_MS) {
      throw new HttpError(409, 'moment_closed', 'Time is up for this one.');
    }
    if (m.type !== 'spin' && m.type !== 'draw' && (!answer || !m.options.some((o) => o.id === answer))) {
      throw new HttpError(400, 'bad_answer', 'Pick one of the answers.');
    }

    let correct: boolean | null = null;
    let result: Record<string, unknown>;
    let segment: MomentOption | undefined;
    if (m.type === 'quiz') {
      correct = answer === m.correct_option;
      result = { correct, correctOption: m.correct_option };
    } else if (m.type === 'spin') {
      segment = this.spin(m.options);
      // With a prize: a winning segment only stands while prizes (and the pace) allow it.
      if (m.pick === 'spin') segment = await this.landing(m, viewerId, segment);
      answer = segment.id;
      result = { segment: segment.id, text: segment.text, win: Boolean(segment.win) };
    } else if (m.type === 'prediction') {
      result = { saved: true, settled: run?.correct_option ?? null };
      if (run?.correct_option) correct = answer === run.correct_option;
    } else {
      result = { saved: true };
    }
    const r = await this.repo.db.query(
      `INSERT INTO moment_plays (moment_id, tournament_id, run_key, viewer_id, watched_at_show, played_at, answer, correct, result)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8)
       ON CONFLICT (moment_id, run_key, viewer_id) DO UPDATE SET played_at = now(), answer = EXCLUDED.answer, correct = EXCLUDED.correct, result = EXCLUDED.result
       WHERE moment_plays.played_at IS NULL`,
      [momentId, tournamentId, runKey, viewerId, clock, answer, correct, JSON.stringify(result)],
    );
    if (!r.rowCount) throw new HttpError(409, 'already_played', 'You already played this one.');
    if (m.type === 'poll' || m.type === 'prediction') result = { ...result, results: await this.tally(m, runKey) };
    if (m.pick && this.prizes && m.pick !== 'draw') {
      const p = await this.prizes.afterPlay(m, viewerId, runKey, { answer, correct, segment });
      if (p?.win) result = { ...result, prize: p.win };
    }
    return { type: m.type, answer, ...result };
  }

  /** Can this landing win? If not (no prize left, too fast, not eligible), land on a losing segment. */
  private async landing(m: MomentRow, viewerId: string, seg: MomentOption): Promise<MomentOption> {
    if (!seg.win) return seg;
    const can = await (this.prizes as unknown as { canWin?: (m: MomentRow, viewerId: string, runKey: string | null) => Promise<boolean> })?.canWin?.(m, viewerId, null);
    if (can) return seg;
    const losers = m.options.filter((o) => !o.win);
    return losers.length ? this.spin(losers.map((o) => ({ ...o, weight: o.weight ?? 1 }))) : seg;
  }

  /** Weighted draw of a wheel segment, with a cryptographic random number. */
  private spin(options: MomentOption[]): MomentOption {
    const total = options.reduce((s, o) => s + Math.max(0, o.weight ?? 1), 0);
    let x = (crypto.randomInt(0, 1_000_000) / 1_000_000) * total;
    for (const o of options) {
      x -= Math.max(0, o.weight ?? 1);
      if (x < 0) return o;
    }
    return options[options.length - 1];
  }

  /** Answer shares for polls and predictions (this run). */
  async tally(m: MomentRow, runKey: string): Promise<{ id: string; text: string; votes: number; percent: number }[]> {
    const where = /^v\d+$/.test(runKey) ? "run_key ~ '^v'" : 'run_key = $2';
    const rows = (
      await this.repo.db.query<{ answer: string; n: number }>(
        `SELECT answer, count(*)::int AS n FROM moment_plays WHERE moment_id = $1 AND played_at IS NOT NULL AND ${where} GROUP BY answer`,
        /^v\d+$/.test(runKey) ? [m.id] : [m.id, runKey],
      )
    ).rows;
    const total = rows.reduce((s, r) => s + r.n, 0);
    const byId = new Map(rows.map((r) => [r.answer, r.n]));
    return m.options.map((o) => {
      const votes = byId.get(o.id) ?? 0;
      return { id: o.id, text: o.text, votes, percent: total ? Math.round((100 * votes) / total) : 0 };
    });
  }

  // ---------------------------------------------------------------- report
  /** Per game: shown, played, closed, right answers, answers, and the extra watch time of players. */
  async report(t: TournamentRow) {
    await this.viewership.flush().catch(() => {});
    const ms = await this.list(t.id);
    const rows = (
      await this.repo.db.query<Record<string, string | null>>(
        `SELECT p.moment_id,
                count(*)::text AS shown,
                count(*) FILTER (WHERE p.played_at IS NOT NULL)::text AS played,
                count(*) FILTER (WHERE p.dismissed_at IS NOT NULL AND p.played_at IS NULL)::text AS dismissed,
                count(*) FILTER (WHERE p.correct)::text AS correct,
                avg(v.watched_sec - p.watched_at_show) FILTER (WHERE p.played_at IS NOT NULL)::text AS after_played,
                avg(v.watched_sec - p.watched_at_show) FILTER (WHERE p.played_at IS NULL)::text AS after_skipped
           FROM moment_plays p JOIN viewers v ON v.id = p.viewer_id
          WHERE p.tournament_id = $1 AND NOT v.flagged
          GROUP BY p.moment_id`,
        [t.id],
      )
    ).rows;
    const runs = (
      await this.repo.db.query<{ moment_id: string; n: number }>(
        "SELECT moment_id, count(*)::int AS n FROM moment_runs WHERE tournament_id = $1 AND fired_by <> 'missed' GROUP BY moment_id",
        [t.id],
      )
    ).rows;
    const byId = new Map(rows.map((r) => [r.moment_id!, r]));
    const runsBy = new Map(runs.map((r) => [r.moment_id, r.n]));
    const out = [];
    for (const m of ms) {
      const r = byId.get(m.id) ?? {};
      const n = (k: string) => Number(r[k] ?? 0);
      const shown = n('shown');
      const played = n('played');
      const ap = r.after_played == null ? null : Math.round(Number(r.after_played));
      const as = r.after_skipped == null ? null : Math.round(Number(r.after_skipped));
      out.push({
        id: m.id,
        type: m.type,
        title: m.title,
        clock: m.clock,
        runs: m.clock === 'viewer' ? null : (runsBy.get(m.id) ?? 0),
        shown,
        played,
        dismissed: n('dismissed'),
        playRate: shown ? Math.round((100 * played) / shown) : 0,
        correctRate: played && (m.type === 'quiz' || m.type === 'prediction') ? Math.round((100 * n('correct')) / played) : null,
        answers: m.type === 'poll' || m.type === 'prediction' || m.type === 'spin' ? await this.tallyAll(m) : null,
        watchAfterSec: { played: ap, skipped: as },
        extraWatchSec: ap != null && as != null ? ap - as : null,
      });
    }
    return out;
  }

  private async tallyAll(m: MomentRow) {
    const rows = (
      await this.repo.db.query<{ answer: string; n: number }>('SELECT answer, count(*)::int AS n FROM moment_plays WHERE moment_id = $1 AND played_at IS NOT NULL GROUP BY answer', [m.id])
    ).rows;
    const byId = new Map(rows.map((r) => [r.answer, r.n]));
    return m.options.map((o) => ({ id: o.id, text: o.text, count: byId.get(o.id) ?? 0 }));
  }

  dto(m: MomentRow) {
    return {
      id: m.id,
      type: m.type,
      title: m.title,
      question: m.question,
      options: m.options,
      correctOption: m.correct_option,
      clock: m.clock,
      atSec: m.at_sec,
      repeatEverySec: m.repeat_every_sec,
      repeatMax: m.repeat_max,
      openSec: m.open_sec,
      audience: m.audience,
      audienceRef: m.audience_ref,
      lateJoin: m.late_join,
      enabled: m.enabled,
      sort: m.sort,
      pick: m.pick,
      prize: m.prize,
      sponsor: m.sponsor,
      prizeStock: m.prize_stock,
      winnersPerRun: m.winners_per_run,
      reserves: m.reserves,
      claimHours: m.claim_hours,
      minWatchSec: m.min_watch_sec,
      needUnmuted: m.need_unmuted,
      pacePerHour: m.pace_per_hour,
      drawAtSec: m.draw_at_sec,
    };
  }
}
