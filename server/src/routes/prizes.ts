import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { requireAuth } from '../auth.js';
import { can, requireTournament } from '../authz.js';
import { HttpError } from '../errors.js';

const uuid = z.string().uuid();
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  // Quote, and stop spreadsheet formulas (=, +, -, @) from running.
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

/** Prizes, the lucky draw and claims (viewership step 4). */
export function registerPrizeRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, prizes, moments, viewership } = ctx;
  const user = requireAuth(config, 'user');
  const tid = (req: { params: unknown }) => uuid.parse((req.params as { id: string }).id);

  // ---------------------------------------------------------------- watch page
  app.post('/api/public/moments/:mid/enter', async (req, reply) => {
    const b = z.object({ token: z.string().max(200), runKey: z.string().max(40), phone: z.string().trim().min(8).max(20), consent: z.literal(true) }).parse(req.body);
    const v = viewership.verify(b.token);
    if (v.flagged) throw new HttpError(403, 'not_counted', 'The draw is not available here.');
    const r = await prizes.enter(v.viewerId, v.tournamentId, uuid.parse((req.params as { mid: string }).mid), b.runKey, b.phone);
    reply.status(r.created ? 201 : 200);
    return { entered: true, already: !r.created };
  });

  // ---------------------------------------------------------------- claim page
  app.get('/api/public/claims/:code', async (req) => {
    const info = await prizes.claimInfo((req.params as { code: string }).code);
    if (!info) throw new HttpError(404, 'claim_not_found', 'This prize link is not valid.');
    return info;
  });

  app.post('/api/public/claims/:code/otp', async (req) => {
    const b = z.object({ phone: z.string().trim().max(20).nullish() }).parse(req.body ?? {});
    return prizes.sendOtp((req.params as { code: string }).code, b.phone);
  });

  app.post('/api/public/claims/:code/verify', async (req) => {
    const b = z.object({ otp: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'), email: z.string().trim().email().max(200), consent: z.literal(true) }).parse(req.body);
    return prizes.verify((req.params as { code: string }).code, b.otp, b.email);
  });

  app.get('/claim/:code', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex');
    return CLAIM_PAGE.replaceAll('{{BRAND}}', esc(config.BRAND_NAME));
  });

  /** Prize terms of an event: the organiser's text, or one written from the event's prize games. */
  app.get('/prize-terms/:id', async (req, reply) => {
    const t = await repo.tournamentById(tid(req));
    if (!t) throw new HttpError(404, 'not_found', 'Not found.');
    const org = await repo.orgById(t.org_id);
    const ms = (await moments.list(t.id)).filter((m) => m.pick && m.enabled);
    const how = { draw: 'drawn at random among eligible players', first_correct: 'the first right answers', spin: 'landing on a winning segment while prizes last' } as const;
    const auto = `<ol>
<li>Organiser: ${esc(org?.name ?? '')}. Platform: ${esc(config.BRAND_NAME)}.</li>
<li>Free to take part. No purchase or payment is needed to play or to win.</li>
<li>Prizes: ${ms.length ? ms.map((m) => `${esc(m.prize ?? '')} ×${m.prize_stock}${m.sponsor ? ` (from ${esc(m.sponsor)})` : ''}, ${how[m.pick!]}`).join('; ') : 'none announced yet'}.</li>
<li>To be eligible a viewer must watch the live stream on the official watch page for the minimum time shown with each game. One prize per person and per mobile number per event.</li>
<li>Winners are picked by the ${esc(config.BRAND_NAME)} server; every draw is logged. Lucky draw winners must be watching when the draw runs; reserves are drawn too.</li>
<li>Claim within the time shown (24 hours unless stated) by confirming the mobile number with a one-time code and giving an email address. Unclaimed prizes go to the next reserve.</li>
<li>Sharing on social media is optional and never needed to win or claim.</li>
<li>Contact details are used only to deliver the prize${ms.some((m) => m.sponsor) ? ' and are shared with the sponsor who sends it' : ''}, and are deleted 90 days after the event.</li>
<li>The organiser may change or cancel a game for reasons outside their control. Their decision on winners is final.</li>
</ol>`;
    reply.type('text/html; charset=utf-8');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prize terms · ${esc(t.name)}</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0e10;color:#f3f5f4;max-width:720px;margin:0 auto;padding:24px 16px;line-height:1.6}h1{font-size:22px}.muted{color:#9aa5a0}li{margin:6px 0}</style></head>
<body><div class="muted">${esc(config.BRAND_NAME)}</div><h1>Prize terms · ${esc(t.name)}</h1>${t.prize_terms ? `<div style="white-space:pre-wrap">${esc(t.prize_terms)}</div>` : auto}
<p class="muted"><a style="color:inherit" href="/privacy">Privacy policy</a></p></body></html>`;
  });

  // ---------------------------------------------------------------- organiser side
  app.post('/api/tournaments/:id/moments/:mid/draw', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'direct');
    const m = await moments.get(t.id, uuid.parse((req.params as { mid: string }).mid));
    const b = z.object({ runKey: z.string().max(40).nullish() }).parse(req.body ?? {});
    let runKey = b.runKey ?? null;
    if (!runKey) {
      if (m.type === 'draw') runKey = 'draw';
      else if (m.clock === 'viewer') runKey = 'all';
      else runKey = (await moments.runs(t.id, 24 * 3600_000)).filter((r) => r.moment_id === m.id && r.fired_by !== 'missed').at(-1)?.id ?? null;
    }
    if (!runKey) throw new HttpError(409, 'no_run', 'This game has not run yet.');
    return { draw: await prizes.draw(t, m, runKey, (req.principal as { email?: string }).email ?? 'director') };
  });

  app.get('/api/tournaments/:id/winners', { preHandler: user }, async (req) => {
    const { t, role } = await requireTournament(repo, req.principal!, tid(req), 'direct');
    return { winners: await prizes.list(t, can(role, 'manage')), stock: await prizes.stock(t), log: await prizes.drawLog(t), prizeTerms: t.prize_terms, prizesPerViewer: t.prizes_per_viewer };
  });

  app.get('/api/tournaments/:id/winners.csv', { preHandler: user }, async (req, reply) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    const rows = await prizes.list(t, true);
    const head = ['Game', 'Prize', 'Sponsor', 'Status', 'Phone', 'Email', 'Via influencer', 'Won at', 'Claimed at', 'Sent at'];
    const lines = rows.map((r) => [r.game, r.prize, r.sponsor, r.status, r.phone?.replace(/^\+/, ''), r.email, r.viaInfluencer, r.wonAt, r.claimedAt, r.sentAt].map(csvCell).join(','));
    reply.type('text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="winners-${t.id.slice(0, 8)}.csv"`);
    return [head.map(csvCell).join(','), ...lines].join('\r\n');
  });

  app.post('/api/tournaments/:id/winners/:wid/sent', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    await prizes.markSent(t, uuid.parse((req.params as { wid: string }).wid));
    return { ok: true };
  });

  app.put('/api/tournaments/:id/prize-terms', { preHandler: user }, async (req) => {
    const { t } = await requireTournament(repo, req.principal!, tid(req), 'manage');
    const b = z.object({ text: z.string().max(10_000).nullable(), prizesPerViewer: z.number().int().min(1).max(10).optional() }).parse(req.body);
    await repo.db.query('UPDATE tournaments SET prize_terms = $2, prizes_per_viewer = COALESCE($3, prizes_per_viewer) WHERE id = $1', [t.id, b.text?.trim() || null, b.prizesPerViewer ?? null]);
    return { ok: true };
  });
}

