// First-login help: a welcome screen, then the setup bar above the menu with four steps
// (Create event → Add cameras → Main stream → Go live). Each step opens its panel above the
// page, so the normal pages stay usable underneath. Progress is saved per user on the server,
// so it shows once, resumes where it was left, and can be restarted from Help or Profile.
import { state, get, post, patch, el, toast, guard, go } from './core.js';
import { info, openGuide } from './guide.js';
import { mainStreamCard } from './streams.js';
import { startTour } from './tour.js';
import { goLiveSteps } from './golive-steps.js';

const STEPS = [
  { n: 1, key: 'event', label: 'Create event' },
  { n: 2, key: 'cameras', label: 'Add cameras' },
  { n: 3, key: 'stream', label: 'Main stream' },
  { n: 4, key: 'live', label: 'Go live' },
];

const S = {
  ob: {}, cloudAvailable: true, watchAvailable: false,
  events: [], eventId: null, facts: { event: false, cameras: false, stream: false, live: false },
  open: null, timer: null, poll: null, eventState: null,
};
const bar = () => document.getElementById('setup');
const panel = () => document.getElementById('setup-panel');
const brand = () => document.querySelector('.brand')?.textContent?.trim() || 'Go Live';

async function save(change) {
  try { S.ob = (await patch('/api/me/onboarding', change)).onboarding; } catch {}
}

/** Works out which steps are done from the club's real data. */
async function refreshFacts() {
  const { tournaments } = await get('/api/tournaments');
  S.events = tournaments.filter((t) => t.orgId === state.orgId && !t.archived);
  const chosen = S.events.find((t) => t.id === S.ob.setup?.eventId) ?? S.events[0] ?? null;
  S.eventId = chosen?.id ?? null;
  const f = { event: Boolean(chosen), cameras: false, stream: false, live: false };
  if (chosen) {
    const [st, d, org] = await Promise.all([
      get(`/api/tournaments/${chosen.id}/state`),
      get(`/api/tournaments/${chosen.id}/destinations`),
      get(`/api/orgs/${state.orgId}/onboarding`).catch(() => null),
    ]);
    S.eventState = { ...st, outputs: d.outputs };
    f.cameras = (st.cameras ?? []).length > 0;
    f.stream = d.outputs.main.ready && !d.outputs.main.paused && (S.ob.setup?.step ?? 1) > 3;
    f.live = Boolean(st.engine?.streaming?.active || org?.steps?.live);
  }
  S.facts = f;
  return f;
}

const doneCount = () => STEPS.filter((s) => S.facts[s.key]).length;

function renderBar() {
  const b = bar();
  const st = S.ob.setup?.state;
  if (!st || st === 'skipped' || st === 'done') { b.hidden = true; return; }
  b.hidden = false;
  const current = S.open ?? S.ob.setup?.step ?? 1;
  b.replaceChildren(
    el('div', { class: 'setup-in' },
      el('strong', { class: 'setup-title', text: 'Get on air' }),
      el('ol', { class: 'setup-steps' }, STEPS.map((s) => el('li', { class: [S.facts[s.key] ? 'done' : '', s.n === current && S.open ? 'on' : ''].join(' ') },
        el('button', { type: 'button', onclick: () => openStep(s.n), 'aria-current': s.n === current ? 'step' : null },
          el('span', { class: 'dot', text: S.facts[s.key] ? '✓' : String(s.n) }), el('span', { class: 'lbl', text: s.label }))))),
      el('span', { class: 'setup-count', text: `${doneCount()} of ${STEPS.length}` }),
      el('div', { class: 'sp' }),
      el('button', { class: 'btn small ghost', onclick: () => startTour(true), text: 'Product tour' }),
      S.open ? el('button', { class: 'btn small ghost', onclick: closePanel, text: 'Hide steps' }) : el('button', { class: 'btn small', onclick: () => openStep(firstOpen()), text: 'Continue' }),
      el('button', { class: 'btn small ghost', onclick: guard(skip), title: 'You can restart it from Help', text: 'Skip setup' })));
}

const firstOpen = () => (STEPS.find((s) => !S.facts[s.key]) ?? STEPS[3]).n;

async function skip() {
  await save({ setup: { state: 'skipped' } });
  closePanel();
  renderBar();
  toast('Setup hidden. Restart it any time from Help.');
}

function closePanel() {
  S.open = null;
  clearInterval(S.poll);
  panel().replaceChildren();
  panel().hidden = true;
  renderBar();
}

function frame(n, ...content) {
  const s = STEPS[n - 1];
  return el('section', { class: 'setup-card', 'aria-label': `Step ${n}: ${s.label}` },
    el('div', { class: 'row', style: 'margin-bottom:8px' },
      el('span', { class: 'small muted', text: `Step ${n} of 4` }), el('div', { class: 'sp' }),
      el('button', { class: 'btn small ghost', 'aria-label': 'Close', onclick: closePanel, text: '✕' })),
    ...content);
}

