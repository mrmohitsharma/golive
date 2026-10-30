import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { requireClubFeature } from './admin-web.js';
import { requireAuth } from '../auth.js';
import { requireTournament } from '../authz.js';
import { HttpError } from '../errors.js';
import { INFLUENCER_PLATFORMS } from '../influencers.js';
import { playableVideo } from '../viewership.js';

const uuid = z.string().uuid();
const here = path.dirname(fileURLToPath(import.meta.url));
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Influencer links (viewership step 2): organisers add influencers to an event; each gets a
 * short link with its own preview, a QR code and a private stats page; the watch page offers
 * "Remind me" before the event.
 */
export function registerInfluencerRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, hub, influencers, youtube, viewership } = ctx;
  const user = requireAuth(config, 'user');
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, '');
  const tid = (req: { params: unknown }) => uuid.parse((req.params as { id: string }).id);
  const isLive = (id: string) => hub.engineState(id).streaming.active;

  // ---------------------------------------------------------------- organiser side
  app.get('/api/tournaments/:id/influencers', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'direct');
    const slug = await influencers.eventSlug(t);
    const status = await youtube.videoStatus(t).catch(() => null);
    return {
      eventLink: `${base}/w/${slug}`,
      attributionDays: t.attribution_days,
      influencerBoard: t.influencer_board,
      // Links can be shared before the broadcast exists ("Remind me" until it is live); this says
      // whether the watch page can play the video right now.
      playable: playableVideo(t, status),
      influencers: (await influencers.list(t.id)).map((i) => influencers.dto(i, slug)),
    };
  });

  const body = z.object({
    name: z.string().trim().min(1).max(80),
    handle: z.string().trim().max(80).nullish(),
    platform: z.enum(INFLUENCER_PLATFORMS).optional(),
    slug: z.string().trim().max(40).nullish(),
    terms: z.string().trim().max(500).nullish(),
    pan: z.string().trim().max(20).nullish(),
  });

  app.post('/api/tournaments/:id/influencers', { preHandler: user }, async (req, reply) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    ctx.billing.requireViewership(t);
    if ((await influencers.list(t.id, true)).length >= 200) throw new HttpError(409, 'too_many_influencers', 'An event can have at most 200 influencers.');
    const inf = await influencers.create(t, body.parse(req.body));
    reply.status(201);
    return { influencer: influencers.dto(inf, await influencers.eventSlug(t)) };
  });

  app.patch('/api/tournaments/:id/influencers/:iid', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    const patch = body.partial().omit({ slug: true }).extend({ archived: z.boolean().optional() }).parse(req.body);
    const inf = await influencers.update(t.id, uuid.parse((req.params as { iid: string }).iid), patch);
    return { influencer: influencers.dto(inf, await influencers.eventSlug(t)) };
  });

  /** A new private stats link (the old one stops working), e.g. if it was shared by mistake. */
  app.post('/api/tournaments/:id/influencers/:iid/rotate-stats', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    const inf = await influencers.rotateStatsKey(t.id, uuid.parse((req.params as { iid: string }).iid));
    return { influencer: influencers.dto(inf, await influencers.eventSlug(t)) };
  });

  /** What the Studio needs to draw the promotion kit (story and post images) in the browser. */
  app.get('/api/tournaments/:id/influencers/:iid/kit', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'direct');
    const inf = await influencers.get(t.id, uuid.parse((req.params as { iid: string }).iid));
    const slug = await influencers.eventSlug(t);
    const link = influencers.linkFor(slug, inf);
    const org = await repo.orgById(t.org_id);
    return {
      link,
      shortLink: link.replace(/^https?:\/\//, ''),
      qrSvg: await influencers.qrSvg(link),
      eventName: t.name,
      venue: t.venue,
      orgName: org?.name ?? null,
      startsOn: t.starts_on,
      influencer: { name: inf.name, handle: inf.handle },
      thumbnailUrl: t.yt_broadcast_id ? `https://i.ytimg.com/vi/${t.yt_broadcast_id}/hqdefault.jpg` : null,
      statsUrl: influencers.statsUrl(inf),
    };
  });

  /** The leaderboard of an event's influencers, plus how much of the audience came through links. */
  app.get('/api/tournaments/:id/influencers/stats', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'direct');
    await viewership.flush().catch(() => {});
    const list = await influencers.stats(t);
    const all = await viewership.summary(t);
    const viaLinks = list.reduce((n, i) => n + i.viewers, 0);
    return {
      influencers: list,
      totals: {
        viewers: all.viewers,
        viaLinks,
        viaLinksShare: all.viewers ? Math.round((100 * viaLinks) / all.viewers) : 0,
        youtubeViewersNow: all.youtube.viewersNow,
        youtubePeak: all.youtube.peak,
        watchingNow: all.watchingNow,
      },
    };
  });

  app.patch('/api/tournaments/:id/viewership-settings', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    const b = z
      .object({ attributionDays: z.number().int().min(1).max(30).optional(), influencerBoard: z.boolean().optional(), momentGapSec: z.number().int().min(0).max(3600).optional() })
      .parse(req.body);
    await repo.db.query(
      `UPDATE tournaments SET attribution_days = COALESCE($2, attribution_days), influencer_board = COALESCE($3, influencer_board),
         moment_gap_sec = COALESCE($4, moment_gap_sec) WHERE id = $1`,
      [t.id, b.attributionDays ?? null, b.influencerBoard ?? null, b.momentGapSec ?? null],
    );
    const fresh = (await repo.tournamentById(t.id))!;
    return { attributionDays: fresh.attribution_days, influencerBoard: fresh.influencer_board, momentGapSec: fresh.moment_gap_sec };
  });

  // ---------------------------------------------------------------- the add-on
  app.get('/api/tournaments/:id/viewership-addon', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'direct');
    return ctx.billing.viewershipState(t, await ctx.messenger.countForEvent(t.id));
  });

  /** Turns on Influencers & games for one event (credits from the club's wallet). */
  app.post('/api/tournaments/:id/billing/viewership', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    await requireClubFeature(repo, t.org_id, 'viewership');
    await ctx.billing.buyViewership(t, (req.principal as { email?: string }).email ?? 'organiser');
    const fresh = (await repo.tournamentById(t.id))!;
    return ctx.billing.viewershipState(fresh, await ctx.messenger.countForEvent(t.id));
  });

  // ---------------------------------------------------------------- the web Studio
  /** Organisers' web page for influencers, games, winners and reports (login with the website account). */
  const studioFile = [path.resolve(here, '../../public/studio.html'), path.resolve(here, '../../../public/studio.html')].find((p) => fs.existsSync(p));
  const sendStudio = async (_req: unknown, reply: FastifyReply) => {
    if (!studioFile) throw new HttpError(500, 'missing_assets', 'Studio page is missing.');
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-cache');
    // The web app (/web) shows the Studio inside its event page, so only this site may frame it.
    reply.header('Content-Security-Policy', "frame-ancestors 'self'");
    return reply.send(fs.readFileSync(studioFile));
  };
  // V7: the event list lives in the web app; the Studio opens inside each event there.
  app.get('/studio', async (_req, reply) => reply.redirect('/web/events', 302));
  app.get('/studio/:id', sendStudio);

  // ---------------------------------------------------------------- short links
  /**
   * /w/<event>/<influencer>: link previews (WhatsApp, Instagram) read the tags ("Ravi invites you
   * to watch…", the video thumbnail); people are sent on to the watch page with ?r=<influencer>.
   */
  const shortLink = async (eventSlug: string, slug: string, ua: string) => {
    const found = await influencers.byLink(eventSlug, slug);
    if (!found) return null;
    const { t, inf } = found;
    if (inf) await influencers.recordClick(inf, ua, isLive(t.id)).catch(() => {});
    const org = await repo.orgById(t.org_id);
    const target = `/watch/${t.id}${inf ? `?r=${encodeURIComponent(inf.slug)}` : ''}`;
    const live = isLive(t.id);
    const title = inf ? `${inf.name} invites you to watch ${t.name}` : t.name;
    const desc = `${live ? 'Live now' : 'Watch live'}${t.venue ? ` from ${t.venue}` : ''}${org ? `, by ${org.name}` : ''}. Free on ${config.BRAND_NAME}.`;
    const image = t.yt_broadcast_id ? `https://i.ytimg.com/vi/${t.yt_broadcast_id}/hqdefault.jpg` : `${base}/site/og.png`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta property="og:type" content="video.other"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}"><meta property="og:url" content="${esc(`${base}/w/${eventSlug}${inf ? `/${inf.slug}` : ''}`)}">
