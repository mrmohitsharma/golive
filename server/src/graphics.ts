import type { FastifyReply } from 'fastify';
import type { Repo, TournamentRow } from './repo.js';
import type { ScoringRepo, LeaderboardRow } from './scoring.js';
import { DEFAULT_PAR } from './scoring.js';
import { defaultGraphics, type GraphicsState } from './protocol.js';

export function mergeGraphics(stored: unknown): GraphicsState {
  const d = defaultGraphics();
  const s = (stored ?? {}) as Partial<GraphicsState>;
  return {
    lowerThird: { ...d.lowerThird, ...(s.lowerThird ?? {}) },
    holeCard: { ...d.holeCard, ...(s.holeCard ?? {}) },
    leaderboard: { ...d.leaderboard, ...(s.leaderboard ?? {}) },
    scoreBug: { ...d.scoreBug, ...(s.scoreBug ?? {}) },
    question: { ...d.question, ...(s.question ?? {}) },
    replay: Boolean(s.replay),
  };
}

/** Deep-merges a director's partial update, ignoring unknown keys and wrong types. */
export function applyGraphicsPatch(cur: GraphicsState, patch: Record<string, unknown>): GraphicsState {
  const next = structuredClone(cur);
  const section = <K extends keyof GraphicsState>(k: K) => (patch[k] && typeof patch[k] === 'object' ? (patch[k] as Record<string, unknown>) : null);
  const lt = section('lowerThird');
  if (lt) {
    if (typeof lt.visible === 'boolean') next.lowerThird.visible = lt.visible;
    if (lt.playerId === null || typeof lt.playerId === 'string') next.lowerThird.playerId = lt.playerId as string | null;
    if (typeof lt.title === 'string') next.lowerThird.title = lt.title.slice(0, 60);
    if (typeof lt.subtitle === 'string') next.lowerThird.subtitle = lt.subtitle.slice(0, 80);
  }
  const hc = section('holeCard');
  if (hc) {
    if (typeof hc.auto === 'boolean') next.holeCard.auto = hc.auto;
    if (typeof hc.visible === 'boolean') next.holeCard.visible = hc.visible;
    if (hc.hole === null || (typeof hc.hole === 'number' && hc.hole >= 1 && hc.hole <= 36)) next.holeCard.hole = hc.hole as number | null;
    if (typeof hc.durationSec === 'number') next.holeCard.durationSec = Math.min(60, Math.max(2, Math.round(hc.durationSec)));
  }
  const lb = section('leaderboard');
  if (lb) {
    if (typeof lb.visible === 'boolean') next.leaderboard.visible = lb.visible;
    if (typeof lb.size === 'number') next.leaderboard.size = Math.min(15, Math.max(3, Math.round(lb.size)));
    if (lb.category === null || typeof lb.category === 'string') next.leaderboard.category = (lb.category as string | null) || null;
  }
  const sb = section('scoreBug');
  if (sb && typeof sb.visible === 'boolean') next.scoreBug.visible = sb.visible;
  const q = section('question');
  if (q && typeof q.visible === 'boolean') next.question.visible = q.visible;
  return next;
}

export interface OnAirInfo {
  cameraName: string | null;
  hole: number | null;
}

/**
 * Graphics overlay state and its live feed. The overlay is a web page (OBS Browser Source,
 * 1920x1080, transparent) that listens to Server-Sent Events from here, so a director's
 * tap, a new score or a cut updates the broadcast in about a second.
 */
export class GraphicsService {
  private streams = new Map<string, Set<FastifyReply>>();
  private holeTimers = new Map<string, NodeJS.Timeout>();
  private lastOnAir = new Map<string, OnAirInfo>();

  constructor(
    private readonly repo: Repo,
    private readonly scoring: ScoringRepo,
    private readonly onChange: (tournamentId: string, g: GraphicsState) => void,
  ) {}

  async get(tournamentId: string): Promise<GraphicsState> {
    const t = await this.repo.tournamentById(tournamentId);
    return mergeGraphics(t?.graphics);
  }

  async update(tournamentId: string, fn: (g: GraphicsState) => GraphicsState): Promise<GraphicsState> {
    const cur = await this.get(tournamentId);
    const next = fn(cur);
    await this.repo.setTournamentJson(tournamentId, 'graphics', next);
    this.onChange(tournamentId, next);
    await this.publish(tournamentId);
    return next;
  }

