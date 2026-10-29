import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { Repo } from './repo.js';
import { ScoringRepo } from './scoring.js';
import { Hub } from './hub.js';
import { HealthPoller } from './health.js';
import { Thumbnailer } from './thumbnails.js';
import { HttpError, errorBody } from './errors.js';
import { bearerFrom, hashPassword, verifyPrincipal } from './auth.js';
import { decideMediaAuth } from './media.js';
import { Sealer, constantTimeEqual } from './crypto.js';
import { YouTubeService } from './youtube.js';
import { MediaService } from './replay.js';
import { GraphicsService } from './graphics.js';
import { CloudEngineManager, makeDriver, type CloudDriver } from './cloud.js';
import { FacebookService } from './facebook.js';
import { RelayManager } from './relay.js';
import { OutputsService } from './outputs.js';
import { BillingService } from './billing.js';
import { PaymentsService } from './payments.js';
import { ChatService } from './chat.js';
import { ChatReaders } from './chat-readers.js';
import type { Ctx } from './context.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOrgRoutes } from './routes/orgs.js';
import { registerTournamentRoutes } from './routes/tournaments.js';
import { registerCameraRoutes } from './routes/cameras.js';
import { registerScoringRoutes } from './routes/scoring.js';
import { registerGraphicsRoutes } from './routes/graphics.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerSiteRoutes } from './routes/site.js';
import { registerDestinationRoutes } from './routes/destinations.js';
import { DestinationsService } from './destinations.js';
import { GoogleSignIn } from './google-signin.js';
import { ViewershipService } from './viewership.js';
import { applyRetention } from './retention.js';
import { Messenger } from './messaging.js';
import { InfluencersService } from './influencers.js';
import { registerInfluencerRoutes } from './routes/influencers.js';
import { MomentsService } from './moments.js';
import { registerMomentRoutes } from './routes/moments.js';
import { PrizesService } from './prizes.js';
import { registerPrizeRoutes } from './routes/prizes.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerChatRoutes } from './routes/chat.js';

export interface AppDeps {
  config: Config;
  db: Db;
  /** Disable background loops in tests. */
  startBackground?: boolean;
  /** Replaces fetch for MediaMTX API polling (tests). */
  fetchImpl?: typeof fetch;
  /** Replaces fetch for Google/YouTube (tests). */
  googleFetch?: typeof fetch;
  /** Replaces fetch for MSG91 (tests). */
  msg91Fetch?: typeof fetch;
  /** Replaces the cloud engine driver (tests). */
  cloudDriver?: CloudDriver | null;
  /** Replaces fetch for the Facebook Graph API (tests). */
  metaFetch?: typeof fetch;
  /** Replaces process spawning for restream relays (tests). */
  relaySpawn?: ConstructorParameters<typeof RelayManager>[3];
  /** Replaces fetch for the Cashfree API (tests). */
  cashfreeFetch?: typeof fetch;
  /** Clock for billing (tests). */
  billingClock?: () => number;
}

export interface App extends Ctx {
  fastify: FastifyInstance;
}

