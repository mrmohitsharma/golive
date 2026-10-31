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
};

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
    cache.set(file, html);
    return html;
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
    reply.header('Cache-Control', 'public, max-age=3600');
    return reply.send(fs.readFileSync(path.join(siteDir, file)));
  });

  /** Standard prices for the website (a club may have its own deal; the app shows that). */
  app.get('/api/public/pricing', async (_req, reply) => {
    const { pricing, packs } = await billing.settings();
    reply.header('Cache-Control', 'public, max-age=300');
    return { billing: billing.enabled, pricing, packs };
  });
}
