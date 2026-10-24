import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';
import { requireAuth } from '../auth.js';
import { requireTournament } from '../authz.js';
import { applyGraphicsPatch } from '../graphics.js';
import { constantTimeEqual } from '../crypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = [path.resolve(here, '../../public'), path.resolve(here, '../../../public')].find((p) => fs.existsSync(p));

export function registerGraphicsRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, graphics } = ctx;
  const any = requireAuth(config);

  app.get('/api/tournaments/:id/graphics', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, z.string().uuid().parse((req.params as { id: string }).id), 'view');
    return { graphics: await graphics.get(t.id) };
  });

  app.patch('/api/tournaments/:id/graphics', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, z.string().uuid().parse((req.params as { id: string }).id), 'direct');
    const body = z.record(z.string(), z.unknown()).parse(req.body);
    const next = await graphics.update(t.id, (cur) => applyGraphicsPatch(cur, body));
    return { graphics: next };
  });

  /** Read-only access for the overlay page (OBS Browser Source) using the tournament's graphics key. */
  const byKey = async (tournamentId: string, key: string | undefined) => {
    const t = z.string().uuid().safeParse(tournamentId).success ? await repo.tournamentById(tournamentId) : null;
    if (!t || !key || !constantTimeEqual(key, t.graphics_key)) throw new HttpError(403, 'bad_graphics_key', 'Invalid graphics link.');
    return t;
  };

  app.get('/graphics/:tid', async (req, reply) => {
    await byKey((req.params as { tid: string }).tid, (req.query as { k?: string }).k);
    if (!publicDir) throw new HttpError(500, 'missing_assets', 'Graphics page assets are missing.');
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    return reply.send(fs.readFileSync(path.join(publicDir, 'graphics.html')));
  });

  app.get('/api/graphics/:tid/state', async (req) => {
    const t = await byKey((req.params as { tid: string }).tid, (req.query as { k?: string }).k);
    return graphics.payload(t);
  });

  /** Server-Sent Events: one message with the full overlay state on every change. */
  app.get('/api/graphics/:tid/events', async (req, reply) => {
    const t = await byKey((req.params as { tid: string }).tid, (req.query as { k?: string }).k);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(`retry: 2000\n\ndata: ${JSON.stringify(await graphics.payload(t))}\n\n`);
    graphics.attach(t.id, reply);
    const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 20_000);
    reply.raw.on('close', () => clearInterval(keepAlive));
  });
}
