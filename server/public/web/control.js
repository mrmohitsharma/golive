// The control room in the browser: the same live connection and commands as the app.
import { state, get, post, patch, el, toast, guard, confirmBox, go } from './core.js';

export const title = 'Control room';

/** A WebRTC (WHEP) preview of one camera, like the app's. Retries every 3 s. */
class Whep {
  constructor(box) { this.box = box; this.url = null; this.pc = null; this.session = null; this.gen = 0; this.timer = null;
    this.video = el('video', { autoplay: true, muted: true, playsinline: true, style: 'width:100%;height:100%;object-fit:contain;background:#000;display:block' });
    this.note = el('div', { class: 'cr-note' }); box.replaceChildren(this.video, this.note); }
  async set(url) { if (url === this.url) return; this.url = url; await this.connect(); }
  async close() { this.gen++; clearTimeout(this.timer); const s = this.session; this.session = null; if (s) fetch(s, { method: 'DELETE', headers: { authorization: 'Bearer ' + state.token } }).catch(() => {}); this.pc?.close(); this.pc = null; this.video.srcObject = null; }
  async connect() {
    await this.close(); const gen = ++this.gen;
    if (!this.url) { this.note.textContent = 'No camera'; return; }
    this.note.textContent = 'Connecting…';
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      this.pc = pc;
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.ontrack = (e) => { if (gen === this.gen) { this.video.srcObject = e.streams[0] ?? new MediaStream([e.track]); this.note.textContent = ''; } };
      pc.onconnectionstatechange = () => { if (gen === this.gen && ['failed', 'disconnected'].includes(pc.connectionState)) this.fail('Preview connection lost'); };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => { if (pc.iceGatheringState === 'complete') return r(); const t = setTimeout(r, 2000); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); r(); } }; });
      const res = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/sdp', authorization: 'Bearer ' + state.token }, body: pc.localDescription.sdp });
      if (gen !== this.gen) return;
      if (res.status === 404) throw new Error('No signal from this camera');
      if (res.status !== 201) throw new Error(`Preview unavailable (${res.status})`);
      const loc = res.headers.get('location');
      if (loc) this.session = `${this.url}/${loc.split('/').pop()}`;
      await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    } catch (e) { if (gen === this.gen) this.fail(e instanceof TypeError ? 'Preview unavailable: is the media server reachable?' : e.message); }
  }
  fail(msg) { this.note.textContent = msg; clearTimeout(this.timer); const gen = this.gen; this.timer = setTimeout(() => { if (gen === this.gen) this.connect(); }, 3000); }
}

