import { PLATFORM } from '../youtube.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';
import { ORG_ROLES, hashPassword, requireAuth, userOf } from '../auth.js';
import { requireOrg } from '../authz.js';

const uuid = z.string().uuid();

export function registerOrgRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, youtube, facebook } = ctx;
  const user = requireAuth(config, 'user');

  app.get('/api/orgs', { preHandler: user }, async (req) => {
    const u = userOf(req);
    return { orgs: (await repo.memberships(u.id)).map((m) => ({ id: m.org_id, name: m.org_name, role: m.role })) };
  });

  /** A signed-in user can start another club/organisation. */
  app.post('/api/orgs', { preHandler: user }, async (req, reply) => {
    const u = userOf(req);
    const body = z.object({ name: z.string().trim().min(2).max(100) }).parse(req.body);
    const org = await repo.tx(async (c) => {
      const o = await repo.createOrg(body.name, c);
      await repo.addMember(o.id, u.id, 'owner', c);
      return o;
    });
    reply.status(201);
    return { org: { id: org.id, name: org.name, role: 'owner' } };
  });

  app.get('/api/orgs/:id/members', { preHandler: user }, async (req) => {
    const orgId = uuid.parse((req.params as { id: string }).id);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    return {
      members: (await repo.members(orgId)).map((m) => ({ userId: m.user_id, email: m.email, name: m.name, role: m.role })),
    };
  });

  /**
   * Adds staff (directors, scorers, commentators...) by email. Existing accounts are added
   * directly; for new people the owner sets a first password and shares it.
   */
  app.post('/api/orgs/:id/members', { preHandler: user }, async (req, reply) => {
    const orgId = uuid.parse((req.params as { id: string }).id);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    const body = z
      .object({
        email: z.string().trim().email(),
        role: z.enum(ORG_ROLES),
        name: z.string().trim().min(1).max(80).optional(),
        password: z.string().min(8).max(200).optional(),
      })
      .parse(req.body);
    let u = await repo.userByEmail(body.email);
    let created = false;
    if (!u) {
      if (!body.name || !body.password) {
        throw new HttpError(400, 'new_user_details', 'No account with that email yet: give a name and a first password (8+ characters).');
      }
      u = await repo.createUser({ email: body.email, name: body.name, passwordHash: await hashPassword(body.password) });
      created = true;
    }
    await repo.addMember(orgId, u.id, body.role);
    reply.status(created ? 201 : 200);
    return { member: { userId: u.id, email: u.email, name: u.name, role: body.role }, created };
  });

  app.patch('/api/orgs/:id/members/:userId', { preHandler: user }, async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const orgId = uuid.parse(id);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    const body = z.object({ role: z.enum(ORG_ROLES) }).parse(req.body);
    const cur = await repo.memberRole(orgId, uuid.parse(userId));
    if (!cur) throw new HttpError(404, 'member_not_found', 'That person is not a member.');
    if (cur === 'owner' && body.role !== 'owner' && (await repo.ownerCount(orgId)) <= 1) {
      throw new HttpError(409, 'last_owner', 'An organisation needs at least one owner.');
    }
    await repo.addMember(orgId, userId, body.role);
    return { ok: true };
  });

  app.delete('/api/orgs/:id/members/:userId', { preHandler: user }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const orgId = uuid.parse(id);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    const cur = await repo.memberRole(orgId, uuid.parse(userId));
    if (cur === 'owner' && (await repo.ownerCount(orgId)) <= 1) throw new HttpError(409, 'last_owner', 'An organisation needs at least one owner.');
    await repo.removeMember(orgId, userId);
    reply.status(204);
    return null;
  });

  // ---------------------------------------------------------------- onboarding checklist (P1-12)
  /** The home-screen checklist: Account, Channel, Cameras, Test, Live. Hidden once live. */
  app.get('/api/orgs/:id/onboarding', { preHandler: user }, async (req) => {
    const orgId = uuid.parse((req.params as { id: string }).id);
    await requireOrg(repo, req.principal!, orgId, 'view');
    const o = (
      await repo.db.query<{ first_event_at: Date | null; first_camera_at: Date | null; first_test_at: Date | null; first_live_at: Date | null }>(
        'SELECT first_event_at, first_camera_at, first_test_at, first_live_at FROM orgs WHERE id = $1',
        [orgId],
      )
    ).rows[0];
    const own = youtube.enabled ? await repo.orgYoutube(orgId) : null;
    const fb = facebook.enabled ? await repo.orgFacebook(orgId) : null;
    const keyed = (
      await repo.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tournaments t WHERE t.org_id = $1 AND NOT t.archived
           AND ((t.yt_source = 'key' AND t.yt_stream_key_enc IS NOT NULL) OR t.yt_source = 'golive'
                OR EXISTS (SELECT 1 FROM event_destinations d WHERE d.tournament_id = t.id))`,
        [orgId],
      )
    ).rows[0];
    const golive = youtube.enabled && (await youtube.goliveAvailable());
    const steps = {
      account: true,
      channel: Boolean(own || fb?.page_id || Number(keyed.n) > 0 || golive),
      cameras: Boolean(o?.first_camera_at),
      test: Boolean(o?.first_test_at),
      live: Boolean(o?.first_live_at),
    };
    return { steps, hasEvent: Boolean(o?.first_event_at), done: steps.live };
  });

  // ---------------------------------------------------------------- YouTube
  app.get('/api/orgs/:id/youtube', { preHandler: user }, async (req) => {
    const orgId = uuid.parse((req.params as { id: string }).id);
    await requireOrg(repo, req.principal!, orgId, 'view');
    const row = youtube.enabled ? await repo.orgYoutube(orgId) : null;
    return {
      enabled: youtube.enabled,
      connected: Boolean(row),
      channelId: row?.channel_id ?? null,
      channelTitle: row?.channel_title ?? null,
      connectedAt: row?.connected_at ?? null,
    };
  });

  /** Returns the Google consent URL; the app opens it in the browser. */
  app.post('/api/orgs/:id/youtube/connect', { preHandler: user }, async (req) => {
    const orgId = uuid.parse((req.params as { id: string }).id);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    return { url: youtube.authUrl(orgId, userOf(req).id) };
  });

  app.delete('/api/orgs/:id/youtube', { preHandler: user }, async (req, reply) => {
    const orgId = uuid.parse((req.params as { id: string }).id);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    await youtube.disconnect(orgId);
    reply.status(204);
    return null;
  });

  /** Google redirects the browser here after consent. */
  app.get('/api/youtube/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    reply.type('text/html; charset=utf-8');
    const page = (title: string, text: string) =>
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,Roboto,sans-serif;background:#0b0e10;color:#fff;padding:32px;max-width:520px}h1{font-size:22px}p{color:#cdd6cf;line-height:1.5}</style>
</head><body><h1>${title}</h1><p>${text}</p></body></html>`;
    if (q.error || !q.code || !q.state) {
      reply.status(400);
      return page('YouTube was not connected', `Google said: ${(q.error ?? 'missing code').replace(/[<>&]/g, '')}. Go back to the app and try again.`);
    }
    try {
      const r = await youtube.completeConnect(q.code, q.state);
      const title = r.channelTitle.replace(/[<>&]/g, '');
      if (r.orgId === PLATFORM) {
        return page('Go Live channel connected', `Channel “${title}” is now the Go Live channel. New organisers can go live on it without connecting their own. Go back to Admin > Settings in the web app.`);
      }
      if (r.extra) {
        return page('YouTube channel added', `Channel “${title}” is connected as an extra channel. In the ${config.BRAND_NAME} app, add it to an event under Streaming platforms, then Add destination.`);
      }
      return page('YouTube connected', `Channel “${title}” is connected. Go back to the ${config.BRAND_NAME} app.`);
    } catch (err) {
      reply.status(err instanceof HttpError ? err.status : 500);
      return page('YouTube was not connected', (err as Error).message.replace(/[<>&]/g, ''));
    }
  });

  // ---------------------------------------------------------------- Facebook Page
  app.get('/api/orgs/:id/facebook', { preHandler: user }, async (req) => {
    const orgId = uuid.parse((req.params as { id: string }).id);
    await requireOrg(repo, req.principal!, orgId, 'view');
    return facebook.orgState(orgId);
  });

  /** Returns the Facebook Login URL; the app opens it in the browser. */
  app.post('/api/orgs/:id/facebook/connect', { preHandler: user }, async (req) => {
    const orgId = uuid.parse((req.params as { id: string }).id);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    return { url: facebook.authUrl(orgId, userOf(req).id) };
  });

  /** The connected account may manage several Pages: choose the one to stream to. */
  app.put('/api/orgs/:id/facebook/page', { preHandler: user }, async (req) => {
    const orgId = uuid.parse((req.params as { id: string }).id);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    const body = z.object({ pageId: z.string().min(1).max(64) }).parse(req.body);
    return facebook.selectPage(orgId, body.pageId);
  });

  app.delete('/api/orgs/:id/facebook', { preHandler: user }, async (req, reply) => {
    const orgId = uuid.parse((req.params as { id: string }).id);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    await facebook.disconnect(orgId);
    reply.status(204);
    return null;
  });

  /** Facebook redirects the browser here after login. */
  app.get('/api/facebook/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error_description?: string; error?: string };
    reply.type('text/html; charset=utf-8');
    if (q.error || !q.code || !q.state) {
      reply.status(400);
      return resultPage('Facebook was not connected', `Facebook said: ${(q.error_description ?? q.error ?? 'missing code').replace(/[<>&]/g, '')}. Go back to the app and try again.`);
    }
    try {
      const r = await facebook.completeConnect(q.code, q.state);
      return resultPage(
        'Facebook connected',
        `Connected as ${r.userName.replace(/[<>&]/g, '')} with ${r.pages} Page${r.pages === 1 ? '' : 's'}. ${r.pages > 1 ? 'Choose the Page to stream to in the app. ' : ''}Go back to the ${config.BRAND_NAME} app.`,
      );
    } catch (err) {
      reply.status(err instanceof HttpError ? err.status : 500);
      return resultPage('Facebook was not connected', (err as Error).message.replace(/[<>&]/g, ''));
    }
  });
}

function resultPage(title: string, text: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,Roboto,sans-serif;background:#0b0e10;color:#fff;padding:32px;max-width:520px}h1{font-size:22px}p{color:#cdd6cf;line-height:1.5}</style>
</head><body><h1>${title}</h1><p>${text}</p></body></html>`;
}