  /** Builds everything the overlay page needs, already formatted. */
  async payload(t: TournamentRow) {
    const g = mergeGraphics(t.graphics);
    const { rows, holes, players } = await this.scoring.leaderboard(t.id, g.leaderboard.category);
    const onAir = this.lastOnAir.get(t.id) ?? { cameraName: null, hole: null };
    let lowerThird: null | { title: string; subtitle: string; position?: string; toPar?: string; thru?: string } = null;
    if (g.lowerThird.visible) {
      const row = g.lowerThird.playerId ? rows.find((r) => r.playerId === g.lowerThird.playerId) : undefined;
      const player = g.lowerThird.playerId ? players.find((p) => p.id === g.lowerThird.playerId) : undefined;
      if (row || player) {
        const r = row ?? (await this.scoring.leaderboard(t.id)).rows.find((x) => x.playerId === g.lowerThird.playerId);
        lowerThird = {
          title: player?.name ?? r?.name ?? '',
          subtitle: [player?.club, player?.category].filter(Boolean).join(' · '),
          position: r?.position || undefined,
          toPar: r?.toParText,
          thru: r ? (r.thru === 'F' ? 'F' : r.thru === '–' ? '' : `THRU ${r.thru}`) : undefined,
        };
      } else if (g.lowerThird.title) {
        lowerThird = { title: g.lowerThird.title, subtitle: g.lowerThird.subtitle };
      }
    }
    let holeCard: null | { hole: number; par: number; yardage: number | null; average: string | null } = null;
    if (g.holeCard.visible && g.holeCard.hole) {
      const h = holes.find((x) => x.number === g.holeCard.hole);
      const all = await this.scoring.scores(t.id);
      const onHole = all.filter((s) => s.hole === g.holeCard.hole);
      const avg = onHole.length >= 3 ? (onHole.reduce((a, s) => a + s.strokes, 0) / onHole.length).toFixed(2) : null;
      holeCard = { hole: g.holeCard.hole, par: h?.par ?? DEFAULT_PAR, yardage: h?.yardage ?? null, average: avg };
    }
    const question = g.question.visible && g.question.text ? { author: g.question.author, source: g.question.source, text: g.question.text } : null;
    if (question) lowerThird = null;
    const leader = rows.find((r) => r.position);
    return {
      tournament: { name: t.name, venue: t.venue },
      scoreBug: g.scoreBug.visible
        ? { leader: leader ? { name: shortName(leader.name), toPar: leader.toParText, thru: leader.thru } : null, onAirHole: onAir.hole }
        : null,
      lowerThird,
      question,
      holeCard,
      leaderboard: g.leaderboard.visible
        ? {
            title: g.leaderboard.category ? `LEADERBOARD · ${g.leaderboard.category.toUpperCase()}` : 'LEADERBOARD',
            rows: rows.filter((r) => r.position).slice(0, g.leaderboard.size).map(slimRow),
          }
        : null,
      replay: g.replay,
      updatedAt: new Date().toISOString(),
    };
  }

  attach(tournamentId: string, reply: FastifyReply) {
    let set = this.streams.get(tournamentId);
    if (!set) this.streams.set(tournamentId, (set = new Set()));
    set.add(reply);
    reply.raw.on('close', () => set!.delete(reply));
  }

  async publish(tournamentId: string): Promise<void> {
    const set = this.streams.get(tournamentId);
    if (!set || set.size === 0) return;
    const t = await this.repo.tournamentById(tournamentId);
    if (!t) return;
    const data = `data: ${JSON.stringify(await this.payload(t))}\n\n`;
    for (const r of set) r.raw.write(data);
  }

  /** Called on every confirmed programme change. Shows the hole card for the new camera's hole. */
  async onProgramme(tournamentId: string, info: OnAirInfo): Promise<void> {
    const prev = this.lastOnAir.get(tournamentId);
    this.lastOnAir.set(tournamentId, info);
    if (prev && prev.cameraName === info.cameraName && prev.hole === info.hole) return;
    const g = await this.get(tournamentId);
    if (!g.holeCard.auto || !info.hole) {
      await this.publish(tournamentId);
      return;
    }
    await this.update(tournamentId, (cur) => ({ ...cur, holeCard: { ...cur.holeCard, visible: true, hole: info.hole } }));
    clearTimeout(this.holeTimers.get(tournamentId));
    this.holeTimers.set(
      tournamentId,
      setTimeout(() => {
        void this.update(tournamentId, (cur) => (cur.holeCard.hole === info.hole ? { ...cur, holeCard: { ...cur.holeCard, visible: false } } : cur)).catch(
          () => {},
        );
      }, g.holeCard.durationSec * 1000),
    );
  }

  async setReplay(tournamentId: string, on: boolean) {
    const g = await this.get(tournamentId);
    if (g.replay === on) return;
    await this.update(tournamentId, (cur) => ({ ...cur, replay: on }));
  }

  close() {
    for (const t of this.holeTimers.values()) clearTimeout(t);
    for (const set of this.streams.values()) for (const r of set) r.raw.end();
  }
}

function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : name;
}

function slimRow(r: LeaderboardRow) {
  return { position: r.position, name: shortName(r.name), toPar: r.toParText, thru: r.thru };
}
