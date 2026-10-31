import { z } from 'zod';

const bool = (def: string) =>
  z
    .string()
    .default(def)
    .transform((v) => v !== 'false' && v !== '0' && v !== 'no');

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined));

const schema = z.object({
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL: z.string().default('12h'),
  GUEST_TTL: z.string().default('2d'),
  // 64 hex chars. Encrypts YouTube refresh tokens and stream keys at rest.
  DATA_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'DATA_KEY must be 64 hex characters (openssl rand -hex 32)'),

  // Public HTTPS base of this server, e.g. https://live.cogolfers.com (OAuth redirect, join links, media URLs).
  PUBLIC_BASE_URL: z.string().min(1),
  // Base URL cloud OBS uses to fetch replays and the graphics page. It runs next to the
  // server, so this is an internal address (http://server:8080). Laptop OBS uses PUBLIC_BASE_URL.
  CLOUD_ENGINE_MEDIA_BASE_URL: optional,

  // Self-serve sign-up. Turn off to run a closed instance.
  SIGNUP_ENABLED: bool('true'),

  // Public website (/, /signup, /login, /account, /terms, /privacy, /delete-account).
  // The legal pages show these; Google and Meta app reviews check them, so fill them in.
  BRAND_NAME: z.string().default('Go Live'),
  SUPPORT_EMAIL: optional,
  LEGAL_ENTITY: optional, // registered company name, e.g. "Example Media Pvt Ltd"
  LEGAL_ADDRESS: optional, // registered office address
  LEGAL_JURISDICTION: z.string().default('Gurugram, Haryana'),
  GRIEVANCE_OFFICER: optional, // name of the Grievance Officer (IT Rules 2021 / DPDP Act 2023)
  LEGAL_UPDATED: z.string().default('27 October 2026'),
  PLAY_STORE_URL: optional,
  APP_STORE_URL: optional,
  // Join links open the app (onboarding P1-9). Android App Links: the package and the SHA-256
  // fingerprints of the signing certificates (upload key and Play app signing, comma-separated).
  // iOS Universal Links: "<TEAM ID>.<bundle id>". Empty = that file is not served.
  // SMS through MSG91 (Flow API, DLT-approved templates). Empty auth key = test sender (outbox only).
  MSG91_AUTH_KEY: optional,
  MSG91_API_BASE: z.string().default('https://control.msg91.com/api/v5'),
  MSG91_TEMPLATE_OTP: optional,
  MSG91_TEMPLATE_REMINDER: optional,
  MSG91_TEMPLATE_WINNER: optional,
  MSG91_TEMPLATE_DRAW: optional,
  // Viewership: more viewers than this from one network in one event are not counted.
  VIEW_NET_CAP: z.coerce.number().int().min(1).default(25),
  ANDROID_PACKAGE: z.string().default('com.cogolfers.cogolfer_live'),
  ANDROID_CERT_SHA256: optional,
  IOS_APP_ID: optional,
  SITE_ENABLED: bool('true'),

  // MediaMTX
  MEDIAMTX_HOOK_SECRET: z.string().min(16),
  MEDIAMTX_API_URL: z.string().default('http://mediamtx:9997'),
  MEDIAMTX_RTSP_URL: z.string().default('rtsp://mediamtx:8554'),
  MEDIAMTX_PLAYBACK_URL: z.string().default('http://mediamtx:9996'),
  INTERNAL_MEDIA_USER: z.string().default('cg-internal'),
  INTERNAL_MEDIA_PASS: z.string().min(16),

  PUBLIC_SRT_HOST: z.string().min(1),
  PUBLIC_SRT_PORT: z.coerce.number().default(8890),
  // SRT host/port OBS uses. Cloud OBS reaches MediaMTX on the internal network.
  ENGINE_SRT_HOST: optional,
  ENGINE_SRT_PORT: z.coerce.number().optional(),
  SRT_PASSPHRASE: optional.refine((v) => v === undefined || (v.length >= 10 && v.length <= 79), 'SRT_PASSPHRASE must be 10-79 chars'),
  SRT_LATENCY_MS: z.coerce.number().default(600),
  PUBLIC_WEBRTC_BASE: z.string().min(1),

  // Thumbnails
  THUMBNAIL_DIR: z.string().default('/tmp/cg-thumbs'),
  THUMBNAIL_INTERVAL_SEC: z.coerce.number().default(2),
  THUMBNAIL_WIDTH: z.coerce.number().default(480),
  THUMBNAILS_ENABLED: bool('true'),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),

  // Replays and clips
  MEDIA_DIR: z.string().default('/data/media'),
  CLIP_FONT: z.string().default('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'),
  // MediaMTX writes the recording in 1 s parts; wait this long before reading the newest second.
  RECORDING_LAG_MS: z.coerce.number().default(2500),

  HEALTH_POLL_MS: z.coerce.number().default(2000),
  TELEMETRY_STALE_MS: z.coerce.number().default(15000),
  AUTO_FALLBACK_GRACE_MS: z.coerce.number().default(3000),

  // YouTube (Google OAuth web client). Leave empty to hide "Connect YouTube".
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  GOOGLE_AUTH_URL: z.string().default('https://accounts.google.com/o/oauth2/v2/auth'),
  GOOGLE_TOKEN_URL: z.string().default('https://oauth2.googleapis.com/token'),
  GOOGLE_REVOKE_URL: z.string().default('https://oauth2.googleapis.com/revoke'),
  YOUTUBE_API_BASE: z.string().default('https://www.googleapis.com/youtube/v3'),
  // Sign in with Google: comma-separated OAuth client IDs whose ID tokens we accept
  // (Web first, then Android/iOS). GOOGLE_CLIENT_ID is always accepted too. Empty = no Google button.
  GOOGLE_SIGNIN_CLIENT_IDS: optional,
  GOOGLE_CERTS_URL: z.string().default('https://www.googleapis.com/oauth2/v3/certs'),
  YOUTUBE_POLL_MS: z.coerce.number().default(15000),

  // Facebook Page live (Meta app with Facebook Login). Leave empty to hide "Connect Facebook".
  META_APP_ID: optional,
  META_APP_SECRET: optional,
  META_GRAPH_VERSION: z.string().default('v26.0'),
  META_AUTH_URL: z.string().default('https://www.facebook.com'),
  META_GRAPH_BASE: z.string().default('https://graph.facebook.com'),

  // Viewer comments. YouTube live chat costs 5 API quota units per read. Every 15 s plus the
  // broadcast status checks ≈ 8,600 units for a 5-hour show, inside the default 10,000/day
  // (one show a day; ask Google for more quota for more).
  YOUTUBE_CHAT_POLL_SEC: z.coerce.number().min(1).default(15),
  FACEBOOK_COMMENTS_POLL_SEC: z.coerce.number().min(1).default(4),
  // Extra words to mask in chat, comma-separated.
  CHAT_BLOCKED_WORDS: optional,

  // Restreaming: OBS sends one programme stream to MediaMTX; the server forwards it to
  // YouTube, Facebook and Instagram (9:16 re-encode at this bitrate).
  RELAY_RETRY_MAX_SEC: z.coerce.number().default(30),
  INSTAGRAM_VIDEO_KBPS: z.coerce.number().default(3500),

  // Our own watch player: the programme is turned into HLS (several qualities) under HLS_DIR
  // and served at /hls/..., normally through a CDN pull zone (Admin > Streaming).
  HLS_ENABLED: bool('true'),
  HLS_DIR: optional,
  // height:kbps pairs, best first. Each one costs about one CPU core while live.
  // 'auto': when OBS reports a programme of PROGRAMME_HEIGHT or less, it is passed straight
  // through as the top quality (almost no CPU) and only the lower ones are encoded; otherwise
  // the qualities in HLS_LADDER are all encoded. Or a fixed list like '720:2500,480:1000'.
  HLS_RENDITIONS: z.string().regex(/^auto$|^\d{3,4}:\d{3,5}(,\d{3,4}:\d{3,5})*$/).default('auto'),
  HLS_LADDER: z.string().regex(/^\d{3,4}:\d{3,5}(,\d{3,4}:\d{3,5})*$/).default('720:2500,480:1000'),
  // The programme OBS sends (both modes): scaled output and bitrate, 2 s keyframes.
  PROGRAMME_HEIGHT: z.coerce.number().int().min(360).max(1080).default(720),
  PROGRAMME_KBPS: z.coerce.number().int().min(800).max(8000).default(2500),
  HLS_PRESET: z.enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast']).default('veryfast'),
  HLS_SEGMENT_SEC: z.coerce.number().int().min(1).max(6).default(2),
  HLS_RETENTION_DAYS: z.coerce.number().min(1).default(14),
  // Bunny CDN starting values (Admin > Streaming overrides them once saved there).
  CDN_HOST: optional,
  BUNNY_PULL_ZONE_ID: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.coerce.number().int().positive().optional()),
  BUNNY_API_KEY: optional,

  // Public watch page and API (for the CoGolfers website). Comma-separated origins allowed
  // to call /api/public/* from a browser, and to embed /watch/<id> in an iframe.
  PUBLIC_CORS_ORIGINS: z.string().default(''),
  WATCH_EMBED_ORIGINS: z.string().default(''),

  // Cloud production mode (OBS on the server)
  CLOUD_ENGINE_DRIVER: z.enum(['none', 'docker', 'process']).default('none'),
  CLOUD_ENGINE_IMAGE: z.string().default('cogolfer/cloud-engine:latest'),
  CLOUD_ENGINE_NETWORK: z.string().default('cogolfer_default'),
  CLOUD_ENGINE_CPUS: z.coerce.number().default(6),
  CLOUD_ENGINE_MEMORY_MB: z.coerce.number().default(6144),
  CLOUD_ENGINE_SERVER_URL: z.string().default('http://server:8080'),
  CLOUD_ENGINE_IDLE_STOP_MIN: z.coerce.number().default(30),
  CLOUD_ENGINE_MAX_HOURS: z.coerce.number().default(14),
  CLOUD_ENGINE_COST_PER_HOUR: z.coerce.number().default(0.35),
  CLOUD_ENGINE_WIDTH: z.coerce.number().default(1920),
  CLOUD_ENGINE_HEIGHT: z.coerce.number().default(1080),
  CLOUD_ENGINE_FPS: z.coerce.number().default(30),
  CLOUD_ENGINE_VIDEO_KBPS: z.coerce.number().default(2500),
  // process driver (development/tests): command that starts OBS + agent on this machine.
  CLOUD_ENGINE_PROCESS_CMD: optional,
  DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),

  // Billing: free cameras/minutes per tournament, paid extras from a credit wallet.
  // Prices and credit packs are set in /admin. Turn off to run without limits.
  BILLING_ENABLED: bool('true'),
  BILLING_TICK_MS: z.coerce.number().default(5000),

  // Cashfree payment gateway for buying credits. Leave empty to hide "Buy credits"
  // (CoGolfers staff can still add credits in /admin).
  CASHFREE_CLIENT_ID: optional,
  CASHFREE_CLIENT_SECRET: optional,
  CASHFREE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  CASHFREE_API_BASE: optional,
  CASHFREE_API_VERSION: z.string().default('2025-01-01'),
  CASHFREE_SDK_URL: z.string().default('https://sdk.cashfree.com/js/v3/cashfree.js'),

  BOOTSTRAP_ADMIN_EMAIL: optional,
  BOOTSTRAP_ADMIN_PASSWORD: optional,

  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  return parsed.data;
}

export function youtubeEnabled(c: Config): boolean {
  return Boolean(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET);
}

/** Where OBS fetches graphics and replays: internal for cloud OBS, public for a venue laptop. */
export function engineMediaBase(c: Config, mode: 'laptop' | 'cloud'): string {
  return ((mode === 'cloud' ? c.CLOUD_ENGINE_MEDIA_BASE_URL : undefined) ?? c.PUBLIC_BASE_URL).replace(/\/$/, '');
}

export function metaEnabled(c: Config): boolean {
  return Boolean(c.META_APP_ID && c.META_APP_SECRET);
}

export function originList(v: string): string[] {
  return v.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
}

export function cashfreeEnabled(c: Config): boolean {
  return Boolean(c.CASHFREE_CLIENT_ID && c.CASHFREE_CLIENT_SECRET);
}

export function cashfreeBase(c: Config): string {
  return (c.CASHFREE_API_BASE ?? (c.CASHFREE_ENV === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg')).replace(/\/$/, '');
}