export async function render(view, { id }) {
  document.body.classList.add('wide');
  const s0 = await get(`/api/tournaments/${id}/state`);
  if (!['owner', 'director'].includes(s0.role) && !state.me.platformAdmin) throw new Error('Only owners and directors can open the control room.');
  document.getElementById('title').textContent = `${s0.tournament.name} · Control room`;
  let s = s0;
  let players = [];
  let moments = { moments: [], runs: [] };
  const pending = new Map();
  let ws = null, closed = false, wsTimer = null, thumbTimer = null;

  // ---------------------------------------------------------------- layout
  const status = el('div', { class: 'row' });
  const pgmBox = el('div', { class: 'cr-mon pgm' }), pvwBox = el('div', { class: 'cr-mon pvw' });
  const pgm = new Whep(pgmBox), pvw = new Whep(pvwBox);
  const pgmLabel = el('div', { class: 'cr-label' }), pvwLabel = el('div', { class: 'cr-label' });
  const grid = el('div', { class: 'cr-grid' });
  const side = el('div', { class: 'cr-side' });
  const alerts = el('div', { class: 'cr-alerts' });
  const replaySec = el('select', {}, [5, 10, 15, 20, 30].map((n) => el('option', { value: n, selected: n === 10 || undefined, text: `${n} s` })));
  const slow = el('input', { type: 'checkbox' });
  const tabs = ['Graphics', 'Audio', 'Games', 'Chat', 'Clips'];
  let tab = 'Graphics';

  const send = (action, extra = {}) => {
    if (!ws || ws.readyState !== 1) return toast('Not connected to the server yet', true);
    const requestId = Math.random().toString(36).slice(2);
    pending.set(requestId, action);
    ws.send(JSON.stringify({ type: 'command', action, requestId, ...extra }));
  };
  const cams = () => s.cameras ?? [];
  const camName = (cid) => cams().find((c) => c.id === cid)?.name ?? '–';

  const drawStatus = () => {
    const e = s.engine ?? {};
    const live = e.streaming?.active;
    const b = s.billing;
    status.replaceChildren(
      el('span', { class: 'pill ' + (live ? 'live' : ''), text: live ? `LIVE ${e.streaming.timecode ?? ''}` : 'OFF AIR' }),
      el('span', { class: 'pill ' + (e.connected && e.obsConnected ? 'ok' : 'bad'), text: e.connected && e.obsConnected ? 'Engine ready' : 'Engine not connected' }),
      s.production?.mode === 'cloud' ? el('span', { class: 'small muted', text: `Cloud mixer: ${s.production.cloud.status}` }) : null,
      b && b.minutes.remainingSeconds != null ? el('span', { class: 'small ' + (b.minutes.remainingSeconds < 600 ? 'pill warn' : 'muted'), text: `${Math.floor(b.minutes.remainingSeconds / 60)} min of credit left` }) : null,
      (e.warnings ?? []).length ? el('span', { class: 'pill warn', title: e.warnings.join('\n'), text: `${e.warnings.length} warning${e.warnings.length > 1 ? 's' : ''}` }) : null,
      el('div', { class: 'sp' }),
      el('a', { class: 'btn small', href: `/watch/${id}`, target: '_blank', rel: 'noopener', text: 'Watch page' }),
      el('a', { class: 'btn small', href: `/web/e/${id}`, onclick: (ev) => { ev.preventDefault(); go(`/web/e/${id}`); }, text: 'Event' }),
      live ? el('button', { class: 'btn danger', onclick: guard(async () => { if (await confirmBox('End the broadcast?', 'The stream stops on every platform.', 'End broadcast')) send('stream.stop'); }), text: 'End broadcast' })
        : el('button', { class: 'btn primary', disabled: b && !b.canGoLive, title: b?.reason ?? '', onclick: guard(async () => { if (await confirmBox('Go live now?', 'The programme goes out on YouTube and every platform that is on.', 'Go live', false)) send('stream.start'); }), text: '● Go live' }));
  };

  const drawMonitors = () => {
    const e = s.engine ?? {};
    const on = cams().find((c) => c.id === e.programmeCameraId);
    const pv = cams().find((c) => c.id === e.previewCameraId);
    pgm.set(on && !e.replayActive && !e.fallbackActive ? on.whepUrl : null);
    pvw.set(pv?.whepUrl ?? null);
    pgmLabel.replaceChildren(el('span', { class: 'pill live', text: 'PROGRAM' }), ' ', e.replayActive ? 'Replay' : e.fallbackActive ? 'Fallback screen' : on?.name ?? 'Nothing on air');
    pvwLabel.replaceChildren(el('span', { class: 'pill ok', text: 'PREVIEW' }), ' ', pv?.name ?? 'Pick a camera below');
  };

  const drawGrid = () => {
    const e = s.engine ?? {};
    const t = Date.now();
    grid.replaceChildren(...cams().map((c, i) => el('div', { class: 'cr-cam' + (c.id === e.programmeCameraId ? ' on' : '') + (c.id === e.previewCameraId ? ' pv' : ''), onclick: () => send('preview', { cameraId: c.id }), ondblclick: () => send('cut', { cameraId: c.id }), title: 'Click: preview · Double-click: cut to air' },
      el('img', { src: `/api/cameras/${c.id}/thumbnail.jpg?token=${encodeURIComponent(state.token)}&t=${t}`, alt: '', onerror: (ev) => ev.target.style.visibility = 'hidden' }),
      el('div', { class: 'cr-cam-name' }, el('b', { text: `${i + 1} ` }), c.name, c.hole ? ` · ${s.tournament.profile?.positionLabel ?? 'Hole'} ${c.hole}` : ''),
      el('span', { class: 'cr-dot ' + c.status, title: c.status }),
      el('button', { class: 'btn small', onclick: (ev) => { ev.stopPropagation(); send('cut', { cameraId: c.id }); }, text: 'Cut' }))),
      cams().length ? null : el('div', { class: 'empty', text: 'No cameras yet: phones join with the camera QR (Event > Cameras & people).' }));
  };

  // ---------------------------------------------------------------- side panels
  const drawSide = async () => {
    const bar = el('div', { class: 'tabs' }, tabs.map((t) => el('a', { href: '#', class: t === tab ? 'on' : null, onclick: (ev) => { ev.preventDefault(); tab = t; drawSide(); }, text: t })));
    const body = el('div');
    side.replaceChildren(bar, body);
    const g = s.graphics ?? {};
    const gpatch = guard(async (p) => { await patch(`/api/tournaments/${id}/graphics`, p); });
    if (tab === 'Graphics') {
      const who = el('select', {}, el('option', { value: '', text: 'Choose a player…' }), players.map((p) => el('option', { value: p.id, selected: p.id === g.lowerThird?.playerId || undefined, text: p.name })));
      const ttl = el('input', { placeholder: 'Or type a name', value: g.lowerThird?.playerId ? '' : (g.lowerThird?.title ?? '') });
      const sub = el('input', { placeholder: 'Second line', value: g.lowerThird?.playerId ? '' : (g.lowerThird?.subtitle ?? '') });
      const toggle = (label, on, p) => el('button', { class: 'btn ' + (on ? 'primary' : ''), onclick: () => gpatch(p), text: `${label}: ${on ? 'ON' : 'off'}` });
      body.append(
        el('label', { text: 'Name caption (lower third)' }), who, el('div', { style: 'height:6px' }), ttl, el('div', { style: 'height:6px' }), sub,
        el('div', { class: 'row', style: 'margin:8px 0 16px' },
          el('button', { class: 'btn primary', onclick: () => gpatch({ lowerThird: who.value ? { visible: true, playerId: who.value } : { visible: true, playerId: null, title: ttl.value, subtitle: sub.value } }), text: 'Show caption' }),
          el('button', { class: 'btn', onclick: () => gpatch({ lowerThird: { visible: false } }), text: 'Hide' })),
        el('div', { class: 'row' },
          toggle('Leaderboard', g.leaderboard?.visible, { leaderboard: { visible: !g.leaderboard?.visible } }),
          toggle('Score bug', g.scoreBug?.visible, { scoreBug: { visible: !g.scoreBug?.visible } }),
          toggle('Hole card', g.holeCard?.visible, { holeCard: { visible: !g.holeCard?.visible } }),
          toggle('Auto hole card', g.holeCard?.auto, { holeCard: { auto: !g.holeCard?.auto } }),
          g.question?.visible ? el('button', { class: 'btn primary', onclick: () => gpatch({ question: { visible: false } }), text: 'Viewer question: ON' }) : null));
    } else if (tab === 'Audio') {
      const a = s.audio ?? {};
      const slider = (label, key, muteKey) => {
        const r = el('input', { type: 'range', min: -60, max: 6, step: 1, value: a[key] ?? 0 });
        const v = el('span', { class: 'small mono', text: `${a[key] ?? 0} dB` });
        r.oninput = () => (v.textContent = `${r.value} dB`);
        r.onchange = guard(async () => { await patch(`/api/tournaments/${id}/audio`, { [key]: Number(r.value) }); });
        const m = el('input', { type: 'checkbox' }); m.checked = Boolean(a[muteKey]);
        m.onchange = guard(async () => { await patch(`/api/tournaments/${id}/audio`, { [muteKey]: m.checked }); });
        return el('div', { style: 'margin-bottom:14px' }, el('div', { class: 'row' }, el('strong', { text: label }), el('div', { class: 'sp' }), v, el('label', { class: 'check' }, m, 'Mute')), r);
      };
      const duck = el('input', { type: 'checkbox' }); duck.checked = Boolean(a.ducking);
      duck.onchange = guard(async () => { await patch(`/api/tournaments/${id}/audio`, { ducking: duck.checked }); });
      body.append(slider('Course (camera) sound', 'courseDb', 'courseMuted'), slider('Commentary', 'commentaryDb', 'commentaryMuted'),
        el('label', { class: 'check' }, duck, 'Lower course sound while commentators talk'));
    } else if (tab === 'Games') {
      moments = await get(`/api/tournaments/${id}/moments`).catch(() => ({ moments: [], runs: [] }));
      body.append(el('p', { class: 'small muted' }, 'Director games open for everyone watching. Set them up under ', el('a', { href: `/web/e/${id}/engagement`, text: 'Influencers & games' }), '.'),
        ...(moments.moments.length ? moments.moments.map((m) => el('div', { class: 'card', style: 'margin-bottom:8px;padding:10px' },
          el('div', { class: 'row' }, el('strong', { text: m.title }), el('span', { class: 'pill', text: m.type }), el('div', { class: 'sp' }),
            m.clock === 'director' ? el('button', { class: 'btn small primary', onclick: guard(async () => { await post(`/api/tournaments/${id}/moments/${m.id}/fire`); toast(`${m.title} is open`); }), text: 'Fire now' }) : el('span', { class: 'small muted', text: `${m.clock} clock` }),
            m.pick === 'draw' || m.type === 'draw' ? el('button', { class: 'btn small', onclick: guard(async () => { const r = await post(`/api/tournaments/${id}/moments/${m.id}/draw`); toast(`Draw done: ${r.winners?.length ?? 0} winner(s)`); }), text: 'Run draw' }) : null)))
          : [el('div', { class: 'empty', text: 'No games set up.' })]));
    } else if (tab === 'Chat') {
      const c = await get(`/api/tournaments/${id}/chat`).catch(() => ({ messages: [] }));
      body.append(...(c.messages ?? []).slice(-40).reverse().map((m) => el('div', { class: 'cr-msg' + (m.hidden ? ' hidden' : '') },
        el('div', { class: 'small muted', text: `${m.author} · ${m.source}` }), el('div', { text: m.text }),
        el('div', { class: 'row', style: 'margin-top:4px' },
          el('button', { class: 'btn small', onclick: guard(async () => { await post(`/api/chat/${m.id}/on-air`, { visible: true }); toast('On air'); }), text: 'On air' }),
          el('button', { class: 'btn small', onclick: guard(async () => { await patch(`/api/chat/${m.id}`, { pinned: !m.pinned }); drawSide(); }), text: m.pinned ? 'Unpin' : 'Pin' }),
          el('button', { class: 'btn small', onclick: guard(async () => { await patch(`/api/chat/${m.id}`, { hidden: !m.hidden }); drawSide(); }), text: m.hidden ? 'Show' : 'Hide' })))),
        (c.messages ?? []).length ? null : el('div', { class: 'empty', text: 'No messages yet.' }));
    } else if (tab === 'Clips') {
      const on = s.engine?.programmeCameraId;
      body.append(el('p', { class: 'small muted', text: 'Saves the last seconds of the camera on air as a clip (16:9 and 9:16), ready to share.' }),
        el('div', { class: 'row' }, [15, 30, 60].map((n) => el('button', { class: 'btn', disabled: !on, onclick: guard(async () => { await post(`/api/tournaments/${id}/clips`, { cameraId: on, secondsBack: n, durationSec: n }); toast(`Clip of the last ${n} s is being made`); }), text: `Last ${n} s` }))),
        el('p', {}, el('a', { href: `/web/e/${id}/clips`, text: 'All clips' })));
    }
  };

  // ---------------------------------------------------------------- live connection
  const onMessage = (m) => {
    switch (m.type) {
      case 'snapshot': s = { ...s, ...m }; drawAll(); break;
      case 'cameras': s.cameras = m.cameras; s.commentators = m.commentators; drawMonitors(); drawGrid(); break;
      case 'engine': s.engine = m.engine ?? m; drawStatus(); drawMonitors(); drawGrid(); break;
      case 'graphics': s.graphics = m.graphics ?? m; if (tab === 'Graphics') drawSide(); break;
      case 'audio': s.audio = m.audio ?? m; break;
      case 'production': s.production = m.production ?? m; drawStatus(); break;
      case 'billing': s.billing = m.billing ?? m; drawStatus(); break;
      case 'chat': if (tab === 'Chat') drawSide(); break;
      case 'clip': if ((m.clip ?? m).status === 'ready') toast(`Clip ready: ${(m.clip ?? m).title ?? (m.clip ?? m).cameraName}`); break;
      case 'alert': alerts.prepend(el('div', { class: 'cr-alert ' + m.level, text: `${new Date(m.at ?? Date.now()).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} ${m.message}` })); if (m.level !== 'info') toast(m.message, m.level === 'error'); break;
      case 'command.result': { const a = pending.get(m.requestId); pending.delete(m.requestId); if (!m.ok) toast(`${a ?? m.action}: ${m.error ?? 'failed'}`, true); break; }
      case 'error': toast(m.message, true); break;
    }
  };
  const connect = () => {
    if (closed) return;
    ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(state.token)}`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', tournamentId: id }));
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => { if (!closed) { status.prepend(el('span', { class: 'pill bad', text: 'Reconnecting…' })); wsTimer = setTimeout(connect, 2000); } };
  };
  const drawAll = () => { drawStatus(); drawMonitors(); drawGrid(); drawSide(); };

  // Keyboard: 1–9 preview a camera, Shift+1–9 cut to it, Space or Enter = Take.
  const keys = (e) => {
    if (/input|select|textarea/i.test(e.target.tagName)) return;
    const n = Number(e.key);
    if (n >= 1 && n <= 9 && cams()[n - 1]) { e.preventDefault(); send(e.shiftKey ? 'cut' : 'preview', { cameraId: cams()[n - 1].id }); }
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); send('take'); }
  };
  const shift = (e) => { if (e.code?.startsWith('Digit') && e.shiftKey) { const n = Number(e.code.slice(5)); if (cams()[n - 1]) { e.preventDefault(); send('cut', { cameraId: cams()[n - 1].id }); } } };

  view.append(
    status,
    el('div', { class: 'cr' },
      el('div', { class: 'cr-main' },
        el('div', { class: 'cr-monitors' }, el('div', {}, pvwLabel, pvwBox), el('div', {}, pgmLabel, pgmBox)),
        el('div', { class: 'row cr-actions' },
          el('button', { class: 'btn primary cr-take', onclick: () => send('take'), title: 'Space or Enter', text: 'TAKE ▶' }),
          el('button', { class: 'btn', onclick: () => send('fallback'), text: 'Fallback screen' }),
          el('span', { class: 'sp' }),
          el('span', { class: 'small muted', text: 'Replay' }), el('div', { style: 'width:90px' }, replaySec), el('label', { class: 'check' }, slow, 'Slow-mo'),
          el('button', { class: 'btn', onclick: () => send('replay', { seconds: Number(replaySec.value), slowmo: slow.checked }), text: '⟲ Replay' })),
        grid,
        el('p', { class: 'small muted', text: 'Click a camera to preview it, then TAKE. Double-click (or Cut) puts it on air at once. Keys: 1–9 preview, Shift+1–9 cut, Space take.' })),
      el('div', {}, side, el('h2', { text: 'Alerts' }), alerts)));

  players = (await get(`/api/tournaments/${id}/players`).catch(() => ({ players: [] }))).players;
  drawAll();
  connect();
  document.addEventListener('keydown', keys);
  document.addEventListener('keydown', shift, true);
  thumbTimer = setInterval(drawGrid, 5000);
  return () => {
    closed = true; clearTimeout(wsTimer); clearInterval(thumbTimer); ws?.close(); pgm.close(); pvw.close();
    document.removeEventListener('keydown', keys); document.removeEventListener('keydown', shift, true);
    document.body.classList.remove('wide');
  };
}
