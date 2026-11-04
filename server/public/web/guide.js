// The product guide: a step-by-step walkthrough of Go Live, shown as a page (/web/guide)
// and in a side drawer from the ⓘ icons, so help opens without leaving what you are doing.
import { state, el, go } from './core.js';

export const title = 'Guide';

/** Topics in the order of a first show. Each: title, one-line summary, sections of steps. */
export const TOPICS = [
  {
    id: 'start',
    title: 'Getting started',
    summary: 'Your first live show in four steps, about 10 minutes.',
    sections: [
      ['The four steps', [
        'Create an event: give it a name and choose Cloud OBS (nothing to install) or Laptop OBS.',
        'Add cameras: phones scan the camera QR or open the invite link. No account needed. Scorers and commentators join the same way.',
        'Choose your main stream: your own watch page (our player), YouTube, Facebook, Instagram or any service with a stream key. Add more places if you like.',
        'Go live: open the control room, start the show, pick a camera and press Go live. Share the watch link.',
      ]],
      ['Where things are', [
        'Events: every event, with Copy and Control room buttons.',
        'Inside an event: Overview (status and quick start), Cameras & people, Streaming, Scores, Chat, Clips, Influencers & games, Settings.',
        'Wallet: credits for extra cameras, destinations and live time.',
        'Help: this guide, the product tour, and support tickets.',
      ]],
    ],
  },
  {
    id: 'obs',
    title: 'Cloud OBS or Laptop OBS',
    summary: 'Where the show is mixed: on our servers, or on your own computer.',
    sections: [
      ['Cloud OBS (recommended)', [
        'OBS runs on our servers, so you need no laptop at the venue. Direct from this website or the app on a tablet.',
        'Press Start show on the event. Cloud OBS is ready in about a minute; the Overview shows when.',
        'Cameras, graphics, sound and replays are all controlled from the control room.',
        'It runs only while your show runs. Stop it from the Overview when you are done.',
      ]],
      ['Laptop OBS', [
        'Use it when you want OBS on your own computer: your own scenes, a capture card, or a weak venue internet for upload.',
        'Install OBS Studio (free, obsproject.com). On the event, open the Laptop OBS tab and download the Go Live app for Windows or Mac.',
        'Open the app. It switches on OBS remote control, sets OBS up and opens it (it asks once), then shows a 6-digit code.',
        'Type the code on the Laptop OBS tab. The steps tick themselves: laptop linked, OBS ready, cameras in OBS. Then open the control room.',
        'Next time just open the app: it remembers your club. To run another event, pick the laptop on that event\'s Laptop OBS tab.',
        'The app creates a scene per camera and sets OBS to send 720p. Keep its window open during the show.',
        'Switch between Cloud OBS and Laptop OBS any time before going live, in the event Settings.',
      ]],
    ],
  },
  {
    id: 'cameras',
    title: 'Cameras, scorers and commentators',
    summary: 'Phones join with a QR code or a link. No accounts.',
    sections: [
      ['Add a camera', [
        'Open the event > Cameras & people. Each event has a camera, a scorer and a commentator invite.',
        'Send the camera link on WhatsApp, or let the phone scan the QR with the Go Live app.',
        'On the phone: allow the camera, choose a name (e.g. "Hole 7" or "Stage left") and tap Go live. It appears in the list within seconds.',
        'Each event includes a number of camera slots; add more from the Wallet credits.',
      ]],
      ['Scorers and commentators', [
        'Scorers enter scores from their phone; the leaderboard and graphics update on air.',
        'Commentators talk from their phone, or from this website in the control room (Start commentating).',
        'Remove anyone from Cameras & people; their link stops working when you revoke the code.',
      ]],
    ],
  },
  {
    id: 'streaming',
    title: 'Main stream and destinations',
    summary: 'Choose where viewers watch, pause or switch it, and add more places.',
    sections: [
      ['Choose the main stream', [
        'Watch page (our player): works with no setup, plays on your event page and any website, with no YouTube logos or ads. Replays are kept 14 days.',
        'YouTube: your connected channel (Club > Channels), the Go Live channel, or a stream key pasted from YouTube Studio.',
        'Facebook Page: connect your Page first (Club > Channels).',
        'Instagram or any other service: paste the stream URL and key.',
      ]],
      ['Pause or switch', [
        'Pause stops sending to the main stream without touching the others. Resume sends again.',
        'Choose another main stream any time; the old one keeps its own on/off setting.',
        'The share link on Go live is the main stream’s link.',
      ]],
      ['More destinations', [
        'Streaming > Also stream to: switch Facebook or Instagram on, or Add destination for more YouTube channels and stream keys.',
        'Make a stream-key destination vertical (9:16) for phone-first platforms.',
        'Embed the player on your website with the code on the Streaming tab.',
      ]],
      ['Branding and theme', [
        'Event > Branding & theme: pick the theme closest to your event (cricket, football, wedding, festival, conference…) and a main colour. Free.',
        'Your logo shows at the top left of the watch page and as the watermark at the bottom right of the video. Without it, the Go Live logo is used.',
        'The scrolling ticker runs along the bottom of the video, like a news channel: your lines plus sponsor messages. Switch it on or off and edit it live in the control room (Graphics).',
      ]],
    ],
  },
  {
    id: 'golive',
    title: 'Going live in the control room',
    summary: 'Start the show, choose cameras, add graphics and sound, go live.',
    sections: [
      ['Before going live', [
        'Start show: starts Cloud OBS (or waits for Laptop OBS) and prepares the main stream.',
        'Check every camera shows a picture in the control room. Fix sound levels on the Audio tab.',
      ]],
      ['On air', [
        'Click a camera to preview it, then Take to put it on air (or Cut for an instant switch).',
        'Graphics: lower thirds, leaderboard, hole card and score bug. Replay plays back the last moments.',
        'Go live sends the show to the main stream and every destination that is on. Share the watch link.',
        'End stream when you are done. Clips and the replay stay available.',
      ]],
    ],
  },
  {
    id: 'after',
    title: 'After the show',
    summary: 'Replays, clips, chat, credits and the next event.',
    sections: [
      ['Keep and share', [
        'The watch page plays the replay after the show. The Streaming tab lists replays.',
        'Clips: cut highlights during or after the show and share them.',
        'Chat: review and moderate what viewers wrote.',
      ]],
      ['Next time', [
        'Copy an event to keep its settings, cameras plan and games.',
        'Wallet: check credits used and buy more.',
        'Help > Raise a ticket if anything went wrong; attach screenshots.',
      ]],
    ],
  },
];

