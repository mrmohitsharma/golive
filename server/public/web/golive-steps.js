// "Start show » Open control room » Pick camera » Take » Go live » Share link": the way from
// an event to a live show as one row of buttons. Done steps turn green, the next one glows
// and gets the cursor. Safe steps run by themselves (opening the control room, picking the
// only camera); Start show, Take and Go live always wait for the director's click.
// Used on top of the control room (live commands) and in setup step 4 (navigates there).
import { el, toast, guard, go, post, confirmBox, store } from './core.js';

const KEYS = ['start', 'room', 'pick', 'take', 'live', 'share'];

const sharedKey = (id) => 'gl.shared.' + id;

/** Which steps are done, from the event state (snapshot / websocket). */
export function doneSteps(s, inRoom) {
  const e = s.engine ?? {};
  const live = Boolean(e.streaming?.active);
  const ready = Boolean(e.connected && e.obsConnected);
  const onAir = Boolean(e.programmeCameraId) && !e.fallbackActive && !e.replayActive;
  return {
    start: ready || live,
    room: inRoom || live,
    pick: Boolean(e.previewCameraId) || onAir,
    take: onAir,
    live,
    share: live && store.get(sharedKey(s.tournament?.id ?? '')) === '1',
  };
}

/**
 * Creates the step row. opts:
 *  id, context: 'room' | 'setup', send(action, extra) (room only), onHide() (room only),
 *  onLeave() (setup: called before going to the control room).
 * Returns { node, update(state) }.
 */
export function goLiveSteps(opts) {
  const node = el('div', { class: 'gl-steps', role: 'group', 'aria-label': 'Steps to go live' });
  let last = null;
  let autoRoom = false;
  let autoPick = null;
  let s = null;

  const inRoom = opts.context === 'room';
  const link = () => s?.outputs?.main?.link || `${location.origin}/watch/${opts.id}`;
  const laptop = () => s?.production?.mode !== 'cloud';
  const liveCams = () => (s?.cameras ?? []).filter((c) => c.status === 'live');

  const toRoom = () => { opts.onLeave?.(); go(`/web/e/${opts.id}/control`); };

  const def = {
    start: {
      label: () => (laptop() ? 'Connect Laptop OBS' : s?.production?.cloud?.status === 'starting' ? 'Starting Cloud OBS…' : 'Start show'),
      hint: () => (laptop()
        ? 'Open the Go Live app on your laptop and link it to this event (Event > Laptop OBS).'
        : s?.production?.cloud?.status === 'starting' ? 'Cloud OBS is getting ready: about a minute. The next step lights up by itself.' : 'Turns on Cloud OBS and prepares your main stream. Takes about a minute.'),
      busy: () => !laptop() && s?.production?.cloud?.status === 'starting',
      run: guard(async () => {
        if (laptop()) { location.href = `/web/e/${opts.id}/laptop`; return; }
        const r = await post(`/api/tournaments/${opts.id}/start-show`, { privacy: 'unlisted' });
        toast(r.problems?.length ? r.problems.join(' ') : 'Cloud OBS is starting: about a minute', Boolean(r.problems?.length));
      }),
    },
    room: {
      label: () => 'Open control room',
      hint: () => 'The control room is where you choose cameras and go live.',
      run: () => (inRoom ? null : toRoom()),
    },
    pick: {
      label: () => 'Pick camera',
      hint: () => (liveCams().length ? 'Click a camera in the Cameras row: it appears in the small NEXT box.' : 'Waiting for a camera to send video. Phones join with the camera link (Event > Cameras & people).'),
      run: () => {
        if (!inRoom) return toRoom();
        const cams = liveCams();
        if (cams.length === 1) return opts.send('preview', { cameraId: cams[0].id });
        const grid = document.querySelector('.cr-grid');
        grid?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        grid?.classList.add('attention');
        setTimeout(() => grid?.classList.remove('attention'), 2400);
      },
    },
    take: {
      label: () => 'Take',
      hint: () => 'Press TAKE: the NEXT camera moves to the big ON AIR box. Viewers don’t see it until you go live.',
      run: () => (inRoom ? opts.send('take') : toRoom()),
    },
    live: {
      label: () => 'Go live',
      hint: () => `Press GO LIVE: the ON AIR picture goes to ${s?.outputs?.main?.label ?? 'your main stream'}${(s?.outputs?.destinations ?? []).some((d) => d.enabled) ? ' and your other destinations' : ''}.`,
      run: guard(async () => {
        if (!inRoom) return toRoom();
        if (await confirmBox('Go live now?', `The ON AIR picture goes out to ${s?.outputs?.main?.label ?? 'your main stream'} and every place that is switched on.`, 'Go live', false)) opts.send('stream.start');
      }),
    },
    share: {
      label: () => 'Share link',
      hint: () => 'Copy the watch link and send it to your viewers on WhatsApp or social media.',
      run: () => {
        const url = link();
        navigator.clipboard?.writeText(url).then(() => toast('Watch link copied: share it with your viewers'), () => toast(url));
        store.set(sharedKey(opts.id), '1');
        if (s) update(s);
      },
    },
  };

  function update(next) {
    s = next;
    const done = doneSteps(s, inRoom);
    const current = KEYS.find((k) => !done[k]) ?? null;
    const buttons = {};
    // The row is redrawn on every change: keep the cursor on the same step button.
    const hadFocus = node.contains(document.activeElement) ? document.activeElement.dataset?.step ?? null : null;
    node.classList.toggle('all-done', !current);
    node.replaceChildren(
      el('div', { class: 'gl-row' },
        ...KEYS.flatMap((k, i) => {
          const d = def[k];
          const state = done[k] ? 'done' : k === current ? 'current' : 'todo';
          const b = el('button', {
            type: 'button', class: `gl-step ${state}`, 'data-step': k,
            disabled: (state === 'current' && d.busy?.()) || undefined,
            'aria-current': state === 'current' ? 'step' : null,
            onclick: () => d.run(),
          }, el('span', { class: 'gl-n', text: done[k] ? '✓' : String(i + 1) }), el('span', { text: d.label() }));
          buttons[k] = b;
          return [i ? el('span', { class: 'gl-sep', 'aria-hidden': 'true', text: '»' }) : null, b];
        }),
        el('div', { class: 'sp' }),
        inRoom ? el('button', { class: 'btn small ghost', onclick: () => opts.onHide?.(), text: 'Hide guide' }) : null),
      el('div', { class: 'gl-hint' },
        current ? el('span', {}, el('strong', { text: `Step ${KEYS.indexOf(current) + 1} of ${KEYS.length}: ` }), def[current].hint())
          : el('span', {}, el('strong', { text: 'You’re live! ' }), 'To switch cameras: click a camera, then TAKE.')));

    // The next step glows and gets the cursor (never while someone is typing).
    const typing = /input|textarea|select/i.test(document.activeElement?.tagName ?? '');
    if (current && current !== last && last !== null && !typing) buttons[current].focus({ preventScroll: true });
    else if (hadFocus && buttons[hadFocus]) buttons[hadFocus].focus({ preventScroll: true });
    // Safe steps run by themselves, once.
    if (current === 'room' && !inRoom && !autoRoom && last === 'start') { autoRoom = true; setTimeout(toRoom, 900); }
    if (current === 'pick' && inRoom) {
      const cams = liveCams();
      // Only once the control room is connected; until then it tries again on the next update.
      if (cams.length === 1 && autoPick !== cams[0].id && opts.ready?.() && opts.send('preview', { cameraId: cams[0].id }) !== false) autoPick = cams[0].id;
    }
    last = current;
  }

  return { node, update };
}