/** The winner's claim page: prize, one-time code to the phone, email and consent. */
const CLAIM_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Claim your prize · {{BRAND}}</title>
<style>
:root{--bg:#0b0e10;--panel:#15191c;--line:#252b30;--ink:#f3f5f4;--muted:#9aa5a0;--live:#e53935;--gold:#c9a227;--bad:#ff6b6b;--green:#2e7d4f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Roboto,sans-serif}
.wrap{max-width:440px;margin:0 auto;padding:28px 18px}.brand{color:var(--gold);font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
h1{font-size:26px;margin:8px 0 4px}.prize{font-size:20px;font-weight:800;color:var(--gold)}.muted{color:var(--muted);font-size:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:18px}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 4px}input[type=tel],input[type=email],input[inputmode=numeric]{width:100%;background:#0f1315;border:1px solid var(--line);border-radius:9px;color:var(--ink);padding:12px;font:inherit}
button{width:100%;margin-top:14px;background:var(--live);border:0;color:#fff;border-radius:9px;padding:13px;font:inherit;font-weight:800;cursor:pointer}button:disabled{opacity:.5}
.check{display:flex;gap:8px;align-items:flex-start;font-size:13px;color:var(--muted);margin-top:12px}.err{color:var(--bad);font-size:14px;min-height:18px;margin-top:8px}.ok{color:#bfe8cf}
a{color:inherit}
</style></head><body><div class="wrap" id="app"><p class="muted">Loading…</p></div>
<script>
(function(){
  var code = location.pathname.split('/').pop(), app = document.getElementById('app');
  function h(t,a,k){var n=document.createElement(t);if(a)for(var x in a){if(x==='text')n.textContent=a[x];else if(x==='class')n.className=a[x];else if(x.slice(0,2)==='on')n.addEventListener(x.slice(2),a[x]);else n.setAttribute(x,a[x]);}(k||[]).forEach(function(c){if(c)n.appendChild(typeof c==='string'?document.createTextNode(c):c)});return n;}
  function post(u,b){return fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error((j.error&&j.error.message)||'Try again');return j;});});}
  fetch('/api/public/claims/'+encodeURIComponent(code)).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error((j.error&&j.error.message)||'Not found');return j;});}).then(function(d){
    var head=[h('div',{class:'brand',text:'{{BRAND}} · '+d.event}),h('h1',{text:'You won!'}),h('div',{class:'prize',text:d.prize}),d.sponsor?h('div',{class:'muted',text:'From '+d.sponsor}):null];
    if(d.status==='claimed'||d.status==='sent'){app.replaceChildren.apply(app,head.concat([h('div',{class:'card ok',text:'Claimed. The organiser will contact you to send your prize.'})]));return;}
    if(d.status==='expired'){app.replaceChildren.apply(app,head.concat([h('div',{class:'card',text:'The time to claim this prize has passed.'})]));return;}
    var err=h('div',{class:'err'});
    var phone=h('input',{type:'tel',inputmode:'tel',autocomplete:'tel',placeholder:d.phoneHint||'Mobile number',maxlength:'16'});
    var send=h('button',{text:'Send me a code'});
    var step1=h('div',{class:'card'},[h('div',{text:'Confirm your mobile number to claim.'}),d.claimBy?h('div',{class:'muted',text:'Claim by '+new Date(d.claimBy).toLocaleString()}):null,h('label',{text:d.phoneHint?'The number you entered the draw with':'Mobile number'}),phone,send,err]);
    send.onclick=function(){send.disabled=true;err.textContent='';post('/api/public/claims/'+code+'/otp',{phone:phone.value||null}).then(function(r){step2(r.sentTo);}).catch(function(e){err.textContent=e.message;send.disabled=false;});};
    function step2(to){
      var otp=h('input',{inputmode:'numeric',autocomplete:'one-time-code',maxlength:'6',placeholder:'6-digit code'});
      var email=h('input',{type:'email',autocomplete:'email',placeholder:'you@example.com',maxlength:'200'});
      var ok=h('input',{type:'checkbox'});var go=h('button',{text:'Claim prize'});var e2=h('div',{class:'err'});
      var card=h('div',{class:'card'},[h('div',{text:'We sent a code to '+to+'.'}),h('label',{text:'Code'}),otp,h('label',{text:'Email (for your prize)'}),email,
        h('label',{class:'check'},[ok,h('span',{},['I agree to the ',h('a',{href:d.termsUrl,target:'_blank',rel:'noopener',text:'prize terms'}),' and to being contacted to receive the prize.'])]),go,e2]);
      go.onclick=function(){if(!ok.checked){e2.textContent='Tick the box to claim.';return;}go.disabled=true;e2.textContent='';post('/api/public/claims/'+code+'/verify',{otp:otp.value,email:email.value,consent:true}).then(function(){app.replaceChildren.apply(app,head.concat([h('div',{class:'card ok',text:'Claimed! The organiser will contact you to send your prize.'})]));}).catch(function(e){e2.textContent=e.message;go.disabled=false;});};
      step1.replaceWith(card);otp.focus();
    }
    app.replaceChildren.apply(app,head.concat([step1,h('p',{class:'muted',style:'margin-top:16px'},['Free to claim. You never need to share or pay anything. ',h('a',{href:d.termsUrl,target:'_blank',rel:'noopener',text:'Prize terms'})])]));
  }).catch(function(e){app.replaceChildren(h('p',{class:'muted',text:e.message}));});
})();
</script></body></html>`;
