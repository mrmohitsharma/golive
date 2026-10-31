// The product tour: highlights each important menu and feature in turn with a short tooltip,
// asks for the key actions, shows "3 / 9", and has Previous / Next / Skip. Progress is saved
// per user, so a reload resumes the tour; Help and Profile can restart it.
import { state, get, patch, el, go } from './core.js';
import { openGuide } from './guide.js';

/** path: page to open first (':event' = the club's first event); target: what to highlight. */
const STEPS = [
  { id: 'events', path: '/web/events', target: '[data-tour="nav-events"]', title: 'Your events', text: 'Every show lives here. Open an event, copy it for next time, or jump straight to its control room.' },
  { id: 'new-event', path: '/web/events', target: '[data-tour="new-event"]', title: 'Create an event', text: 'Start a new show: name, type of event, and Cloud OBS or Laptop OBS.', action: 'Try it: create an event (you can delete it later).' },
  { id: 'event-tabs', path: '/web/e/:event/overview', target: '[data-tour="event-tabs"]', title: 'Inside an event', text: 'Overview shows status and a quick start. Then: Cameras & people, Streaming, Scores, Chat, Clips, Influencers & games and Settings.', needsEvent: true },
  { id: 'invites', path: '/web/e/:event/people', target: '[data-tour="invites"]', title: 'Add cameras and helpers', text: 'Phones join with these links or QR codes: cameras, scorers and commentators. No accounts needed.', action: 'Send the camera link to one phone on WhatsApp.', needsEvent: true },
  { id: 'main-stream', path: '/web/e/:event/streaming', target: '[data-tour="main-stream"]', title: 'Where viewers watch', text: 'Pick the main stream: your watch page, YouTube, Facebook, Instagram or any stream key. Pause or switch it any time; add more places below.', needsEvent: true },
  { id: 'control', path: '/web/e/:event/overview', target: '[data-tour="control-btn"]', title: 'The control room', text: 'Preview and take cameras, add graphics and replays, balance the sound, and Go live.', action: 'Open it when your cameras have joined.', needsEvent: true },
  { id: 'wallet', path: null, target: '[data-tour="nav-wallet"]', title: 'Wallet', text: 'Credits pay for extra cameras, destinations and live time. Buy packs here and see what each event used.' },
  { id: 'team', path: null, target: '[data-tour="nav-team"], [data-tour="nav-channels"]', title: 'Team and channels', text: 'Owners add directors here and connect the club’s YouTube channels and Facebook Page once.', ownerOnly: true },
  { id: 'help', path: null, target: '[data-tour="nav-help"]', title: 'Help is always here', text: 'The step-by-step guide, this tour again, the setup steps, and support tickets with screenshots.' },
];

let T = null;

async function save(change) {
  try { await patch('/api/me/onboarding', { tour: change }); } catch {}
}

function steps(eventId) {
  const owner = state.me?.platformAdmin || state.orgs.find((o) => o.id === state.orgId)?.role === 'owner';
  return STEPS.filter((s) => (!s.needsEvent || eventId) && (!s.ownerOnly || owner));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function find(selector) {
  for (let i = 0; i < 30; i++) {
    const n = [...document.querySelectorAll(selector)].find((x) => x.offsetParent !== null || x.getClientRects().length);
    if (n) return n;
    await wait(100);
  }
  return null;
}

function end(stateName) {
  if (!T) return;
  window.removeEventListener('resize', T.place);
  window.removeEventListener('scroll', T.place, true);
  document.removeEventListener('keydown', T.keys);
  T.layer.remove();
  T = null;
  void save({ state: stateName });
}

async function show(i) {
  if (!T) return;
  const list = T.list;
  if (i < 0) i = 0;
  if (i >= list.length) { end('done'); return; }
  T.i = i;
  const s = list[i];
  void save({ state: 'active', step: i, seen: [s.id] });
  if (s.path) {
    const path = s.path.replace(':event', T.eventId ?? '');
    if (location.pathname !== path) go(path);
  }
  // Mobile: the menu is a drawer; open it for menu items.
  if (s.target.includes('nav-') && window.matchMedia('(max-width: 860px)').matches) document.getElementById('side')?.classList.add('open');
  const target = await find(s.target);
  if (!T) return;
  if (!target) { show(T.dir < 0 ? i - 1 : i + 1); return; } // not on this page for this user: move on
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  T.target = target;
  T.tip.replaceChildren(
    el('div', { class: 'tour-count', text: `${i + 1} / ${list.length}` }),
    el('h3', { text: s.title }),
    el('p', { text: s.text }),
    s.action ? el('p', { class: 'tour-action' }, el('strong', { text: 'Your turn: ' }), s.action) : null,
    el('div', { class: 'tour-progress' }, el('i', { style: `width:${Math.round(((i + 1) / list.length) * 100)}%` })),
    el('div', { class: 'row', style: 'margin-top:10px' },
      el('button', { class: 'btn small ghost', onclick: () => end('skipped'), text: 'Skip tour' }),
      el('div', { class: 'sp' }),
      i > 0 ? el('button', { class: 'btn small', onclick: () => { T.dir = -1; show(i - 1); }, text: '← Previous' }) : null,
      el('button', { class: 'btn small primary', onclick: () => { T.dir = 1; show(i + 1); }, text: i === list.length - 1 ? 'Finish' : 'Next →' })));
  await wait(250);
  T?.place();
  T?.tip.querySelector('.btn.primary')?.focus();
}

/**
 * Starts the tour. fromStart: begin at step 1 (Help / Profile / welcome); otherwise resume
 * where this user left off.
 */
export async function startTour(fromStart = true) {
  if (T) end('active');
  let eventId = null;
  try {
    const { tournaments } = await get('/api/tournaments');
    eventId = tournaments.find((t) => t.orgId === state.orgId && !t.archived)?.id ?? null;
  } catch {}
  const list = steps(eventId);
  let start = 0;
  if (!fromStart) {
    try { start = Math.min((await get('/api/me/onboarding')).onboarding?.tour?.step ?? 0, list.length - 1); } catch {}
  }
  const layer = el('div', { class: 'tour-layer' });
  const hole = el('div', { class: 'tour-hole' });
  const tip = el('div', { class: 'tour-tip', role: 'dialog', 'aria-live': 'polite' });
  layer.append(hole, tip);
  document.body.append(layer);
  const place = () => {
    if (!T?.target) return;
    const r = T.target.getBoundingClientRect();
    const pad = 6;
    Object.assign(hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    const tw = Math.min(340, window.innerWidth - 24);
    tip.style.width = `${tw}px`;
    const th = tip.offsetHeight || 200;
    let left = r.right + 16;
    let top = r.top;
    if (left + tw > window.innerWidth - 12) { left = Math.min(Math.max(12, r.left), window.innerWidth - tw - 12); top = r.bottom + 14; }
    if (top + th > window.innerHeight - 12) top = Math.max(12, r.top - th - 14);
    Object.assign(tip.style, { left: `${left}px`, top: `${Math.max(12, top)}px` });
  };
  const keys = (e) => {
    if (e.key === 'Escape') end('skipped');
    else if (e.key === 'ArrowRight') { T.dir = 1; show(T.i + 1); }
    else if (e.key === 'ArrowLeft') { T.dir = -1; show(T.i - 1); }
  };
  T = { list, eventId, layer, hole, tip, place, keys, i: start, dir: 1, target: null };
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  document.addEventListener('keydown', keys);
  show(start);
}

export { openGuide };