const byId = (id) => TOPICS.find((t) => t.id === id) ?? TOPICS[0];

function body(topic, onNav) {
  const t = byId(topic);
  const i = TOPICS.indexOf(t);
  return el('div', { class: 'guide' },
    el('div', { class: 'small muted', text: `Step ${i + 1} of ${TOPICS.length} · Go Live guide` }),
    el('h2', { style: 'margin-top:4px', text: t.title }),
    el('p', { class: 'muted', text: t.summary }),
    ...t.sections.map(([h, steps]) => el('div', { class: 'card', style: 'margin-bottom:10px' },
      el('strong', { text: h }),
      el('ol', { class: 'guide-steps' }, steps.map((s) => el('li', { text: s }))))),
    el('div', { class: 'row', style: 'margin-top:8px' },
      i > 0 ? el('button', { class: 'btn small', onclick: () => onNav(TOPICS[i - 1].id), text: `← ${TOPICS[i - 1].title}` }) : null,
      el('div', { class: 'sp' }),
      i < TOPICS.length - 1 ? el('button', { class: 'btn small primary', onclick: () => onNav(TOPICS[i + 1].id), text: `${TOPICS[i + 1].title} →` }) : null));
}

/** A side drawer with one guide topic; stays over the page you are on. */
export function openGuide(topic) {
  document.querySelector('.drawer-wrap')?.remove();
  const wrap = el('div', { class: 'drawer-wrap', onclick: (e) => { if (e.target === wrap) close(); } });
  const panel = el('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'Guide' });
  const close = () => { wrap.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  const show = (id) => panel.replaceChildren(
    el('div', { class: 'row', style: 'margin-bottom:6px' },
      el('a', { class: 'small', href: `/web/guide/${id}`, onclick: (e) => { e.preventDefault(); close(); go(`/web/guide/${id}`); }, text: 'Open the full guide' }),
      el('div', { class: 'sp' }),
      el('button', { class: 'btn small ghost', 'aria-label': 'Close', onclick: close, text: '✕' })),
    body(id, show));
  show(topic);
  wrap.append(panel);
  document.body.append(wrap);
  return close;
}

/** The ⓘ button next to a feature: opens its guide topic in the drawer. */
export function info(topic, label = 'How this works') {
  return el('button', { class: 'info-i', type: 'button', title: label, 'aria-label': label, onclick: (e) => { e.preventDefault(); e.stopPropagation(); openGuide(topic); }, text: 'i' });
}

export async function render(view, { topic } = {}) {
  const nav = (id) => go(`/web/guide/${id}`);
  view.append(
    el('div', { class: 'guide-layout' },
      el('nav', { class: 'guide-toc' }, TOPICS.map((t, i) => el('a', {
        href: `/web/guide/${t.id}`, class: (topic ?? 'start') === t.id ? 'on' : null,
        onclick: (e) => { e.preventDefault(); nav(t.id); },
      }, el('span', { class: 'n', text: String(i + 1) }), el('span', {}, el('strong', { text: t.title }), el('div', { class: 'small muted', text: t.summary }))))),
      el('div', {}, body(topic ?? 'start', nav))));
}

/** Help, the product tour and the setup steps: start any of them again. */
export function learnCard() {
  const club = state.orgs.some((o) => o.id === state.orgId && ['owner', 'director'].includes(o.role));
  return el('div', { class: 'card', style: 'margin-bottom:16px' },
    el('strong', { text: 'Learn Go Live' }),
    el('p', { class: 'small muted', style: 'margin:4px 0 10px', text: 'A step-by-step guide to every feature, a 2-minute tour of the screens, and the 4 setup steps for your first show.' }),
    el('div', { class: 'row', style: 'flex-wrap:wrap' },
      el('button', { class: 'btn primary', onclick: () => go('/web/guide'), text: 'Open the guide' }),
      club ? el('button', { class: 'btn', onclick: () => import('./tour.js').then((m) => m.startTour(true)), text: 'Take the product tour' }) : null,
      club ? el('button', { class: 'btn', onclick: () => import('./onboarding.js').then((m) => m.restartSetup()), text: 'Restart the setup steps' }) : null));
}