function navButtons(n, nextLabel = 'Next', onNext = null) {
  return el('div', { class: 'row setup-nav' },
    n > 1 ? el('button', { class: 'btn', onclick: () => openStep(n - 1), text: '← Previous' }) : null,
    el('div', { class: 'sp' }),
    el('button', { class: 'btn primary', onclick: guard(async () => { if (onNext) await onNext(); else openStep(n + 1); }), text: nextLabel }));
}

const onControlPage = () => /\/web\/e\/[^/]+\/control\/?$/.test(location.pathname);

async function openStep(n) {
  n = Math.max(1, Math.min(4, n));
  if (n === 4 && onControlPage()) {
    closePanel();
    const row = document.querySelector('.gl-steps');
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row?.querySelector('.gl-step.current')?.focus({ preventScroll: true });
    return;
  }
  clearInterval(S.poll);
  S.open = n;
  if ((S.ob.setup?.step ?? 1) !== n) await save({ setup: { step: Math.max(n, 1) } });
  await refreshFacts().catch(() => {});
  if (n > 1 && !S.eventId) n = S.open = 1;
  // Keep the page under the panel on the matching tab, so it shows the same fresh data.
  const tab = { 2: 'people', 3: 'streaming', 4: 'overview' }[n];
  if (tab && S.eventId && !location.pathname.endsWith('/control') && location.pathname !== `/web/e/${S.eventId}/${tab}`) go(`/web/e/${S.eventId}/${tab}`);
  const p = panel();
  p.hidden = false;
  p.replaceChildren(el('div', { class: 'setup-card' }, el('p', { class: 'muted', text: 'Loading…' })));
  const views = { 1: stepEvent, 2: stepCameras, 3: stepStream, 4: stepLive };
  try {
    p.replaceChildren(await views[n]());
  } catch (e) {
    p.replaceChildren(frame(n, el('div', { class: 'banner bad', text: e.message || String(e) })));
  }
  renderBar();
  p.scrollIntoView?.({ block: 'nearest' });
}

// ------------------------------------------------------------------ step 1: create event
async function stepEvent() {
  const { eventTypes } = await get('/api/event-types');
  const f = {
    name: el('input', { required: true, maxlength: 120, placeholder: 'e.g. Monsoon Open 2026, Sharma wedding, Annual day' }),
    type: el('select', {}, eventTypes.map((e) => el('option', { value: e.id, text: e.label }))),
    venue: el('input', { maxlength: 120, placeholder: 'Optional' }),
    date: el('input', { type: 'date' }),
  };
  let mode = S.cloudAvailable ? 'cloud' : 'laptop';
  const modes = el('div', { class: 'choices two' });
  const drawModes = () => modes.replaceChildren(
    ...[
      ['cloud', 'Cloud OBS', 'Runs on our servers. Nothing to install: direct from this website or a tablet.', 'Recommended', !S.cloudAvailable],
      ['laptop', 'Laptop OBS', 'OBS on your own computer at the venue, with our agent next to it.', null, false],
    ].map(([v, name, sub, tag, off]) => el('button', {
      type: 'button', class: 'choice' + (mode === v ? ' on' : ''), disabled: off || undefined,
      onclick: () => { mode = v; drawModes(); },
    }, el('span', { class: 'radio', 'aria-hidden': 'true' }),
      el('span', { style: 'flex:1' }, el('span', { class: 'row', style: 'gap:6px' }, el('strong', { text: name }), tag ? el('span', { class: 'pill ok', text: tag }) : null, info('obs', `${name}: how it works`)),
        el('div', { class: 'small muted', text: off ? 'Not available on this server yet.' : sub })))));
  drawModes();
  const existing = S.events.length ? el('div', { class: 'banner', style: 'margin-bottom:12px' },
    el('div', { class: 'row' }, el('span', { text: 'Already have an event?' }),
      el('select', { id: 'setup-existing', style: 'max-width:260px' }, S.events.map((t) => el('option', { value: t.id, selected: t.id === S.eventId || undefined, text: t.name }))),
      el('button', { class: 'btn small', onclick: guard(async () => {
        const id = document.getElementById('setup-existing').value;
        await save({ setup: { eventId: id, step: 2 } });
        go(`/web/e/${id}/people`);
        openStep(2);
      }), text: 'Use this one' }))) : null;
  return frame(1,
    el('h2', { style: 'margin-top:0', text: 'Create your event' }),
    el('p', { class: 'muted', text: 'Name it, say what it is, and choose where the show is mixed. You can change all of this later in the event Settings.' }),
    existing,
    el('div', { class: 'form' },
      el('div', {}, el('label', { text: 'Event name' }), f.name),
      el('div', {}, el('label', { text: 'Type of event' }), f.type),
      el('div', {}, el('label', { text: 'Venue' }), f.venue),
      el('div', {}, el('label', { text: 'Date' }), f.date)),
    el('label', { style: 'display:block;margin:14px 0 6px', text: 'Where the show is mixed' }),
    modes,
    navButtons(1, 'Create event →', async () => {
      if (!f.name.value.trim()) { f.name.focus(); throw new Error('Give the event a name.'); }
      const r = await post(`/api/orgs/${state.orgId}/tournaments`, { name: f.name.value.trim(), eventType: f.type.value, venue: f.venue.value.trim() || null, startsOn: f.date.value || null, mode });
      await save({ setup: { eventId: r.tournament.id, step: 2 } });
      toast('Event created');
      go(`/web/e/${r.tournament.id}/people`);
      await openStep(2);
    }));
}

