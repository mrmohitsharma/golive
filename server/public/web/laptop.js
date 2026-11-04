// Laptop OBS made easy (V8): download the Go Live app, type the 6-digit code it shows, and the
// steps tick themselves as the laptop, OBS and the cameras come up. Also the /web/pair page
// that the app opens in the browser (code filled in, pick the event).
import { get, post, patch, del, el, toast, guard, go, confirmBox } from './core.js';

export const title = 'Link a laptop';

const STEP_ICON = { done: '✓', now: '•', todo: '' };

/** Which download fits this computer: Windows, Mac Apple Silicon or Mac Intel. */
async function myOs() {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) {
    try {
      const h = await navigator.userAgentData?.getHighEntropyValues?.(['architecture']);
      if (h?.architecture === 'x86') return 'mac-intel';
    } catch { /* Safari, Firefox: assume Apple Silicon (every Mac since late 2020) */ }
    return 'mac-arm';
  }
  return 'other';
}

const codeInput = (value = '') => el('input', {
  class: 'pair-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '7', placeholder: '123 456', value,
  oninput: (e) => { const d = e.target.value.replace(/\D/g, '').slice(0, 6); e.target.value = d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d; },
});

function step(n, state, head, ...body) {
  return el('li', { class: 'lstep ' + state },
    el('span', { class: 'lstep-n', text: STEP_ICON[state] || String(n) }),
    el('div', { class: 'lstep-b' }, el('strong', { text: head }), ...body));
}

