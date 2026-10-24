import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';
import { principalKey, requireAuth } from '../auth.js';
import { requireTournament } from '../authz.js';
import { parsePlayerList } from '../scoring.js';

const uuid = z.string().uuid();
const tid = (req: { params: unknown }) => uuid.parse((req.params as { id: string }).id);

// Standard par-72 layout used when an organiser does not enter the card hole by hole.
const PAR72 = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 4, 3, 5, 4, 4, 3, 4, 5];

export function registerScoringRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, scoring, hub } = ctx;
  const any = requireAuth(config);

  const playerDto = (p: { id: string; name: string; club: string | null; category: string | null; group_no: number | null }) => ({
    id: p.id,
    name: p.name,
    club: p.club,
    category: p.category,
    groupNo: p.group_no,
  });

  app.get('/api/tournaments/:id/holes', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'view');
    return { holes: await scoring.holes(t.id) };
  });

  app.put('/api/tournaments/:id/holes', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    const body = z
      .union([
        z.object({ preset: z.literal('par72') }),
        z.object({
          holes: z
            .array(z.object({ number: z.number().int().min(1).max(36), par: z.number().int().min(3).max(6), yardage: z.number().int().min(1).max(999).nullish() }))
            .min(1)
            .max(36),
        }),
      ])
      .parse(req.body);
    const holes =
      'preset' in body
        ? PAR72.map((par, i) => ({ number: i + 1, par, yardage: null }))
        : body.holes.map((h) => ({ number: h.number, par: h.par, yardage: h.yardage ?? null }));
    if (new Set(holes.map((h) => h.number)).size !== holes.length) throw new HttpError(400, 'duplicate_hole', 'Each hole number may appear once.');
    await scoring.setHoles(t.id, holes);
    await hub.leaderboardChanged(t.id);
    return { holes: await scoring.holes(t.id) };
  });

  app.get('/api/tournaments/:id/players', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'view');
    return { players: (await scoring.players(t.id)).map(playerDto) };
  });

  /** Add players as a list, or paste "Name, Club, Category, Group" lines (CSV export from a sheet). */
  app.post('/api/tournaments/:id/players', { preHandler: any }, async (req, reply) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    const body = z
      .union([
        z.object({ csv: z.string().min(1).max(200_000) }),
        z.object({
          players: z
            .array(
              z.object({
                name: z.string().trim().min(1).max(80),
                club: z.string().trim().max(80).nullish(),
                category: z.string().trim().max(40).nullish(),
                groupNo: z.number().int().min(1).max(500).nullish(),
              }),
            )
            .min(1)
            .max(1000),
        }),
      ])
      .parse(req.body);
    const list = 'csv' in body ? parsePlayerList(body.csv) : body.players;
    if (!list.length) throw new HttpError(400, 'no_players', 'No player names found.');
    const added = await scoring.addPlayers(t.id, list);
    await hub.leaderboardChanged(t.id);
    reply.status(201);
    return { players: added.map(playerDto) };
  });

  app.patch('/api/players/:id', { preHandler: any }, async (req) => {
    const p = await scoring.player(uuid.parse((req.params as { id: string }).id));
    if (!p) throw new HttpError(404, 'player_not_found', 'Player not found.');
    await requireTournament(repo, req.principal!, p.tournament_id, 'manage');
    const body = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        club: z.string().trim().max(80).nullable().optional(),
        category: z.string().trim().max(40).nullable().optional(),
        groupNo: z.number().int().min(1).max(500).nullable().optional(),
      })
      .parse(req.body);
    const updated = await scoring.updatePlayer(p.id, body);
    await hub.leaderboardChanged(p.tournament_id);
    return { player: playerDto(updated!) };
  });

  app.delete('/api/players/:id', { preHandler: any }, async (req, reply) => {
    const p = await scoring.player(uuid.parse((req.params as { id: string }).id));
    if (!p) throw new HttpError(404, 'player_not_found', 'Player not found.');
    await requireTournament(repo, req.principal!, p.tournament_id, 'manage');
    await scoring.deletePlayer(p.id);
    await hub.leaderboardChanged(p.tournament_id);
    reply.status(204);
    return null;
  });

  /** A scorer enters (or clears with null) one player's strokes on one hole. */
  app.put('/api/tournaments/:id/scores', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'score');
    const body = z
      .object({ playerId: uuid, hole: z.number().int().min(1).max(36), strokes: z.number().int().min(1).max(20).nullable() })
      .parse(req.body);
    const player = await scoring.player(body.playerId);
    if (!player || player.tournament_id !== t.id) throw new HttpError(404, 'player_not_found', 'Player not found in this tournament.');
    const holes = await scoring.holes(t.id);
    if (holes.length && !holes.some((h) => h.number === body.hole)) throw new HttpError(400, 'unknown_hole', `This course has no hole ${body.hole}.`);
    await scoring.setScore(t.id, body.playerId, body.hole, body.strokes, `${principalKey(req.principal!)} ${req.principal!.name}`);
    await hub.leaderboardChanged(t.id);
    const { rows } = await scoring.leaderboard(t.id);
    return { player: rows.find((r) => r.playerId === body.playerId) };
  });

  app.get('/api/tournaments/:id/leaderboard', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'view');
    const category = (req.query as { category?: string }).category || null;
    const { rows, holes } = await scoring.leaderboard(t.id, category);
    return { holes, rows };
  });
}