// ------------------------------------------------------------------ step 2: cameras
async function stepCameras() {
  const id = S.eventId;
  const { invites } = await get(`/api/tournaments/${id}/invites`);
  const by = Object.fromEntries(invites.map((i) => [i.role, i]));
  const cam = by.camera;
  const list = el('div');
  const draw = (cams) => list.replaceChildren(cams.length
    ? el('ul', { class: 'cam-list' }, cams.map((c) => el('li', {}, el('span', { class: 'pill ' + (c.status === 'live' ? 'ok' : c.status === 'offline' ? '' : 'warn'), text: c.status === 'live' ? 'Sending' : c.status }), ` ${c.name}`, c.deviceModel ? el('span', { class: 'small muted', text: ` · ${c.deviceModel}` }) : null)))
    : el('p', { class: 'small muted', text: 'Waiting for the first phone… it appears here as soon as it joins.' }));
  draw(S.eventState?.cameras ?? []);
  S.poll = setInterval(async () => {
    try { const st = await get(`/api/tournaments/${id}/state`); draw(st.cameras ?? []); if ((st.cameras ?? []).length && !S.facts.cameras) { S.facts.cameras = true; renderBar(); } } catch {}
  }, 4000);
  const share = (i, label) => el('div', { class: 'invite-row' },
    el('strong', { text: label }),
    el('span', { class: 'mono small', style: 'user-select:all;word-break:break-all', text: i.joinUrl }),
    el('span', { class: 'row' },
      el('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(i.joinUrl).then(() => toast('Link copied')), text: 'Copy' }),
      el('a', { class: 'btn small', href: i.whatsapp, target: '_blank', rel: 'noopener', text: 'WhatsApp' })));
  return frame(2,
    el('h2', { style: 'margin-top:0' }, 'Add your cameras ', info('cameras', 'Adding cameras, scorers and commentators')),
    el('p', { class: 'muted', text: 'Any phone becomes a camera: scan this QR with the phone, or send it the link. No account needed. Add as many as your event has slots for.' }),
    cam ? el('div', { class: 'cam-invite' },
      el('img', { src: `${cam.qrUrl}?token=${encodeURIComponent(state.token)}`, alt: 'Camera QR code', class: 'qr' }),
      el('div', { style: 'flex:1;min-width:240px' },
        share(cam, 'Camera link'),
        el('div', { class: 'small muted', style: 'margin:10px 0 4px', text: 'Also invite (optional):' }),
        by.scorer ? share(by.scorer, 'Scorer link') : null,
        by.commentator ? share(by.commentator, 'Commentator link') : null)) : el('div', { class: 'banner warn', text: 'No invite link for this event yet: open Cameras & people to make one.' }),
    el('h3', { text: 'Cameras that joined' }),
    list,
    navButtons(2, 'Next: main stream →'));
}

// ------------------------------------------------------------------ step 3: main stream
async function stepStream() {
  const box = el('div');
  const o = await mainStreamCard(box, S.eventId, { compact: true, onChange: () => refreshFacts().then(renderBar).catch(() => {}) });
  return frame(3,
    el('h2', { style: 'margin-top:0', text: 'Choose your main stream' }),
    el('p', { class: 'muted', text: 'This is where you send viewers. Pick any one; pause it or switch to another whenever you like. Add more places on the event’s Streaming tab.' }),
    box,
    navButtons(3, 'Next: go live →', async () => {
      const d = await get(`/api/tournaments/${S.eventId}/destinations`);
      const m = d.outputs.main;
      if (m.paused) throw new Error(`${m.label} is paused. Resume it, or pick another main stream.`);
      await save({ setup: { step: 4 } });
      await openStep(4);
    }));
}

// ------------------------------------------------------------------ step 4: go live
async function stepLive() {
  const id = S.eventId;
  // The same step buttons as on top of the control room; the ones that need the control
  // room take you there (and this panel closes, so the steps continue in one place).
  const steps = goLiveSteps({ id, context: 'setup', onLeave: closePanel });
  const draw = async () => {
    const st = await get(`/api/tournaments/${id}/state`);
    if (st.engine?.streaming?.active && !S.facts.live) { S.facts.live = true; renderBar(); }
    steps.update(st);
  };
  await draw();
  S.poll = setInterval(() => draw().catch(() => {}), 4000);
  return frame(4,
    el('h2', { style: 'margin-top:0' }, 'Go live ', info('golive', 'Going live in the control room')),
    el('p', { class: 'muted', text: 'Follow the glowing button. Each step turns green when it is done, and the next one lights up.' }),
    steps.node,
    el('div', { class: 'row setup-nav' },
      el('button', { class: 'btn', onclick: () => openStep(3), text: '← Previous' }),
      el('div', { class: 'sp' }),
      el('button', { class: 'btn', onclick: guard(async () => {
        await save({ setup: { state: 'done' } });
        closePanel();
        toast('Setup finished. Restart it any time from Help.');
        if (S.ob.tour?.state !== 'done') startTour(true);
      }), text: 'Finish setup' })));
}

// ------------------------------------------------------------------ welcome screen
function welcome() {
  return new Promise((resolve) => {
    const name = (state.me?.name || '').split(' ')[0];
    const d = el('dialog', { class: 'welcome' },
      el('div', { class: 'welcome-mark', 'aria-hidden': 'true' }, el('span', { class: 'dot' })),
      el('h2', { text: `Welcome to ${brand()}${name ? `, ${name}` : ''}!` }),
      el('p', { class: 'muted', text: 'Run a multi-camera live show from phones: cameras, mixing, graphics and streaming, all from this website.' }),
      el('ol', { class: 'welcome-steps' }, STEPS.map((s) => el('li', {}, el('span', { class: 'n', text: String(s.n) }), s.label))),
      el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px;flex-wrap:wrap' },
        el('button', { class: 'btn ghost', onclick: () => close('explore'), text: 'I’ll explore myself' }),
        el('button', { class: 'btn', onclick: () => close('tour'), text: 'Take the 2-minute tour' }),
        el('button', { class: 'btn primary', autofocus: true, onclick: () => close('setup'), text: S.events.length ? 'Continue setting up' : 'Set up my first show' })));
    const close = (v) => { d.close(); d.remove(); resolve(v); };
    d.addEventListener('cancel', (e) => { e.preventDefault(); close('explore'); });
    document.body.append(d);
    d.showModal();
  });
}