/** The "Laptop OBS" tab of an event. Returns a cleanup that stops the live checks. */
export async function render(body, id, s) {
  const os = await myOs();
  let v = await get(`/api/tournaments/${id}/laptops`);
  let timer = null;
  let busy = false;
  const code = codeInput();

  const refresh = async () => {
    if (busy || !body.isConnected) return;
    try { v = await get(`/api/tournaments/${id}/laptops`); draw(); } catch { /* keep the last view */ }
  };

  const draw = () => {
    const mine = v.laptops.find((l) => l.id === v.laptopId) ?? null;
    const anyPaired = v.laptops.length > 0;
    const e = v.engine;
    const s1 = anyPaired ? 'done' : 'now';
    const s2 = mine ? 'done' : anyPaired || s1 === 'done' ? 'now' : 'todo';
    const s3 = mine && e.obsConnected ? 'done' : mine ? 'now' : 'todo';
    const s4 = s3 === 'done' && v.cameras.sending > 0 ? 'done' : s3 === 'done' ? 'now' : 'todo';
    const all = s4 === 'done';

    const dl = (key, label, primary) => el('a', { class: 'btn' + (primary ? ' primary' : ''), href: v.downloads[key], text: label });
    const downloads = os === 'windows'
      ? [dl('windows', 'Download for Windows', true), dl('macArm', 'Mac')]
      : os === 'mac-arm' ? [dl('macArm', 'Download for Mac (Apple chip)', true), dl('macIntel', 'Mac with Intel chip'), dl('windows', 'Windows')]
        : os === 'mac-intel' ? [dl('macIntel', 'Download for Mac (Intel)', true), dl('macArm', 'Mac with Apple chip'), dl('windows', 'Windows')]
          : [dl('windows', 'Windows', true), dl('macArm', 'Mac (Apple chip)'), dl('macIntel', 'Mac (Intel)')];

    const others = v.laptops.filter((l) => l.id !== v.laptopId);
    const laptopRow = (l) => el('div', { class: 'row lap' },
      el('span', { class: 'dot ' + (l.online ? 'on' : '') }),
      el('div', { style: 'flex:1;min-width:0' }, el('strong', { text: l.name }),
        el('div', { class: 'small muted', text: `${l.online ? 'Online' : 'Offline'}${l.event && !l.event.thisEvent ? ` · runs ${l.event.name}` : ''}${l.os ? ` · ${l.os === 'mac' ? 'Mac' : l.os === 'windows' ? 'Windows' : l.os}` : ''}` })),
      l.id === v.laptopId
        ? el('button', { class: 'btn small ghost', onclick: guard(async () => { v = await post(`/api/tournaments/${id}/laptops/${l.id}/release`, {}); toast('Laptop taken off this event'); draw(); }), text: 'Take off this event' })
        : el('button', { class: 'btn small', onclick: guard(async () => {
            if (l.event && !(await confirmBox(`Use ${l.name} here?`, `It runs "${l.event.name}" now and will switch to this event.`, 'Use it here', false))) return;
            v = await post(`/api/tournaments/${id}/laptops/${l.id}/use`, {}); toast(`${l.name} now runs this event`); draw();
          }), text: 'Use for this event' }),
      el('button', { class: 'btn small ghost', title: 'Forget this laptop', onclick: guard(async () => {
        if (!(await confirmBox(`Forget ${l.name}?`, 'It will need a new code before it can run an event again.', 'Forget', true))) return;
        v = await del(`/api/tournaments/${id}/laptops/${l.id}`); draw();
      }), text: '✕' }));

    const pairForm = el('form', { class: 'row', style: 'flex-wrap:wrap;margin-top:8px', onsubmit: guard(async (ev) => {
      ev.preventDefault();
      busy = true;
      try { v = await post(`/api/tournaments/${id}/laptops/pair`, { code: code.value }); code.value = ''; toast('Laptop linked to this event'); } finally { busy = false; }
      draw();
    }) }, code, el('button', { class: 'btn primary', type: 'submit', text: 'Link laptop' }));

    const obsDetail = !mine ? null
      : !mine.online ? el('p', { class: 'small muted', text: `Waiting for ${mine.name}: open the Go Live app on it (it starts OBS for you).` })
        : !e.connected ? el('p', { class: 'small muted', text: `${mine.name} is online. Connecting to the event…` })
          : !e.obsConnected ? el('p', { class: 'small muted', text: e.lastError ? `OBS: ${e.lastError}` : 'Waiting for OBS to open on the laptop…' })
            : el('p', { class: 'small', text: `OBS ${e.obsVersion ?? ''} is ready.` });

    body.replaceChildren(
      s.tournament.mode !== 'laptop' ? el('div', { class: 'banner warn row' }, el('span', { style: 'flex:1', text: 'This event is set to Cloud OBS. Switch it to Laptop OBS to run it from your laptop.' }),
        el('button', { class: 'btn small primary', onclick: guard(async () => { await patch(`/api/tournaments/${id}`, { mode: 'laptop' }); go(`/web/e/${id}/laptop`); }), text: 'Use Laptop OBS' })) : null,
      el('div', { class: 'card' },
        el('div', { class: 'row' }, el('strong', { text: 'Run this event from your laptop' }), el('div', { class: 'sp' }),
          all ? el('span', { class: 'pill ok', text: 'Ready to go live' }) : el('span', { class: 'small muted', text: 'Each step ticks itself' })),
        el('p', { class: 'small muted', style: 'margin:4px 0 0', text: 'OBS Studio on your laptop mixes the cameras. The Go Live app sets OBS up and links it to this event. No settings to copy.' }),
        el('ol', { class: 'lsteps' },
          step(1, s1, 'Get the Go Live app on the laptop',
            el('p', { class: 'small muted', text: 'Free. Also needs OBS Studio (free); the app opens its download page if it is missing.' }),
            el('div', { class: 'row', style: 'flex-wrap:wrap' }, ...downloads),
            el('details', { class: 'small muted', style: 'margin-top:6px' }, el('summary', { text: 'Windows or Mac says it cannot check the app?' }),
              el('p', { text: 'Windows: click "More info", then "Run anyway". Mac: unzip, then right-click "Go Live Agent" > Open > Open (or System Settings > Privacy & Security > Open Anyway). Only the first time.' }))),
          step(2, s2, 'Link the laptop to this event',
            mine ? el('p', { class: 'small', text: `${mine.name} runs this event.` }) : el('p', { class: 'small muted', text: 'Open the app. It shows a 6-digit code: type it here.' }),
            mine ? null : pairForm,
            v.laptops.length ? el('div', { class: 'laps' }, ...(mine ? [mine] : []).concat(others).map(laptopRow)) : null),
          step(3, s3, 'OBS ready', obsDetail ?? el('p', { class: 'small muted', text: 'The app opens OBS and sets it up (it asks once).' }),
            ...(mine && e.warnings?.length ? e.warnings.map((w) => el('p', { class: 'small', style: 'color:var(--warn,#e0a030)', text: w })) : [])),
          step(4, s4, 'Cameras in OBS',
            el('p', { class: 'small ' + (v.cameras.sending ? '' : 'muted'), text: v.cameras.total ? `${v.cameras.sending} of ${v.cameras.total} camera${v.cameras.total > 1 ? 's' : ''} sending video. Each appears in OBS on its own.` : 'No cameras yet.' }),
            v.cameras.sending ? null : el('a', { href: `/web/e/${id}/people`, onclick: (ev) => { ev.preventDefault(); go(`/web/e/${id}/people`); }, class: 'small', text: 'Invite camera volunteers' }))),
        el('div', { class: 'row', style: 'margin-top:10px' }, el('div', { class: 'sp' }),
          el('a', { class: 'btn' + (all ? ' primary' : ''), href: `/web/e/${id}/control`, text: 'Open control room' }))),
      el('details', { class: 'small muted', style: 'margin-top:14px' }, el('summary', { text: 'Advanced: run the agent from a settings file instead' }),
        el('p', { text: 'For the command-line agent (Node.js) or a fixed studio PC: Streaming tab > Laptop OBS settings file.' })));
  };

  draw();
  timer = setInterval(refresh, 3000);
  return () => clearInterval(timer);
}

