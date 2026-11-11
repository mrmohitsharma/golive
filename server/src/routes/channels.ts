import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import type { ChannelRow, ChannelService } from '../channels.js';
import { channelLogoUrl, lookOf, RESERVED } from '../channels.js';
import { requireAuth } from '../auth.js';
import { requireOrg, requireTournament } from '../authz.js';
import { HttpError } from '../errors.js';
import { THEMES } from '../branding.js';
import { sniff } from './branding.js';
import { esc, page } from './billing.js';

const uuid = z.string().uuid();
const pid = (req: FastifyRequest) => uuid.parse((req.params as { id: string }).id);
const publicDir = [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public'), path.resolve(process.cwd(), 'public')].find((d) => fs.existsSync(path.join(d, 'watch.html')));

/**
 * V9 brand channels: <slug>.gogetslive.com and /c/<slug> (channel page), /<event> under it (the
 * event's watch page), follow and unfollow links, and the club's Brand page settings.
 */
export function registerChannelRoutes(app: FastifyInstance, ctx: Ctx & { channels: ChannelService }) {
  const { config, repo, channels } = ctx;
  const user = requireAuth(config, 'user');
  const any = requireAuth(config);
  const domain = config.CHANNEL_DOMAIN.toLowerCase();
  const logoDir = path.join(config.MEDIA_DIR, 'branding');

  // Page templates are read once in production (every request in development, for quick edits).
  const files = new Map<string, string>();
  const read = (f: string) => {
    const hit = process.env.NODE_ENV === 'production' ? files.get(f) : undefined;
    if (hit) return hit;
    const text = fs.readFileSync(path.join(publicDir!, f), 'utf8');
    files.set(f, text);
    return text;
  };

  /** The channel page, with its title and share tags filled in for search engines and WhatsApp. */
  const sendChannel = async (reply: FastifyReply, c: ChannelRow) => {
    const look = lookOf(c);
    const url = channels.url(c.slug);
    const logo = channelLogoUrl(look);
    const head = [
      `<title>${esc(c.name)} · live and replays</title>`,
      `<meta name="description" content="${esc(c.description || `Watch ${c.name} live, and every past event.`)}">`,
      `<link rel="canonical" href="${esc(url)}">`,
      `<meta property="og:title" content="${esc(c.name)}">`,
      `<meta property="og:description" content="${esc(c.description || `Live broadcasts and replays from ${c.name}.`)}">`,
      `<meta property="og:url" content="${esc(url)}">`,
      logo ? `<meta property="og:image" content="${esc(channels.base + logo)}">` : '',
      c.public ? '' : '<meta name="robots" content="noindex">',
      `<script>window.GL_CHANNEL=${JSON.stringify(c.slug)};window.GL_CHANNEL_BASE=${JSON.stringify(reply.request.url.startsWith('/c/') ? `/c/${c.slug}` : '')};</script>`,
    ].join('');
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'public, max-age=30');
    return reply.send(read('channel.html').replace('<!--HEAD-->', head));
  };

  /** An event under its channel: the watch page, told which event and channel it is. */
  const sendEvent = async (reply: FastifyReply, c: ChannelRow, key: string) => {
    const id = uuid.safeParse(key).success ? key : (await repo.db.query<{ id: string }>('SELECT id FROM tournaments WHERE watch_slug = $1 AND org_id = $2', [key.toLowerCase(), c.org_id])).rows[0]?.id;
    const t = id ? await repo.tournamentById(id) : null;
    if (!t || t.org_id !== c.org_id || t.archived || !t.public_watch) return null;
    const html = read('watch.html').replace('<head>', `<head><script>window.GL_TID=${JSON.stringify(t.id)};</script><link rel="canonical" href="${esc(channels.url(c.slug) + channels.eventPath(t))}">`);
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'public, max-age=60');
    return reply.send(html);
  };

  // ---------------------------------------------------------------- <slug>.gogetslive.com
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return;
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim().split(':')[0].toLowerCase();
    if (!host.endsWith('.' + domain)) return;
    const label = host.slice(0, -(domain.length + 1));
    if (!label || label.includes('.') || RESERVED.has(label)) return;
    const p = req.url.split('?')[0];
    const m = /^\/([A-Za-z0-9-]{1,64})\/?$/.exec(p);
    if (p !== '/' && !m) return;
    const c = await channels.bySlug(label);
    if (!c) {
      if (p === '/') return page(reply.status(404), 'Not found', `<h1>No channel here</h1><p class="sub">There is no channel called “${esc(label)}”.</p><p><a style="color:#c9a227" href="${esc(channels.base)}">Go to ${esc(config.BRAND_NAME)}</a></p>`);
      return;
    }
    if (p === '/') return sendChannel(reply, c);
    const sent = await sendEvent(reply, c, m![1]);
    if (sent) return sent;
  });

  // ---------------------------------------------------------------- /c/<slug> (no DNS needed)
  app.get('/c/:slug', async (req, reply) => {
    const c = await channels.bySlug(String((req.params as { slug: string }).slug));
    if (!c) return page(reply.status(404), 'Not found', '<h1>Channel not found</h1>');
    return sendChannel(reply, c);
  });
  app.get('/c/:slug/:event', async (req, reply) => {
    const prm = req.params as { slug: string; event: string };
    const c = await channels.bySlug(prm.slug);
    if (!c) return page(reply.status(404), 'Not found', '<h1>Channel not found</h1>');
    const sent = await sendEvent(reply, c, prm.event);
    return sent ?? page(reply.status(404), 'Not found', '<h1>Event not found</h1>');
  });

  // ---------------------------------------------------------------- public API
  app.get('/api/public/channels/:slug', async (req, reply) => {
    const v = await channels.publicBySlug(String((req.params as { slug: string }).slug).slice(0, 40));
    if (!v) throw new HttpError(404, 'channel_not_found', 'Channel not found.');
    reply.header('Cache-Control', 'public, max-age=10');
    return v;
  });

  app.post('/api/public/channels/:slug/follow', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const c = await channels.bySlug(String((req.params as { slug: string }).slug));
    if (!c) throw new HttpError(404, 'channel_not_found', 'Channel not found.');
    const b = z.object({ email: z.string().max(200) }).parse(req.body);
    await channels.follow(c, b.email);
    return { ok: true };
  });

  app.get('/follow/:token', async (req, reply) => {
    const c = await channels.confirmFollow(String((req.params as { token: string }).token).slice(0, 60));
    if (!c) return page(reply.status(404), 'Follow', '<h1>Link not valid</h1><p class="sub">Follow the channel again from its page.</p>');
    return page(reply, 'Following', `<h1>You follow ${esc(c.name)}</h1><p class="sub">We will email you when it goes live, and an hour before scheduled events.</p><p><a style="color:#c9a227" href="${esc(channels.url(c.slug))}">Open the channel</a></p>`);
  });

  app.get('/unfollow/:token', async (req, reply) => {
    const c = await channels.unfollow(String((req.params as { token: string }).token).slice(0, 60));
    return page(reply, 'Unfollowed', c ? `<h1>Unfollowed ${esc(c.name)}</h1><p class="sub">You will not get its emails any more.</p>` : '<h1>Already unfollowed</h1>');
  });

  // ---------------------------------------------------------------- the club's Brand page settings
  const clubView = async (orgId: string) => {
    const c = await channels.byOrg(orgId);
    const evs = (await repo.db.query<{ id: string; name: string; channel_hidden: boolean; series: string | null; starts_at: Date | null; starts_on: string | null; public_watch: boolean; first_live_at: Date | null; watch_slug: string | null }>(
      'SELECT id, name, channel_hidden, series, starts_at, starts_on, public_watch, first_live_at, watch_slug FROM tournaments WHERE org_id = $1 AND NOT archived ORDER BY created_at DESC LIMIT 300',
      [orgId],
    )).rows;
    const look = c ? lookOf(c) : null;
    return {
      channel: c && { slug: c.slug, name: c.name, description: c.description, public: c.public, featuredTournamentId: c.featured_tournament_id, look: look && { ...look, logoUrl: channelLogoUrl(look) }, url: channels.url(c.slug), pathUrl: `${channels.base}/c/${c.slug}` },
      followers: c ? await channels.followerCount(c.id) : { verified: 0, pending: 0 },
      domain,
      themes: THEMES.map((t) => ({ id: t.id, label: t.label, group: t.group, accent: t.accent, bg: t.bg, panel2: t.panel2 })),
      events: evs.map((t) => ({ id: t.id, name: t.name, hidden: t.channel_hidden, series: t.series, startsAt: t.starts_at?.toISOString() ?? null, startsOn: t.starts_on, publicWatch: t.public_watch, live: channels.isLive(t.id), wentLive: Boolean(t.first_live_at), path: `/${t.watch_slug || t.id}` })),
    };
  };

  app.get('/api/orgs/:id/channel', { preHandler: user }, async (req) => {
    const orgId = pid(req);
    await requireOrg(repo, req.principal!, orgId, 'create');
    return clubView(orgId);
  });

  app.get('/api/orgs/:id/channel/check', { preHandler: user }, async (req) => {
    const orgId = pid(req);
    await requireOrg(repo, req.principal!, orgId, 'create');
    const slug = String((req.query as { slug?: string }).slug ?? '').trim().toLowerCase();
    const problem = await channels.slugProblem(slug, orgId);
    return { slug, ok: !problem, problem, url: problem ? null : channels.url(slug) };
  });

  app.put('/api/orgs/:id/channel', { preHandler: user }, async (req) => {
    const orgId = pid(req);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    const b = z
      .object({
        slug: z.string().max(40),
        name: z.string().max(80),
        description: z.string().max(1000).optional(),
        public: z.boolean().optional(),
        featuredTournamentId: z.string().uuid().nullish(),
        look: z.object({ theme: z.string().max(40).optional(), accent: z.string().max(10).nullish(), links: z.array(z.object({ label: z.string().max(60), url: z.string().max(400) })).max(8).optional(), sponsors: z.array(z.string().max(80)).max(12).optional() }).optional(),
      })
      .parse(req.body);
    await channels.save(orgId, { ...b, look: b.look as never });
    return clubView(orgId);
  });

  app.post('/api/orgs/:id/channel/logo', { preHandler: user, bodyLimit: 2_200_000 }, async (req) => {
    const orgId = pid(req);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    const { dataUrl } = z.object({ dataUrl: z.string().max(2_100_000) }).parse(req.body);
    const m = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(dataUrl);
    if (!m) throw new HttpError(400, 'bad_logo', 'Upload a PNG, JPG or WebP image.');
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > 1_500_000) throw new HttpError(400, 'logo_too_big', 'The logo must be 1.5 MB or smaller.');
    const ext = sniff(buf);
    if (!ext) throw new HttpError(400, 'bad_logo', 'Upload a PNG, JPG or WebP image (SVG and other files are not accepted).');
    const c = await channels.byOrg(orgId);
    if (!c) throw new HttpError(409, 'no_channel', 'Save your brand page first.');
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
    // Served by /api/public/branding/:file (<uuid>-<10 hex>.<ext>), named after the channel's id.
    const file = `${c.id}-${hash}.${ext}`;
    fs.mkdirSync(logoDir, { recursive: true });
    fs.writeFileSync(path.join(logoDir, file), buf);
    const old = lookOf(c).logo;
    if (old && old.file !== file) fs.rmSync(path.join(logoDir, old.file), { force: true });
    await channels.setLogo(orgId, { file, v: hash });
    return clubView(orgId);
  });

  app.delete('/api/orgs/:id/channel/logo', { preHandler: user }, async (req) => {
    const orgId = pid(req);
    await requireOrg(repo, req.principal!, orgId, 'admin');
    const c = await channels.byOrg(orgId);
    const old = c ? lookOf(c).logo : null;
    if (old) fs.rmSync(path.join(logoDir, old.file), { force: true });
    if (c) await channels.setLogo(orgId, null);
    return clubView(orgId);
  });

  /** An event on the channel: hidden or shown, its series, and a start time (countdown, reminder). */
  app.patch('/api/tournaments/:id/channel', { preHandler: any }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, pid(req), 'manage');
    const b = z.object({ hidden: z.boolean().optional(), series: z.string().max(60).nullish(), startsAt: z.string().datetime({ offset: true }).nullish() }).parse(req.body);
    await repo.db.query(
      `UPDATE tournaments SET channel_hidden = coalesce($2, channel_hidden), series = CASE WHEN $3::boolean THEN $4 ELSE series END,
         starts_at = CASE WHEN $5::boolean THEN $6::timestamptz ELSE starts_at END, reminded_at = CASE WHEN $5::boolean THEN NULL ELSE reminded_at END WHERE id = $1`,
      [t.id, b.hidden ?? null, b.series !== undefined, b.series?.trim() || null, b.startsAt !== undefined, b.startsAt ?? null],
    );
    channels.changed();
    return { ok: true };
  });
}
