import type { Db } from './db.js';

export interface HoleRow {
  number: number;
  par: number;
  yardage: number | null;
}

export interface PlayerRow {
  id: string;
  tournament_id: string;
  name: string;
  club: string | null;
  category: string | null;
  group_no: number | null;
  sort_order: number;
}

export interface ScoreRow {
  player_id: string;
  hole: number;
  strokes: number;
}

export interface LeaderboardRow {
  playerId: string;
  name: string;
  club: string | null;
  category: string | null;
  groupNo: number | null;
  /** "1", "T2", or "" for players with no score yet. */
  position: string;
  rank: number | null;
  strokes: number;
  /** Strokes relative to par over the holes played. */
  toPar: number | null;
  /** "E", "+2", "-3" or "–". */
  toParText: string;
  /** Holes completed: "3", "F" (all holes), or "–". */
  thru: string;
  holesPlayed: number;
  scores: Record<number, number>;
}

export const DEFAULT_PAR = 4;

export function toParText(n: number | null): string {
  if (n === null) return '–';
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `${n}`;
}

/**
 * Gross stroke-play leaderboard (CoGolfers leagues play without handicap).
 * Ordering: lowest to-par first; ties share a position ("T2"); among ties, more holes
 * played first, then name. Players without any score are listed last.
 */
export function computeLeaderboard(players: PlayerRow[], holes: HoleRow[], scores: ScoreRow[], category?: string | null): LeaderboardRow[] {
  const par = new Map(holes.map((h) => [h.number, h.par]));
  const totalHoles = holes.length || 18;
  const byPlayer = new Map<string, Record<number, number>>();
  for (const s of scores) {
    const m = byPlayer.get(s.player_id) ?? {};
    m[s.hole] = s.strokes;
    byPlayer.set(s.player_id, m);
  }
  const rows: LeaderboardRow[] = players
    .filter((p) => !category || p.category === category)
    .map((p) => {
      const sc = byPlayer.get(p.id) ?? {};
      const played = Object.keys(sc).map(Number);
      const strokes = played.reduce((a, h) => a + sc[h], 0);
      const parPlayed = played.reduce((a, h) => a + (par.get(h) ?? DEFAULT_PAR), 0);
      const toPar = played.length ? strokes - parPlayed : null;
      return {
        playerId: p.id,
        name: p.name,
        club: p.club,
        category: p.category,
        groupNo: p.group_no,
        position: '',
        rank: null,
        strokes,
        toPar,
        toParText: toParText(toPar),
        thru: played.length === 0 ? '–' : played.length >= totalHoles ? 'F' : String(played.length),
        holesPlayed: played.length,
        scores: sc,
      };
    });
  rows.sort((a, b) => {
    if (a.toPar === null && b.toPar === null) return a.name.localeCompare(b.name);
    if (a.toPar === null) return 1;
    if (b.toPar === null) return -1;
    return a.toPar - b.toPar || b.holesPlayed - a.holesPlayed || a.name.localeCompare(b.name);
  });
  let i = 0;
  while (i < rows.length && rows[i].toPar !== null) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].toPar === rows[i].toPar) j++;
    const rank = i + 1;
    for (let k = i; k <= j; k++) {
      rows[k].rank = rank;
      rows[k].position = j > i ? `T${rank}` : `${rank}`;
    }
    i = j + 1;
  }
  return rows;
}

export class ScoringRepo {
  constructor(private readonly db: Db) {}

  async holes(tournamentId: string): Promise<HoleRow[]> {
    return (await this.db.query<HoleRow>('SELECT number, par, yardage FROM holes WHERE tournament_id = $1 ORDER BY number', [tournamentId])).rows;
  }