export async function buildApp({ config, db, startBackground = true, fetchImpl, googleFetch, cloudDriver, metaFetch, relaySpawn, cashfreeFetch, billingClock, msg91Fetch }: AppDeps): Promise<App> {
  const fastify = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ['req.headers.authorization', 'req.query.token', 'req.query.secret', 'req.query.k', 'req.query.sig'] },
    trustProxy: true,
    bodyLimit: 512 * 1024,
  });
  const log = fastify.log;
  const repo = new Repo(db);
  const scoring = new ScoringRepo(db);
  const sealer = new Sealer(config.DATA_KEY);
  const hub = new Hub(config, repo, scoring, log);
  const thumbs = new Thumbnailer(config, log);
  const youtube = new YouTubeService(config, repo, sealer, googleFetch);
  const graphics = new GraphicsService(repo, scoring, (tid, g) => hub.graphicsChanged(tid, g));
  const media = new MediaService(config, db, sealer, log, (clip) => hub.clipChanged(clip));
  const driver = cloudDriver !== undefined ? cloudDriver : makeDriver(config, log);
  const cloud = new CloudEngineManager(config, repo, driver, log, (tid, s) => hub.productionChanged(tid, s), (tid) => hub.isBusy(tid));
  const facebook = new FacebookService(config, repo, sealer, metaFetch);
  const relay = new RelayManager(config, log, (tid) => void hub.outputsChanged(tid).catch(() => {}), relaySpawn);
  const billing = new BillingService(config, repo, billingClock);
  const destinations = new DestinationsService(config, repo, sealer, youtube);
  const outputs = new OutputsService(config, repo, sealer, youtube, facebook, relay, log, destinations, billing);
  billing.destinationCounter = (t) => outputs.destinationCount(t);
  const payments = new PaymentsService(config, repo, billing, cashfreeFetch);
  billing.hooks = {
    streaming: () => hub.streamingTournaments(),
    alert: (tid, level, message) => hub.alert(tid, level, message),
    stop: (tid) => hub.systemStop(tid),
    changed: (tid, state) => hub.billingChanged(tid, state),
  };
  const chat = new ChatService(config, repo);
  const chatReaders = new ChatReaders(config, repo, chat, youtube, facebook, log);
  chat.onChange = (tid) => hub.chatChanged(tid);
  const viewership = new ViewershipService(config, repo, (tid) => hub.engineState(tid).streaming.active);
  const messenger = new Messenger(config, repo, msg91Fetch, log);
  // Messages: the add-on's included ones first, then paid per message from the wallet.
  messenger.gate = (tid, n, sent, critical) => billing.allowMessages(tid, n, sent, critical);
  const influencers = new InfluencersService(config, repo, sealer, messenger, (tid) => viewership.watchingByRef(tid));
  const moments = new MomentsService(repo, viewership);
  const prizes = new PrizesService(config, repo, moments, viewership, messenger);
  moments.prizes = prizes;
  hub.services = { graphics, media, youtube, cloud, outputs, billing, chatReaders, viewership, influencers };
  const poller = new HealthPoller(
    config,
    (snap) => {
      const online = new Set([...snap.paths].filter(([p, h]) => h.online && p.startsWith('cam-')).map(([p]) => p));
      thumbs.sync(online);
      hub.onHealth(snap).catch((err) => log.error({ err: err.message }, 'health broadcast failed'));
    },
    fetchImpl,
  );

  await fastify.register(websocket, { options: { maxPayload: 64 * 1024 } });

  fastify.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send(errorBody(err.code, err.message));
    if (err instanceof ZodError) {
      const msg = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
      return reply.status(400).send(errorBody('invalid_request', msg));
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.code === '23505') return reply.status(409).send(errorBody('conflict', 'That name is already used in this tournament.'));
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send(errorBody(e.code ?? 'bad_request', e.message));
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send(errorBody('internal', 'Something went wrong on the server.'));
  });
  fastify.setNotFoundHandler((req, reply) => reply.status(404).send(errorBody('not_found', `No route ${req.method} ${req.url.split('?')[0]}`)));

  const googleSignIn = new GoogleSignIn(config, googleFetch);
  const ctx: Ctx = { config, repo, scoring, hub, youtube, facebook, outputs, relay, media, graphics, cloud, sealer, poller, thumbs, billing, payments, chat, chatReaders, destinations, googleSignIn, viewership, messenger, influencers, moments, prizes };

  fastify.get('/healthz', async () => ({
    ok: true,
    mediaServer: { reachable: poller.last.reachable, error: poller.last.error },
    youtube: youtube.enabled,
    cloud: cloud.available,
    ...hub.stats(),
  }));

  /** Public server capabilities, so the app can hide features this server does not offer. */
  fastify.get('/api/info', async () => ({
    name: config.BRAND_NAME,
    signup: config.SIGNUP_ENABLED,
    youtube: youtube.enabled,
    facebook: facebook.enabled,
    cloudProduction: cloud.available,
    cloudCostPerHour: config.CLOUD_ENGINE_COST_PER_HOUR,
    billing: billing.enabled,
    payments: payments.enabled,
    goliveChannel: await youtube.goliveAvailable(),
    googleSignIn: googleSignIn.enabled,
  }));

  registerAuthRoutes(fastify, ctx);
  registerOrgRoutes(fastify, ctx);
  registerTournamentRoutes(fastify, ctx);
  registerCameraRoutes(fastify, ctx);
  registerScoringRoutes(fastify, ctx);
  registerGraphicsRoutes(fastify, ctx);
  registerMediaRoutes(fastify, ctx);
  registerPublicRoutes(fastify, ctx);
  registerBillingRoutes(fastify, ctx);
  registerAdminRoutes(fastify, ctx);
  registerChatRoutes(fastify, ctx);
  registerSiteRoutes(fastify, ctx);
  registerInfluencerRoutes(fastify, ctx);
  registerMomentRoutes(fastify, ctx);
  registerPrizeRoutes(fastify, ctx);
  registerReportRoutes(fastify, ctx);
  registerDestinationRoutes(fastify, ctx);

  // ------------------------------------------------------------------ MediaMTX auth hook
  fastify.post('/internal/mediamtx/auth', async (req, reply) => {
    const secret = (req.query as { secret?: string }).secret ?? '';
    if (!secret || !constantTimeEqual(secret, config.MEDIAMTX_HOOK_SECRET)) return reply.status(401).send(errorBody('bad_hook_secret', 'unauthorized'));
    const body = (req.body ?? {}) as Record<string, string>;
    const decision = await decideMediaAuth(config, repo, body);
    req.log.info(
      { action: body.action, path: body.path, protocol: body.protocol, ip: body.ip, allow: decision.allow, reason: decision.reason },
      'media auth',
    );
    if (!decision.allow) return reply.status(401).send(errorBody('media_denied', decision.reason));
    return reply.status(200).send({});
  });

  // ------------------------------------------------------------------ realtime
  fastify.get('/ws', { websocket: true }, (socket, req) => {
    const token = bearerFrom(req);
    const principal = token ? verifyPrincipal(config, token) : null;
    if (!principal) {
      socket.send(JSON.stringify({ type: 'error', code: 'unauthorized', message: 'Sign in again.' }));
      socket.close(4001, 'unauthorized');
      return;
    }
    hub.attach(socket, principal);
  });

  let purgeTimer: NodeJS.Timeout | undefined;
  const viewTimers: NodeJS.Timeout[] = [];
  if (startBackground) {
    poller.start();
    cloud.start();
    hub.startYoutubePolling();
    billing.start();
    const purge = () => {
      void chat.purgePlatformComments().catch((err) => log.warn({ err }, 'chat purge failed'));
      void applyRetention(repo).catch((err) => log.warn({ err }, 'viewership retention failed'));
    };
    purge();
    purgeTimer = setInterval(purge, 6 * 3600 * 1000);
    purgeTimer.unref();
    // Viewership: write the watch-page reports every 5 s; once a minute, a watching-now row
    // per event and YouTube's own viewer count for live events.
    viewTimers.push(setInterval(() => void viewership.flush().catch((err) => log.warn({ err }, 'viewership flush failed')), 5000));
    // Stream-clock games open when their time comes (while live).
    viewTimers.push(
      setInterval(async () => {
        for (const tid of hub.streamingTournaments()) {
          const t = await repo.tournamentById(tid).catch(() => null);
          if (t) await moments.tick(t).catch((err) => log.warn({ err }, 'moments tick failed'));
          if (t) await prizes.tick(t).catch((err) => log.warn({ err }, 'prizes tick failed'));
        }
      }, 5000),
    );
    viewTimers.push(
      setInterval(async () => {
        for (const tid of hub.streamingTournaments()) {
          const t = await repo.tournamentById(tid).catch(() => null);
          if (!t) continue;
          const v = await youtube.videoStatus(t).catch(() => null);
          viewership.setYoutubeViewers(tid, v?.concurrentViewers ?? null);
        }
        await viewership.snapshotMinute().catch((err) => log.warn({ err }, 'viewership snapshot failed'));
        // Unclaimed prizes pass to reserves even after the show has ended.
        const due = await db.query<{ tournament_id: string }>("SELECT DISTINCT tournament_id FROM wins WHERE status = 'won' AND claim_expires_at < now()").catch(() => ({ rows: [] }));
        for (const r of due.rows) await prizes.expire(r.tournament_id).catch(() => {});
      }, 60_000),
    );
    for (const tm of viewTimers) tm.unref();
  }
  // Long-lived responses (graphics SSE, WebSockets) would otherwise keep close() waiting.
  fastify.addHook('preClose', async () => {
    graphics.close();
    relay.stopAll();
    chatReaders.stopAll();
    billing.close();
    if (purgeTimer) clearInterval(purgeTimer);
    for (const tm of viewTimers) clearInterval(tm);
    await viewership.flush().catch(() => {});
    hub.close();
  });
  fastify.addHook('onClose', async () => {
    poller.stop();
    thumbs.stop();
    media.close();
    cloud.close();
  });

  return { fastify, ...ctx };
}

/** First start: a platform admin with their own organisation, from env. */
export async function bootstrapAdmin(config: Config, repo: Repo, log: { info: (m: string) => void }): Promise<void> {
  if (!config.BOOTSTRAP_ADMIN_EMAIL || !config.BOOTSTRAP_ADMIN_PASSWORD) return;
  if ((await repo.userCount()) > 0) return;
  const passwordHash = await hashPassword(config.BOOTSTRAP_ADMIN_PASSWORD);
  await repo.tx(async (c) => {
    const u = await repo.createUser({ email: config.BOOTSTRAP_ADMIN_EMAIL!, name: 'Administrator', passwordHash, platformAdmin: true }, c);
    const org = await repo.createOrg('CoGolfers', c);
    await repo.addMember(org.id, u.id, 'owner', c);
  });
  log.info(`Created bootstrap admin ${config.BOOTSTRAP_ADMIN_EMAIL}`);
}
