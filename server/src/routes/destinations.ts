import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { requireAuth, userOf } from '../auth.js';
import { requireOrg, requireTournament } from '../authz.js';
import { HttpError } from '../errors.js';

const uuid = z.string().uuid();
const privacy = z.enum(['public', 'unlisted', 'private']);
const platform = z.enum(['youtube', 'facebook', 'instagram', 'other']);

/**
 * Several YouTube channels per organisation, and extra destinations per event:
 * the same show pushed to more YouTube channels, Facebook or Instagram accounts, or any RTMP service.
 */
export function registerDestinationRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, youtube, outputs, billing, hub } = ctx;
  const user = requireAuth(config, 'user');

  // ---------------------------------------------------------------- YouTube channels of an organisation
  app.get('/api/orgs/:id/youtube/channels', { preHandler: user }, async (req) => {
    const orgId = uuid.parse((req.params as { id: string }).id);
    await requireOrg(repo, req.principal!, orgId, 'view');
    return { enabled: youtube.enabled, channels: youtube.enabled ? await youtube.channels(orgId) : [] };
  });

  /** Google consent URL for connecting one more channel (the main channel stays as it is). */
  app.post('/api/orgs/:id/youtube/channels/connect', { preHandler: user }, async (req) => {
    const orgId = uuid.parse((req.params as { id: string }).id);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    return { url: youtube.authUrl(orgId, userOf(req).id, true) };
  });

  app.delete('/api/orgs/:id/youtube/channels/:channelId', { preHandler: user }, async (req, reply) => {
    const p = req.params as { id: string; channelId: string };
    const orgId = uuid.parse(p.id);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    await youtube.disconnectChannel(orgId, uuid.parse(p.channelId));
    reply.status(204);
    return null;
  });

  // ---------------------------------------------------------------- extra destinations of an event
  const changed = async (tid: string) => {
    await hub.outputsUpdated(tid);
    const fresh = (await repo.tournamentById(tid))!;
    return { outputs: await outputs.state(fresh), billing: await billing.tournamentState(fresh) };
  };

  app.get('/api/tournaments/:id/destinations', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, uuid.parse((req.params as { id: string }).id), 'direct');
    return { outputs: await outputs.state(t), billing: await billing.tournamentState(t) };
  });

  app.post('/api/tournaments/:id/destinations', { preHandler: user }, async (req, reply) => {
    const { t } = await requireTournament(repo, req.principal!, uuid.parse((req.params as { id: string }).id), 'direct');
    const body = z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('channel'), channelId: z.string().uuid(), privacy: privacy.optional(), label: z.string().trim().max(80).optional() }),
        z.object({
          kind: z.literal('key'),
          platform,
          streamUrl: z.string().trim().max(500).optional(),
          streamKey: z.string().trim().min(1, 'Paste the stream key').max(500),
          label: z.string().trim().max(80).optional(),
          vertical: z.boolean().optional(),
        }),
      ])
      .parse(req.body);
    const d = await outputs.addDestination(t, body);
    reply.status(201);
    return { destinationId: d.id, ...(await changed(t.id)) };
  });

  app.patch('/api/tournaments/:id/destinations/:destId', { preHandler: user }, async (req) => {
    const p = req.params as { id: string; destId: string };
    const { t } = await requireTournament(repo, req.principal!, uuid.parse(p.id), 'direct');
    const body = z
      .object({
        enabled: z.boolean().optional(),
        label: z.string().trim().max(80).optional(),
        streamUrl: z.string().trim().max(500).optional(),
        streamKey: z.string().trim().min(1).max(500).optional(),
        vertical: z.boolean().optional(),
        privacy: privacy.optional(),
      })
      .parse(req.body);
    await outputs.updateDestination(t, uuid.parse(p.destId), body);
    return changed(t.id);
  });

  app.delete('/api/tournaments/:id/destinations/:destId', { preHandler: user }, async (req) => {
    const p = req.params as { id: string; destId: string };
    const { t } = await requireTournament(repo, req.principal!, uuid.parse(p.id), 'direct');
    await outputs.removeDestination(t, uuid.parse(p.destId));
    return changed(t.id);
  });

  /** Buys extra destinations for this event (credits from the club wallet). */
  app.post('/api/tournaments/:id/billing/destinations', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, uuid.parse((req.params as { id: string }).id), 'manage');
    const body = z.object({ count: z.number().int().min(1).max(20) }).parse(req.body);
    if (!billing.enabled) throw new HttpError(409, 'billing_off', 'Destination limits are not used on this server.');
    const state = await billing.buyDestinations(t, body.count, userOf(req).email);
    hub.billingChanged(t.id, state);
    return { billing: state };
  });
}