  async setHoles(tournamentId: string, holes: HoleRow[]): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM holes WHERE tournament_id = $1', [tournamentId]);
      for (const h of holes) {
        await client.query('INSERT INTO holes (tournament_id, number, par, yardage) VALUES ($1, $2, $3, $4)', [
          tournamentId,
          h.number,
          h.par,
          h.yardage ?? null,
        ]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async players(tournamentId: string): Promise<PlayerRow[]> {
    return (
      await this.db.query<PlayerRow>(
        'SELECT * FROM players WHERE tournament_id = $1 ORDER BY group_no NULLS LAST, sort_order, name',
        [tournamentId],
      )
    ).rows;
  }

  async player(id: string): Promise<PlayerRow | null> {
    return (await this.db.query<PlayerRow>('SELECT * FROM players WHERE id = $1', [id])).rows[0] ?? null;
  }

  async addPlayers(
    tournamentId: string,
    list: { name: string; club?: string | null; category?: string | null; groupNo?: number | null }[],
  ): Promise<PlayerRow[]> {
    const out: PlayerRow[] = [];
    const base = Number(
      (await this.db.query<{ n: string }>('SELECT COALESCE(max(sort_order), 0)::text AS n FROM players WHERE tournament_id = $1', [tournamentId]))
        .rows[0].n,
    );
    let i = 0;
    for (const p of list) {
      out.push(
        (
          await this.db.query<PlayerRow>(
            `INSERT INTO players (tournament_id, name, club, category, group_no, sort_order) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [tournamentId, p.name.trim(), p.club ?? null, p.category ?? null, p.groupNo ?? null, base + ++i],
          )
        ).rows[0],
      );
    }
    return out;
  }

  async updatePlayer(id: string, patch: { name?: string; club?: string | null; category?: string | null; groupNo?: number | null }) {
    return (
      (
        await this.db.query<PlayerRow>(
          `UPDATE players SET
             name = COALESCE($2, name),
             club = CASE WHEN $3::boolean THEN $4 ELSE club END,
             category = CASE WHEN $5::boolean THEN $6 ELSE category END,
             group_no = CASE WHEN $7::boolean THEN $8::integer ELSE group_no END
           WHERE id = $1 RETURNING *`,
          [
            id,
            patch.name ?? null,
            patch.club !== undefined,
            patch.club ?? null,
            patch.category !== undefined,
            patch.category ?? null,
            patch.groupNo !== undefined,
            patch.groupNo ?? null,
          ],
        )
      ).rows[0] ?? null
    );
  }

  async deletePlayer(id: string): Promise<boolean> {
    return ((await this.db.query('DELETE FROM players WHERE id = $1', [id])).rowCount ?? 0) > 0;
  }

  async scores(tournamentId: string): Promise<ScoreRow[]> {
    return (await this.db.query<ScoreRow>('SELECT player_id, hole, strokes FROM scores WHERE tournament_id = $1', [tournamentId])).rows;
  }

  async setScore(tournamentId: string, playerId: string, hole: number, strokes: number | null, by: string): Promise<void> {
    if (strokes === null) {
      await this.db.query('DELETE FROM scores WHERE player_id = $1 AND hole = $2', [playerId, hole]);
      return;
    }
    await this.db.query(
      `INSERT INTO scores (tournament_id, player_id, hole, strokes, updated_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (player_id, hole) DO UPDATE SET strokes = EXCLUDED.strokes, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [tournamentId, playerId, hole, strokes, by],
    );
  }

  async leaderboard(tournamentId: string, category?: string | null) {
    const [players, holes, scores] = await Promise.all([this.players(tournamentId), this.holes(tournamentId), this.scores(tournamentId)]);
    return { holes, rows: computeLeaderboard(players, holes, scores, category), players };
  }
}

/** Parses "Name, Club, Category, Group" lines (CSV or tab separated; header optional). */
export function parsePlayerList(text: string): { name: string; club: string | null; category: string | null; groupNo: number | null }[] {
  const out: { name: string; club: string | null; category: string | null; groupNo: number | null }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = line.split(line.includes('\t') ? '\t' : ',').map((c) => c.trim().replace(/^"|"$/g, ''));
    if (!cells[0] || /^name$/i.test(cells[0])) continue;
    const group = cells[3] ? Number.parseInt(cells[3], 10) : NaN;
    out.push({
      name: cells[0].slice(0, 80),
      club: cells[1] ? cells[1].slice(0, 80) : null,
      category: cells[2] ? cells[2].slice(0, 40) : null,
      groupNo: Number.isFinite(group) ? group : null,
    });
  }
  return out;
}