<meta name="twitter:card" content="summary_large_image"><meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0;url=${esc(target)}"><link rel="canonical" href="${esc(`${base}/watch/${t.id}`)}">
<style>body{font-family:system-ui,sans-serif;background:#0b0e10;color:#fff;padding:24px}</style></head>
<body><p>Opening <a style="color:#fff" href="${esc(target)}">${esc(t.name)}</a>…</p><script>location.replace(${JSON.stringify(target)})</script></body></html>`;
  };

  app.get('/w/:event/:slug', async (req, reply) => {
    const p = req.params as { event: string; slug: string };
    const html = await shortLink(p.event.toLowerCase(), p.slug.toLowerCase(), String(req.headers['user-agent'] ?? ''));
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    if (!html) {
      reply.status(404);
      return '<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font-family:system-ui">This link is not valid any more.</p>';
    }
    return html;
  });

  app.get('/w/:event', async (req, reply) => {
    const html = await shortLink((req.params as { event: string }).event.toLowerCase(), '', String(req.headers['user-agent'] ?? ''));
    reply.type('text/html; charset=utf-8');
    if (!html) {
      reply.status(404);
      return '<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font-family:system-ui">This link is not valid any more.</p>';
    }
    return html;
  });

  // ---------------------------------------------------------------- "Remind me"
  app.post('/api/public/tournaments/:id/remind', async (req, reply) => {
    const t = await repo.tournamentById(tid(req));
    if (!t || t.archived || !t.public_watch) throw new HttpError(404, 'not_found', 'Tournament not found.');
    const b = z.object({ phone: z.string().trim().min(8).max(20), consent: z.literal(true), ref: z.string().max(40).nullish() }).parse(req.body);
    if (!ctx.billing.viewershipOn(t)) throw new HttpError(409, 'reminders_off', 'Reminders are not on for this event.');
    const r = await influencers.addReminder(t, b.phone, await influencers.refIdFor(t.id, b.ref));
    reply.status(r.created ? 201 : 200);
    return { ok: true, live: isLive(t.id) };
  });

  // ---------------------------------------------------------------- the influencer's private page
  const publicStats = async (key: string) => {
    const inf = await influencers.byStatsKey(key);
    if (!inf || inf.archived) return null;
    const t = await repo.tournamentById(inf.tournament_id);
    if (!t) return null;
    const all = await influencers.stats(t);
    const mine = all.find((i) => i.id === inf.id);
    if (!mine) return null;
    return {
      event: { name: t.name, live: isLive(t.id), startsOn: t.starts_on },
      you: { ...mine, id: undefined, rank: all.findIndex((i) => i.id === inf.id) + 1, of: all.length },
      // Other influencers' totals only (no viewer data), if the organiser allows it.
      board: t.influencer_board
        ? all.map((i, n) => ({ rank: n + 1, name: i.name, qualifiedViewers: i.qualifiedViewers, watchMinutes: i.watchMinutes, watchingNow: i.watchingNow, you: i.id === inf.id }))
        : null,
      updatedAt: new Date().toISOString(),
    };
  };

  app.get('/api/public/influencer/:key', async (req, reply) => {
    const s = await publicStats((req.params as { key: string }).key);
    if (!s) throw new HttpError(404, 'not_found', 'This stats link is not valid.');
    reply.header('Cache-Control', 'no-store');
    return s;
  });

  app.get('/i/:key', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex');
    return INFLUENCER_PAGE.replaceAll('{{BRAND}}', esc(config.BRAND_NAME));
  });
}

/** The influencer's own stats page: their numbers and the live leaderboard, refreshed every 15 s. */
const INFLUENCER_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Your stats · {{BRAND}}</title>
<style>
:root{--bg:#0b0e10;--panel:#15191c;--line:#252b30;--ink:#f3f5f4;--muted:#9aa5a0;--live:#e53935;--gold:#c9a227}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Roboto,sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:20px 16px}.brand{color:var(--gold);font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
h1{font-size:22px;margin:4px 0}.sub{color:var(--muted);font-size:14px}.pill{display:inline-block;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:800;background:#3a4247}.pill.live{background:var(--live)}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:16px 0}@media(min-width:560px){.grid{grid-template-columns:repeat(3,1fr)}}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}.stat .v{font-size:26px;font-weight:800}.stat .l{color:var(--muted);font-size:12px}
.rank{font-size:15px;margin:6px 0 0}.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
table{width:100%;border-collapse:collapse}td,th{padding:9px 12px;border-bottom:1px solid var(--line);text-align:left;font-variant-numeric:tabular-nums}th{color:var(--muted);font-size:12px}
td.n,th.n{text-align:right}tr.you td{color:var(--gold);font-weight:700}.foot{color:var(--muted);font-size:12px;margin-top:14px}
</style></head><body><div class="wrap" id="app"><p class="sub">Loading…</p></div>
<script>
(function(){
  var key = location.pathname.split('/').pop();
  var app = document.getElementById('app');
  function h(t,a,k){var n=document.createElement(t);if(a)for(var x in a){if(x==='text')n.textContent=a[x];else if(x==='class')n.className=a[x];else n.setAttribute(x,a[x]);}(k||[]).forEach(function(c){if(c)n.appendChild(typeof c==='string'?document.createTextNode(c):c)});return n;}
  function stat(v,l){return h('div',{class:'stat'},[h('div',{class:'v',text:String(v)}),h('div',{class:'l',text:l})]);}
  function load(){
    fetch('/api/public/influencer/'+encodeURIComponent(key),{cache:'no-store'}).then(function(r){if(!r.ok)throw r.status;return r.json();}).then(function(d){
      var y=d.you, kids=[
        h('div',{class:'brand',text:'{{BRAND}} · your stats'}),
        h('h1',{text:d.event.name}),
        h('div',{class:'sub'},[h('span',{class:'pill'+(d.event.live?' live':''),text:d.event.live?'LIVE':'NOT LIVE'}),' '+y.name+(y.handle?' · '+y.handle:'')]),
        h('p',{class:'rank',text:'You are #'+y.rank+' of '+y.of+' influencers'}),
        h('div',{class:'grid'},[stat(y.watchingNow,'Watching now'),stat(y.qualifiedViewers,'Viewers (30 s+)'),stat(y.watchMinutes,'Minutes watched'),stat(y.clicks,'Link taps'),stat(y.reminders,'Reminder sign-ups'),stat(y.unmutedRate+'%','Unmuted')]),
        h('p',{class:'sub',text:'Your link: '+y.link})
      ];
      if(d.board){kids.push(h('div',{class:'panel'},[h('table',{},[h('thead',{},[h('tr',{},[h('th',{text:'#'}),h('th',{text:'Influencer'}),h('th',{class:'n',text:'Now'}),h('th',{class:'n',text:'Viewers'}),h('th',{class:'n',text:'Minutes'})])]),
        h('tbody',{},d.board.map(function(b){return h('tr',{class:b.you?'you':''},[h('td',{text:String(b.rank)}),h('td',{text:b.name}),h('td',{class:'n',text:String(b.watchingNow)}),h('td',{class:'n',text:String(b.qualifiedViewers)}),h('td',{class:'n',text:String(b.watchMinutes)})]);}))])]));}
      kids.push(h('p',{class:'foot',text:'Updates every 15 seconds. A viewer counts after 30 seconds of watching. Keep this link private.'}));
      app.replaceChildren.apply(app,kids);
    }).catch(function(e){if(e===404){app.replaceChildren(h('p',{class:'sub',text:'This stats link is not valid any more. Ask the organiser for a new one.'}));return;}});
  }
  load();setInterval(load,15000);
})();
</script></body></html>`;
