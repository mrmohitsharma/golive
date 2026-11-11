import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { requireAuth } from '../auth.js';
import { requireTournament } from '../authz.js';
import { HttpError } from '../errors.js';
import { patchSwitching } from '../switching.js';

const uuid = z.string().uuid();
const pid = (req: FastifyRequest, k = 'id') => uuid.parse((req.params as Record<string, string>)[k]);

/**
 * V9 camera switching in the control room: auto switch (round-robin or main camera, every N
 * seconds), the transition for every switch (Fade or Slide), and remote zoom, brightness and
 * focus of a camera phone.
 */
export function registerSwitchingRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, hub } = ctx;
  const any = requireAuth(config);

  app.get('/api/tournaments/:id/switching', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, pid(req), 'direct');
    return { switching: await hub.switchingView(t.id) };
  });

  app.patch('/api/tournaments/:id/switching', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, pid(req), 'direct');
    const body = z.record(z.string(), z.unknown()).parse(req.body);
    const next = patchSwitching(await hub.switching(t.id), body);
    if (next.auto.mainCameraId) {
      const cam = await repo.cameraById(next.auto.mainCameraId);
      if (!cam || cam.tournament_id !== t.id) throw new HttpError(400, 'bad_camera', 'Pick one of this event\'s cameras as the main camera.');
    }
    if (next.auto.on && next.auto.mode === 'main' && !next.auto.mainCameraId) throw new HttpError(400, 'main_camera', 'Pick the main camera first.');
    await repo.db.query('UPDATE tournaments SET switching = $2 WHERE id = $1', [t.id, JSON.stringify(next)]);
    hub.setSwitching(t.id, next);
    return { switching: await hub.switchingView(t.id) };
  });

  /** Zoom (×), brightness (exposure steps) or focus (auto / lock) on one camera phone. */
  app.post('/api/tournaments/:id/cameras/:cid/adjust', { preHandler: any, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, pid(req), 'direct');
    const cid = pid(req, 'cid');
    const b = z.object({ zoom: z.number().min(0.1).max(200).optional(), ev: z.number().min(-20).max(20).optional(), focus: z.enum(['auto', 'lock']).optional() }).parse(req.body);
    if (b.zoom == null && b.ev == null && !b.focus) throw new HttpError(400, 'nothing_to_change', 'Send zoom, ev or focus.');
    // No camera read: the hub only reaches a phone joined to this camera in this event.
    if (!hub.adjustCamera(t.id, cid, b)) throw new HttpError(409, 'camera_offline', 'This camera is not connected to the app right now.');
    return { ok: true };
  });
}
