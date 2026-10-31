import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';
import { requireAuth, userOf } from '../auth.js';
import { requireTournament } from '../authz.js';
import { adminGuard } from './web.js';
import { SESSION_RE } from '../hls.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = [path.resolve(here, '../../public'), path.resolve(here, '../../../public')].find((p) => fs.existsSync(p));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VARIANT = /^v(\d{3,4}p|src)$/;
const FILE = /^(master|replay|live|vod)\.m3u8$|^s\d{5,7}\.ts$/;

/**
 * The origin the CDN pulls from: /hls/<event>/<session>/{master,replay}.m3u8 and
 * /hls/<event>/<session>/v720p/{live.m3u8,vod.m3u8,s00042.ts}. Segments never change, so
 * they are cached for a year; the live playlist only for a second. Also /embed/<event>,
 * the player alone for any website, and Admin > Streaming.
 */
export function registerHlsRoutes(app: FastifyInstance, ctx: Ctx) {
  const { hls, config } = ctx;
  const admin = adminGuard(ctx);

  const cors = (reply: FastifyReply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Timing-Allow-Origin', '*');
  };

  const locked = (req: FastifyRequest) => {
    const s = hls.settings;
    return s.lockOrigin && s.host && s.originSecret && req.headers['x-origin-secret'] !== s.originSecret;
  };

  app.get('/hls/ping', async (req, reply) => {
    cors(reply);
    reply.header('Cache-Control', 'no-store');
    if (locked(req)) return reply.status(403).type('text/plain').send('forbidden');
    return reply.type('text/plain').send('ok');
  });

  const serve = async (req: FastifyRequest, reply: FastifyReply, parts: string[]) => {
    cors(reply);
    const [tid, session, ...rest] = parts;
    const file = rest.at(-1)!;
    const bad = !UUID.test(tid) || !SESSION_RE.test(session) || !FILE.test(file) || (rest.length === 2 && !VARIANT.test(rest[0]));
    if (bad) {
      reply.header('Cache-Control', 'public, max-age=60');
      return reply.status(404).type('text/plain').send('not found');
    }
    if (locked(req)) {
      reply.header('Cache-Control', 'no-store');
      return reply.status(403).type('text/plain').send('forbidden');
    }
    const p = path.join(hls.root, tid, session, ...rest);
    let size: number;
    try {
      size = fs.statSync(p).size;
    } catch {
      // A playlist that is not written yet: let the CDN ask again in a second.
      reply.header('Cache-Control', 'public, max-age=1');
      return reply.status(404).type('text/plain').send('not found');
    }
    if (file.endsWith('.ts')) {
      reply.type('video/mp2t');
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      reply.type('application/vnd.apple.mpegurl');
      reply.header('Cache-Control', file === 'live.m3u8' ? 'public, max-age=1' : file === 'master.m3u8' ? 'public, max-age=2' : 'public, max-age=300');
    }
    reply.header('Content-Length', size);
    return reply.send(fs.createReadStream(p));
  };
  app.get('/hls/:tid/:session/:file', (req, reply) => {
    const q = req.params as { tid: string; session: string; file: string };
    return serve(req, reply, [q.tid, q.session, q.file]);
  });
  app.get('/hls/:tid/:session/:variant/:file', (req, reply) => {
    const q = req.params as { tid: string; session: string; variant: string; file: string };
    return serve(req, reply, [q.tid, q.session, q.variant, q.file]);
  });

  // The player alone, for any website: <iframe src="https://<server>/embed/<event>">.
  app.get('/embed/:id', async (_req, reply) => {
    if (!publicDir) throw new HttpError(500, 'missing_assets', 'Player assets are missing.');
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=60');
    return reply.send(fs.readFileSync(path.join(publicDir, 'embed.html')));
  });

  // The event page: our player's live link, replays and the embed code.
  app.get('/api/tournaments/:id/watch', { preHandler: requireAuth(config, 'user') }, async (req) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const { t } = await requireTournament(ctx.repo, req.principal!, id, 'direct');
    const live = ctx.relay.status(t.id).some((s) => s.id === 'watch' && s.state === 'live');
    const base = config.PUBLIC_BASE_URL.replace(/\/$/, '');
    return { available: hls.on, enabled: t.outputs?.watch?.enabled !== false, watch: await hls.info(t, live), watchPage: `${base}/watch/${t.id}`, publicWatch: t.public_watch };
  });

  // ------------------------------------------------------------ Admin > Streaming
  const dto = () => {
    const s = hls.settings;
    return {
      available: config.HLS_ENABLED,
      playerEnabled: s.playerEnabled,
      host: s.host,
      pullZoneId: s.pullZoneId,
      hasApiKey: Boolean(s.apiKey),
      apiKeyHint: s.apiKey ? s.apiKey.slice(-4) : null,
      costPerGbUsd: s.costPerGbUsd,
      lockOrigin: s.lockOrigin,
      originSecret: s.lockOrigin ? s.originSecret : null,
      originUrl: config.PUBLIC_BASE_URL.replace(/\/$/, ''),
      renditions: config.HLS_RENDITIONS,
      retentionDays: config.HLS_RETENTION_DAYS,
    };
  };
  app.get('/api/admin/streaming', { preHandler: admin }, async () => ({ settings: dto(), sessions: await hls.sessions(30) }));
  app.put('/api/admin/streaming', { preHandler: admin }, async (req) => {
    const b = z
      .object({
        playerEnabled: z.boolean(),
        host: z
          .string()
          .trim()
          .toLowerCase()
          .transform((h) => h.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
          .refine((h) => h === '' || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h), 'Enter a hostname like golive-live.b-cdn.net')
          .nullish(),
        pullZoneId: z.number().int().positive().nullish(),
        apiKey: z.string().trim().max(200).optional(),
        costPerGbUsd: z.number().min(0).max(1),
        lockOrigin: z.boolean(),
      })
      .parse(req.body);
    await hls.save(
      { playerEnabled: b.playerEnabled, host: b.host || null, pullZoneId: b.pullZoneId ?? null, costPerGbUsd: b.costPerGbUsd, lockOrigin: b.lockOrigin, ...(b.apiKey ? { apiKey: b.apiKey } : {}) },
      userOf(req).id,
    );
    return { settings: dto() };
  });
  app.post('/api/admin/streaming/test', { preHandler: admin }, async () => ({ checks: await hls.test() }));
  app.get('/api/admin/streaming/stats', { preHandler: admin }, async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).parse(req.query);
    try {
      return { stats: await hls.stats(days, ctx.platform.values.costs.usdInr) };
    } catch (err) {
      throw new HttpError(502, 'cdn_error', (err as Error).message);
    }
  });
}