/** /web/pair?code=123456: opened by the app. Pick the event this laptop should run. */
export async function renderPair(view) {
  const q = new URLSearchParams(location.search);
  const code = codeInput(q.get('code') ? `${q.get('code').slice(0, 3)} ${q.get('code').slice(3, 6)}` : '');
  const { tournaments } = await get('/api/tournaments');
  const events = tournaments.filter((t) => !t.archived);
  const pick = (t) => guard(async () => {
    if (t.mode !== 'laptop') {
      if (!(await confirmBox(`Run "${t.name}" from this laptop?`, 'It is set to Cloud OBS. It will switch to Laptop OBS.', 'Switch and link', false))) return;
      await patch(`/api/tournaments/${t.id}`, { mode: 'laptop' });
    }
    await post(`/api/tournaments/${t.id}/laptops/pair`, { code: code.value });
    toast('Laptop linked');
    go(`/web/e/${t.id}/laptop`);
  });
  view.append(el('div', { class: 'card', style: 'max-width:640px' },
    el('strong', { text: 'Link your laptop to an event' }),
    el('p', { class: 'small muted', text: 'This is the code shown in the Go Live app on your laptop. Pick the event the laptop should run.' }),
    code,
    events.length
      ? el('div', { class: 'laps', style: 'margin-top:12px' }, ...events.map((t) => el('div', { class: 'row lap' },
          el('div', { style: 'flex:1;min-width:0' }, el('strong', { text: t.name }), el('div', { class: 'small muted', text: `${t.orgName ?? ''}${t.mode === 'cloud' ? ' · Cloud OBS' : ' · Laptop OBS'}` })),
          el('button', { class: 'btn small primary', onclick: pick(t), text: 'Run this event' }))))
      : el('p', { class: 'small', text: 'You have no events yet. Create one first (Events > New event), then type the code on its Laptop OBS tab.' })));
}
