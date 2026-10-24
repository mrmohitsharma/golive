import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';
import { bearerFrom, principalKey, requireAuth } from '../auth.js';
import { can, requireTournament, roleInTournament } from '../authz.js';
import { chatPublicDto, chatStaffDto } from '../chat.js';
import type { TournamentRow } from '../repo.js';

const uuid = z.string().uuid();
const idParam = (req: { params: unknown }) => uuid.parse((req.params as { id: string }).id);
const cursor = z.object({ after: z.coerce.number().int().min(0).default(0), v: z.coerce.number().int().optional() });

/**
 * Viewer comments. Public (watch page, no account, a name only): read and post.
 * Staff (commentators read; directors also moderate and put questions on air).
 */
export function registerChatRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, chat, graphics } = ctx;
  const any = requireAuth(config);

  const publicTournament = async (id: string): Promise<TournamentRow> => {
    const t = await repo.tournamentById(id);
    if (!t || t.archived || t.public_watch === false) throw new HttpError(404, 'not_found', 'This tournament is not available.');
    return t;
  };

  // ---------------------------------------------------------------- public
  app.get('/api/public/tournaments/:id/chat', async (req, reply) => {
    const t = await publicTournament(idParam(req));
    const q = cursor.parse(req.query);
    reply.header('Cache-Control', 'no-store');
    return chat.publicView(t, q.after, q.v ?? null);
  });

  app.post('/api/public/tournaments/:id/chat/name', async (req, reply) => {
    const t = await publicTournament(idParam(req));
    const body = z.object({ name: z.string().max(60) }).parse(req.body);
    reply.status(201);
    return chat.viewerToken(t, body.name, req.ip);
  });

  app.post('/api/public/tournaments/:id/chat', async (req, reply) => {
    const t = await publicTournament(idParam(req));
    const body = z.object({ text: z.string().max(500) }).parse(req.body);
    const row = await chat.post(t, bearerFrom(req), body.text, req.ip);
    reply.status(201);
    return { message: chatPublicDto(row) };
  });

  // ---------------------------------------------------------------- staff
  app.get('/api/tournaments/:id/chat', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, idParam(req), 'watch');
    const q = cursor.parse(req.query);
    return chat.staffView(t, q.v ?? null);
  });

  const message = async (req: { params: unknown; principal?: import('../auth.js').Principal }) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const row = await chat.byId(id);
    if (!row) throw new HttpError(404, 'message_not_found', 'Message not found.');
    const t = (await repo.tournamentById(row.tournament_id))!;
    const role = await roleInTournament(repo, req.principal!, t);
    if (!can(role, 'watch')) throw new HttpError(404, 'message_not_found', 'Message not found.');
    return { row, t, direct: can(role, 'direct') };
  };

  /** Commentators mark questions answered; directors also hide and pin (pinned shows on the watch page). */
  app.patch('/api/chat/:id', { preHandler: any }, async (req) => {
    const { row, direct } = await message(req);
    const body = z.object({ hidden: z.boolean().optional(), pinned: z.boolean().optional(), answered: z.boolean().optional() }).parse(req.body);
    if ((body.hidden !== undefined || body.pinned !== undefined) && !direct) throw new HttpError(403, 'forbidden', 'Only directors can hide or pin messages.');
    return { message: chatStaffDto(await chat.update(row, body)) };
  });

  app.post('/api/chat/:id/ban', { preHandler: any }, async (req) => {
    const { row, direct } = await message(req);
    if (!direct) throw new HttpError(403, 'forbidden', 'Only directors can block viewers.');
    return { hidden: await chat.ban(row, principalKey(req.principal!)) };
  });

  /** Puts the question on air as the "Viewer question" graphic, or takes it off. */
  app.post('/api/chat/:id/on-air', { preHandler: any }, async (req) => {
    const { row, t, direct } = await message(req);
    if (!direct) throw new HttpError(403, 'forbidden', 'Only directors can change graphics.');
    const body = z.object({ visible: z.boolean().default(true) }).parse(req.body ?? {});
    const g = await graphics.update(t.id, (cur) => ({
      ...cur,
      question: body.visible ? { visible: true, author: row.author, source: row.source, text: row.text } : { ...cur.question, visible: false },
    }));
    if (body.visible) await chat.update(row, { answered: true });
    return { graphics: g };
  });
}