const onRoute = () => { if (S.open === 4 && onControlPage()) closePanel(); };
window.addEventListener('gl:route', onRoute);
window.addEventListener('popstate', onRoute);

/** Called once the app knows who is logged in and which club is selected. */
export async function startOnboarding() {
  if (!state.orgId || !['owner', 'director'].includes(state.orgs.find((o) => o.id === state.orgId)?.role)) return;
  let r;
  try { r = await get('/api/me/onboarding'); } catch { return; }
  S.ob = r.onboarding ?? {};
  S.cloudAvailable = r.cloudAvailable;
  S.watchAvailable = r.watchAvailable;
  await refreshFacts().catch(() => {});
  // A club that has already been live does not need the setup steps (the tour is still offered).
  if (!S.ob.setup?.state) await save({ setup: { state: S.facts.live ? 'done' : 'active', step: firstOpen() } });
  renderBar();
  // Keep the ticks fresh while the bar is visible (cameras joining, going live elsewhere).
  clearInterval(S.timer);
  S.timer = setInterval(() => { if (!bar().hidden && !S.open) refreshFacts().then(renderBar).catch(() => {}); }, 15000);
  if (!S.ob.welcomed) {
    const pick = await welcome();
    await save({ welcomed: true });
    if (pick === 'setup') { if (S.ob.setup?.state !== 'active') await save({ setup: { state: 'active' } }); return openStep(firstOpen()); }
    if (pick === 'tour') return startTour(true);
    if (!S.events.length) return openStep(1);
    return;
  }
  if (S.ob.tour?.state === 'active') return startTour(false);
  // No event yet: step 1 opens by itself.
  if (S.ob.setup?.state === 'active' && !S.events.length) openStep(1);
}

/** Help and Profile: start the setup again from step 1 (or the first unfinished step). */
export async function restartSetup() {
  await save({ setup: { state: 'active', step: 1 } });
  await refreshFacts().catch(() => {});
  renderBar();
  openStep(firstOpen());
}

export { openGuide };
