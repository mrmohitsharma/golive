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

/** Sends this browser's microphone as commentary (WHIP), like the commentator app. */
class Whip {
  constructor() { this.pc = null; this.stream = null; this.session = null; this.bearer = null; }
  get on() { return Boolean(this.pc); }
  async start(whipUrl, bearer, deviceId) {
    this.bearer = bearer;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.pc = pc;
    for (const tr of this.stream.getAudioTracks()) pc.addTransceiver(tr, { direction: 'sendonly', streams: [this.stream] });
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => { if (pc.iceGatheringState === 'complete') return r(); const t = setTimeout(r, 2000); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); r(); } }; });
    const res = await fetch(whipUrl, { method: 'POST', headers: { 'content-type': 'application/sdp', authorization: 'Bearer ' + bearer }, body: pc.localDescription.sdp });
    if (res.status !== 201) { await this.stop(); throw new Error(`Could not send the microphone (${res.status})`); }
    const loc = res.headers.get('location');
    if (loc) this.session = `${whipUrl}/${loc.split('/').pop()}`;
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
  }
  async stop() {
    if (this.session) fetch(this.session, { method: 'DELETE', headers: { authorization: 'Bearer ' + this.bearer } }).catch(() => {});
    this.session = null; this.pc?.close(); this.pc = null;
    this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null;
  }
}
const mic = new Whip();
const deviceId = () => { try { let d = localStorage.getItem('gl.device'); if (!d) { d = 'web-' + crypto.randomUUID(); localStorage.setItem('gl.device', d); } return d; } catch { return 'web-' + Date.now() + '-browser'; } };
const feedInput = (path) => `CG ${path} Feed`;
const commentaryInput = (path) => `CG Commentary ${path}`;
/** A level bar driven by the engine's meters (dBFS, about -60..0). */
const meter = (input) => el('div', { class: 'cr-meter', 'data-input': input }, el('i'));

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
        el('label', { text: 'Leaderboard' }),
        el('div', { class: 'row', style: 'margin-bottom:10px' },
          el('select', { style: 'width:auto', onchange: (e) => gpatch({ leaderboard: { size: Number(e.target.value) } }) }, [5, 8, 10, 12, 15].map((n) => el('option', { value: n, selected: n === (g.leaderboard?.size ?? 8) || undefined, text: `Top ${n}` }))),
          el('select', { style: 'width:auto', onchange: (e) => gpatch({ leaderboard: { category: e.target.value || null } }) },
            el('option', { value: '', text: 'All categories' }), [...new Set(players.map((p) => p.category).filter(Boolean))].map((c) => el('option', { value: c, selected: c === g.leaderboard?.category || undefined, text: c })))),
        el('label', { text: `${s.tournament.profile?.positionLabel ?? 'Hole'} card` }),
        el('div', { class: 'row', style: 'margin-bottom:12px' },
          el('select', { style: 'width:auto', onchange: (e) => gpatch({ holeCard: { hole: e.target.value ? Number(e.target.value) : null } }) },
            el('option', { value: '', text: 'Follow the camera on air' }), Array.from({ length: 18 }, (_, i) => i + 1).map((n) => el('option', { value: n, selected: n === g.holeCard?.hole || undefined, text: `${s.tournament.profile?.positionLabel ?? 'Hole'} ${n}` }))),
          el('button', { class: 'btn', onclick: () => gpatch({ holeCard: { visible: true } }), text: 'Show now' })),
        el('div', { class: 'row' },
          toggle('Leaderboard', g.leaderboard?.visible, { leaderboard: { visible: !g.leaderboard?.visible } }),
          toggle('Score bug', g.scoreBug?.visible, { scoreBug: { visible: !g.scoreBug?.visible } }),
          toggle('Hole card', g.holeCard?.visible, { holeCard: { visible: !g.holeCard?.visible } }),
          toggle('Auto hole card', g.holeCard?.auto, { holeCard: { auto: !g.holeCard?.auto } }),
          g.question?.visible ? el('button', { class: 'btn primary', onclick: () => gpatch({ question: { visible: false } }), text: 'Viewer question: ON' }) : null));
    } else if (tab === 'Audio') {
      const a = s.audio ?? {};
      const apatch = guard(async (p) => { await patch(`/api/tournaments/${id}/audio`, p); });
      const level = (value, onchange) => {
        const r = el('input', { type: 'range', min: -60, max: 6, step: 1, value });
        const v = el('span', { class: 'small mono', style: 'width:52px;text-align:right', text: `${value} dB` });
        r.oninput = () => (v.textContent = `${r.value} dB`);
        r.onchange = () => onchange(Number(r.value));
        return [r, v];
      };
      const mute = (on, onchange) => { const m = el('input', { type: 'checkbox' }); m.checked = Boolean(on); m.onchange = () => onchange(m.checked); return el('label', { class: 'check small' }, m, 'Mute'); };
      const row = (name, input, db, muted, onDb, onMute) => { const [r, v] = level(db, onDb); return el('div', { class: 'cr-ch' }, el('div', { class: 'row' }, el('strong', { class: 'small', text: name }), el('div', { class: 'sp' }), v, mute(muted, onMute)), r, input ? meter(input) : null); };
      const delay = el('input', { type: 'range', min: 0, max: 2000, step: 50, value: a.commentaryDelayMs ?? 0 });
      const delayV = el('span', { class: 'small mono', text: `${a.commentaryDelayMs ?? 0} ms` });
      delay.oninput = () => (delayV.textContent = `${delay.value} ms`);
      delay.onchange = () => apatch({ commentaryDelayMs: Number(delay.value) });
      const duck = el('input', { type: 'checkbox' }); duck.checked = Boolean(a.ducking);
      duck.onchange = () => apatch({ ducking: duck.checked });
      const micSel = el('select', {}, el('option', { value: '', text: 'Default microphone' }));
      navigator.mediaDevices?.enumerateDevices?.().then((ds) => ds.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default').forEach((d, i) => micSel.append(el('option', { value: d.deviceId, text: d.label || `Microphone ${i + 1}` })))).catch(() => {});
      body.append(
        el('h3', { class: 'cr-h', text: 'Course sound' }),
        row('All cameras', null, a.courseDb ?? 0, a.courseMuted, (v) => apatch({ courseDb: v }), (m) => apatch({ courseMuted: m })),
        ...cams().map((c) => row(c.name, feedInput(c.streamPath), a.cameras?.[c.id]?.db ?? 0, a.cameras?.[c.id]?.muted, (v) => apatch({ cameras: { [c.id]: { db: v } } }), (m) => apatch({ cameras: { [c.id]: { muted: m } } }))),
        el('h3', { class: 'cr-h', text: 'Commentary' }),
        row('All commentators', null, a.commentaryDb ?? 0, a.commentaryMuted, (v) => apatch({ commentaryDb: v }), (m) => apatch({ commentaryMuted: m })),
        el('div', { class: 'cr-ch' }, el('div', { class: 'row' }, el('strong', { class: 'small', text: 'Delay commentary (to match video)' }), el('div', { class: 'sp' }), delayV), delay),
        el('label', { class: 'check', style: 'margin:6px 0 10px' }, duck, 'Lower course sound while commentators talk'),
        ...(s.commentators ?? []).map((m) => el('div', { class: 'cr-ch' },
          el('div', { class: 'row' }, el('span', { class: 'cr-dot ' + (m.online ? 'live' : ''), style: 'position:static' }), el('strong', { class: 'small', text: m.name }), el('div', { class: 'sp' }),
            el('button', { class: 'btn small danger', onclick: guard(async () => { if (!(await confirmBox('Remove this commentator?', `${m.name} stops being heard on the stream.`, 'Remove'))) return; await fetch(`/api/commentators/${m.id}`, { method: 'DELETE', headers: { authorization: 'Bearer ' + state.token } }); toast('Commentator removed'); }), text: 'Remove' })),
          meter(commentaryInput(m.streamPath)))),
        el('div', { class: 'card', style: 'padding:10px;margin-top:8px' },
          el('strong', { class: 'small', text: 'Commentate from this browser' }),
          el('p', { class: 'small muted', style: 'margin:4px 0 8px', text: 'Uses this computer\'s microphone. Wear headphones so the stream sound is not picked up.' }),
          micSel,
          el('div', { class: 'row', style: 'margin-top:8px' },
            mic.on ? el('button', { class: 'btn danger', onclick: guard(async () => { await mic.stop(); toast('Microphone off'); drawSide(); }), text: '■ Stop commentating' })
              : el('button', { class: 'btn primary', onclick: guard(async () => {
                  const r = await post(`/api/tournaments/${id}/commentators/register`, { name: `${state.me.name} (web)`, deviceId: deviceId() });
                  await mic.start(r.publish.whipUrl, r.publish.bearer, micSel.value || undefined);
                  toast('You are on the commentary feed'); drawSide();
                }), text: '🎙 Start commentating' }))));
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
      case 'cameras': { const before = (s.commentators ?? []).map((c) => c.id + c.online).join(); s.cameras = m.cameras; s.commentators = m.commentators; drawMonitors(); drawGrid(); if (tab === 'Audio' && before !== (m.commentators ?? []).map((c) => c.id + c.online).join()) drawSide(); break; }
      case 'engine': s.engine = m.engine ?? m; drawStatus(); drawMonitors(); drawGrid(); break;
      case 'graphics': s.graphics = m.graphics ?? m; if (tab === 'Graphics') drawSide(); break;
      case 'audio': s.audio = m.audio ?? m; break;
      case 'production': s.production = m.production ?? m; drawStatus(); break;
      case 'billing': s.billing = m.billing ?? m; drawStatus(); break;
      case 'chat': if (tab === 'Chat') drawSide(); break;
      case 'meters': for (const bar of side.querySelectorAll('.cr-meter')) { const db = m.levels?.[bar.dataset.input]; bar.firstChild.style.width = db == null ? '0%' : `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`; bar.classList.toggle('hot', db != null && db > -6); } break;
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
    closed = true; clearTimeout(wsTimer); clearInterval(thumbTimer); ws?.close(); pgm.close(); pvw.close(); mic.stop();
    document.removeEventListener('keydown', keys); document.removeEventListener('keydown', shift, true);
    document.body.classList.remove('wide');
  };
}
