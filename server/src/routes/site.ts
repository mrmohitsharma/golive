import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const siteDir = [path.resolve(here, '../../public/site'), path.resolve(here, '../../../public/site')].find((p) => fs.existsSync(p));

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Pages of the public website, served from public/site/<file>. */
const PAGES: Record<string, string> = {
  '/': 'index.html',
  '/signup': 'signup.html',
  '/login': 'login.html',
  '/reset-password': 'reset.html',
  '/support': 'support.html',
  '/account': 'account.html',
  '/terms': 'terms.html',
  '/privacy': 'privacy.html',
  '/delete-account': 'delete-account.html',
  '/features': 'features.html',
};

const ASSETS: Record<string, string> = {
  'site.css': 'text/css; charset=utf-8',
  'site.js': 'text/javascript; charset=utf-8',
  'auth.js': 'text/javascript; charset=utf-8',
  'account.js': 'text/javascript; charset=utf-8',
  'scenes.js': 'text/javascript; charset=utf-8',
  'favicon.svg': 'image/svg+xml',
  'og.png': 'image/png',
  // Our watch player (/watch and /embed): hls.js (Apache-2.0) and our wrapper.
  'hls-1.5.20.light.min.js': 'text/javascript; charset=utf-8',
  'hls.js.LICENSE.txt': 'text/plain; charset=utf-8',
  'player.js': 'text/javascript; charset=utf-8',
  'features.js': 'text/javascript; charset=utf-8',
  // Barlow (SIL Open Font License), served here instead of Google Fonts: no extra connections.
  'barlow-400.woff2': 'font/woff2',
  'barlow-600.woff2': 'font/woff2',
  'barlow-condensed-700.woff2': 'font/woff2',
  'barlow-condensed-800.woff2': 'font/woff2',
  'fonts-OFL.txt': 'text/plain; charset=utf-8',
};

/** Short content hash of a site file, for ?v= cache busting (cached per process in production). */
const hashes = new Map<string, string>();
function versionOf(file: string): string | null {
  if (!siteDir || !ASSETS[file]) return null;
  const prod = process.env.NODE_ENV === 'production';
  const hit = prod ? hashes.get(file) : undefined;
  if (hit) return hit;
  try {
    const h = crypto.createHash('sha1').update(fs.readFileSync(path.join(siteDir, file))).digest('hex').slice(0, 10);
    hashes.set(file, h);
    return h;
  } catch {
    return null;
  }
}

/** Adds ?v=<hash> to /site/<file> links so browsers can keep them for a year. */
export function versionAssets(html: string): string {
  return html.replace(/(["'(])\/site\/([A-Za-z0-9._-]+)(?=["')])/g, (m, pre: string, file: string) => {
    const v = versionOf(file);
    return v ? `${pre}/site/${file}?v=${v}` : m;
  });
}

/**
 * Public website: landing page, sign-up / sign-in, account (credits), and the legal pages
 * Google (OAuth verification) and Meta (app review) ask for. Pages are static HTML with
 * {{TOKENS}} filled from config, so the brand and company details live in .env.
 */
export function registerSiteRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, billing } = ctx;
  if (!config.SITE_ENABLED) return;

  const domain = (() => {
    try {
      return new URL(config.PUBLIC_BASE_URL).host;
    } catch {
      return config.PUBLIC_BASE_URL;
    }
  })();
  const missing = (what: string) => `<span class="todo">[${what}]</span>`;
  const supportEmail = config.SUPPORT_EMAIL ?? `support@${domain}`;
  const tokens: Record<string, string> = {
    BRAND: esc(config.BRAND_NAME),
    DOMAIN: esc(domain),
    BASE_URL: esc(config.PUBLIC_BASE_URL.replace(/\/$/, '')),
    EMAIL: esc(supportEmail),
    ENTITY: config.LEGAL_ENTITY ? esc(config.LEGAL_ENTITY) : missing('Company legal name: set LEGAL_ENTITY'),
    ADDRESS: config.LEGAL_ADDRESS ? esc(config.LEGAL_ADDRESS) : missing('Registered address: set LEGAL_ADDRESS'),
    GRIEVANCE: config.GRIEVANCE_OFFICER ? esc(config.GRIEVANCE_OFFICER) : missing('Grievance Officer name: set GRIEVANCE_OFFICER'),
    JURISDICTION: esc(config.LEGAL_JURISDICTION),
    UPDATED: esc(config.LEGAL_UPDATED),
    YEAR: String(new Date().getFullYear()),
    PLAY_STORE_URL: esc(config.PLAY_STORE_URL ?? ''),
    APP_STORE_URL: esc(config.APP_STORE_URL ?? ''),
  };

  const cache = new Map<string, string>();
  const render = (file: string): string => {
    if (!siteDir) throw new HttpError(500, 'missing_assets', 'Website files are missing.');
    const hit = process.env.NODE_ENV === 'production' ? cache.get(file) : undefined;
    if (hit) return hit;
    const header = fs.readFileSync(path.join(siteDir, '_header.html'), 'utf8');
    const footer = fs.readFileSync(path.join(siteDir, '_footer.html'), 'utf8');
    const html = fs
      .readFileSync(path.join(siteDir, file), 'utf8')
      .replace('{{> header}}', header)
      .replace('{{> footer}}', footer)
      .replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => tokens[k] ?? m);
    const out = versionAssets(html);
    cache.set(file, out);
    return out;
  };

  const send = (reply: FastifyReply, file: string, cacheable: boolean) => {
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', cacheable ? 'public, max-age=300' : 'no-store');
    reply.header('Content-Security-Policy', "frame-ancestors 'none'");
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    return reply.send(render(file).replace(/\{\{SIGNUP\}\}/g, ctx.platform.signupEnabled ? 'true' : 'false'));
  };

  for (const [route, file] of Object.entries(PAGES)) {
    const cacheable = !['/signup', '/login', '/account', '/reset-password', '/support'].includes(route);
    app.get(route, async (_req, reply) => send(reply, file, cacheable));
  }
  // A requester's ticket page: the same page shows the thread for the key in the address.
  app.get('/support/t/:key', async (_req, reply) => send(reply, 'support.html', false));
  // Common aliases people and app stores type.
  app.get('/privacy-policy', async (_req, reply) => reply.redirect('/privacy', 301));
  app.get('/terms-of-service', async (_req, reply) => reply.redirect('/terms', 301));
  app.get('/signin', async (_req, reply) => reply.redirect('/login', 301));

  app.get('/site/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    const type = ASSETS[file];
    if (!type || !siteDir) throw new HttpError(404, 'not_found', 'Not found.');
    reply.type(type);
    // Versioned links (?v=<hash>, added to every page) change when the file changes: keep a year.
    const versioned = typeof (req.query as { v?: unknown }).v === 'string';
    reply.header('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
    if (file.endsWith('.woff2')) reply.header('Access-Control-Allow-Origin', '*');
    let body = fs.readFileSync(path.join(siteDir, file));
    // The stylesheet's own links (fonts) get versions too.
    if (file.endsWith('.css')) body = Buffer.from(versionAssets(body.toString('utf8')));
    return reply.send(body);
  });

  /** Standard prices for the website (a club may have its own deal; the app shows that). */
  app.get('/api/public/pricing', async (_req, reply) => {
    const { pricing, packs } = await billing.settings();
    reply.header('Cache-Control', 'public, max-age=300');
    return { billing: billing.enabled, pricing, packs };
  });
}
