import { state, get, post, put, patch, del, api, el, stat, table, num, when, day, dialog, confirmBox, toast, guard, go } from './core.js';

export const title = 'Event';
const TABS = [['overview', 'Overview'], ['people', 'Cameras & people'], ['streaming', 'Streaming'], ['scores', 'Scores'], ['chat', 'Chat'], ['clips', 'Clips'], ['engagement', 'Influencers & games'], ['settings', 'Settings']];
const pill = (cls, text) => el('span', { class: 'pill ' + cls, text });

export async function render(view, { id, tab = 'overview' }) {
  const s = await get(`/api/tournaments/${id}/state`);
  const t = s.tournament;
  document.getElementById('title').textContent = t.name;
  document.title = t.name + ' · Go Live';
  const live = s.engine?.streaming?.active;
  view.append(
    el('div', { class: 'row', style: 'margin-bottom:6px' },
      live ? pill('live', 'LIVE') : pill('', 'Not live'),
      el('span', { class: 'muted small', text: `${t.profile?.label ?? t.eventType} · ${t.mode === 'cloud' ? 'Cloud production' : 'Laptop (OBS) production'}${t.venue ? ' · ' + t.venue : ''}` }),
      el('div', { class: 'sp' }),
      el('a', { class: 'btn small', href: `/watch/${id}`, target: '_blank', rel: 'noopener', text: 'Watch page' }),
      el('a', { class: 'btn small primary', href: `/web/e/${id}/control`, text: 'Open control room' })),
    el('nav', { class: 'tabs' }, TABS.map(([k, l]) => el('a', { href: `/web/e/${id}/${k}`, class: k === tab ? 'on' : null, onclick: (e) => { e.preventDefault(); go(`/web/e/${id}/${k}`); }, text: l }))));
  const body = el('div');
  view.append(body);
  const views = { overview, people, streaming, scores, chat, clips, engagement, settings };
  return (views[tab] ?? overview)(body, id, s);
}
const reloadTab = (id, tab) => go(`/web/e/${id}/${tab}`);

// ------------------------------------------------------------------ overview
async function overview(body, id, s) {
  const b = s.billing;
  const cams = s.cameras ?? [];
  const prod = s.production;
  const e = s.engine ?? {};
  const invites = (await get(`/api/tournaments/${id}/invites`)).invites;
  const camInvite = invites.find((i) => i.role === 'camera');
  body.append(
    el('div', { class: 'grid' },
      stat(`${cams.filter((c) => c.status === 'live').length} / ${cams.length}`, 'Cameras sending video'),
      stat(e.connected && e.obsConnected ? 'Ready' : 'Not connected', 'Broadcast engine', !(e.connected && e.obsConnected)),
      stat(e.streaming?.active ? 'Live' : 'Off air', 'Stream'),
      b ? stat(b.minutes.remainingSeconds == null ? 'Unlimited' : `${Math.floor(b.minutes.remainingSeconds / 60)} min`, 'Live time left on credits', b.minutes.remainingSeconds != null && b.minutes.remainingSeconds < 600) : null,
      b ? stat(`${b.cameras.used} / ${b.cameras.limit}`, 'Camera slots used') : null,
      b ? stat(num(b.balance), 'Club credits') : null),
    b && !b.canGoLive ? el('div', { class: 'banner bad', text: b.reason ?? 'This event cannot go live right now.' }) : null,
    el('h2', { text: 'Get on air' }),
    el('div', { class: 'card' },
      el('ol', { style: 'margin:0;padding-left:20px;line-height:1.9' },
        el('li', {}, 'Add cameras: phones scan the camera QR below (or open the invite link).'),
        el('li', {}, prod.mode === 'cloud' ? 'Start the show: we start the cloud mixer and the YouTube broadcast.' : 'Run the Go Live agent with OBS on your laptop (Streaming tab), then start the show.'),
        el('li', {}, 'Open the control room, pick a camera and press Go live.')),
      el('div', { class: 'row', style: 'margin-top:12px' },
        el('button', { class: 'btn primary', onclick: guard(async () => {
          const r = await post(`/api/tournaments/${id}/start-show`, { privacy: 'unlisted' });
          toast(r.problems?.length ? r.problems.join(' ') : 'Show started: open the control room to go live', Boolean(r.problems?.length));
          reloadTab(id, 'overview');
        }), text: 'Start show' }),
        prod.mode === 'cloud' && ['running', 'starting'].includes(prod.cloud.status) ? el('button', { class: 'btn', onclick: guard(async () => {
          if (!(await confirmBox('Stop the cloud mixer?', 'If you are live, the broadcast ends.', 'Stop'))) return;
          await post(`/api/tournaments/${id}/cloud-engine/stop`); reloadTab(id, 'overview');
        }), text: `Stop cloud mixer (${prod.cloud.status})` }) : null,
        el('a', { class: 'btn', href: `/web/e/${id}/control`, text: 'Control room' }))),
    camInvite ? el('div', { class: 'card', style: 'margin-top:12px;display:flex;gap:16px;align-items:center;flex-wrap:wrap' },
      el('img', { src: `${camInvite.qrUrl}?token=${encodeURIComponent(state.token)}`, alt: 'Camera QR code', style: 'width:160px;height:160px;background:#fff;border-radius:8px' }),
      el('div', {}, el('strong', { text: 'Camera invite' }), el('p', { class: 'small muted', text: 'Scan with the Go Live app, or share the link. No account needed.' }),
        el('div', { class: 'mono small', style: 'user-select:all', text: camInvite.joinUrl }),
        el('div', { class: 'row', style: 'margin-top:8px' }, el('a', { class: 'btn small', href: camInvite.whatsapp, target: '_blank', rel: 'noopener', text: 'Share on WhatsApp' }),
          el('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(camInvite.joinUrl).then(() => toast('Link copied')), text: 'Copy link' })))) : null);
}

// ------------------------------------------------------------------ cameras & people
async function people(body, id, s) {
  const [{ invites }, { codes }] = await Promise.all([get(`/api/tournaments/${id}/invites`), get(`/api/tournaments/${id}/join-codes`)]);
  const ROLE = { camera: 'Cameras', scorer: 'Scorers', commentator: 'Commentators' };
  body.append(
    el('h2', { text: 'Cameras' }),
    table(['Camera', 'Position', 'Phone', 'Status', ''], (s.cameras ?? []).map((c) => [el('strong', { text: c.name }), c.hole ? `${s.tournament.profile?.positionLabel ?? 'Hole'} ${c.hole}` : (c.position ?? '–'), c.deviceModel ?? c.platform ?? '–',
      pill({ live: 'ok', connecting: 'warn', paused: 'warn', offline: '' }[c.status], c.onAir ? 'On air' : c.status),
      el('span', { class: 'row' },
        el('button', { class: 'btn small', onclick: guard(async () => {
          const v = await dialog({ title: 'Camera', fields: [{ name: 'name', label: 'Name', value: c.name, required: true }, { name: 'hole', label: `${s.tournament.profile?.positionLabel ?? 'Hole'} (optional)`, type: 'number', value: c.hole ?? '' }] });
          if (!v) return; await patch(`/api/cameras/${c.id}`, { name: v.name, hole: v.hole }); reloadTab(id, 'people');
        }), text: 'Edit' }),
        el('button', { class: 'btn small danger', onclick: guard(async () => { if (!(await confirmBox('Remove this camera?', 'The phone stops sending video and frees its slot.', 'Remove'))) return; await del(`/api/cameras/${c.id}`); reloadTab(id, 'people'); }), text: 'Remove' }))]),
      { empty: 'No cameras yet. Phones join with the camera invite below.' }),
    el('h2', { text: 'Invite links (no account needed)' }),
    el('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fill,minmax(260px,1fr))' }, invites.map((i) => el('div', { class: 'card' },
      el('strong', { text: ROLE[i.role] }),
      el('img', { src: `${i.qrUrl}?token=${encodeURIComponent(state.token)}`, alt: `${ROLE[i.role]} QR`, style: 'display:block;width:140px;height:140px;background:#fff;border-radius:8px;margin:8px 0' }),
      el('div', { class: 'mono small', style: 'user-select:all;word-break:break-all', text: i.joinUrl }),
      el('div', { class: 'row', style: 'margin-top:8px' }, el('a', { class: 'btn small', href: i.whatsapp, target: '_blank', rel: 'noopener', text: 'WhatsApp' }),
        el('a', { class: 'btn small', href: `${i.qrUrl}?token=${encodeURIComponent(state.token)}`, download: `${i.role}-qr.png`, text: 'Download QR' }))))),
    el('h2', { text: 'All join codes' }),
    table(['Code', 'Role', 'Label', { t: 'Used', n: true }, 'Expires', ''], codes.map((c) => [el('span', { class: 'mono', text: c.code }), c.role, c.label ?? '–', c.uses, c.expiresAt ? when(c.expiresAt) : 'Never',
      el('button', { class: 'btn small danger', onclick: guard(async () => { await del(`/api/tournaments/${id}/join-codes/${c.code}`); reloadTab(id, 'people'); }), text: 'Revoke' })])),
    el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn small', onclick: guard(async () => {
      const v = await dialog({ title: 'New join code', fields: [{ name: 'role', label: 'Role', type: 'select', value: 'camera', options: Object.entries(ROLE).map(([value, label]) => ({ value, label: label.slice(0, -1) })) }, { name: 'label', label: 'Label (optional)' }, { name: 'expiresInHours', label: 'Expires after hours (optional)', type: 'number' }] });
      if (!v) return; await post(`/api/tournaments/${id}/join-codes`, { role: v.role, label: v.label || null, expiresInHours: v.expiresInHours || undefined }); reloadTab(id, 'people');
    }), text: 'New code' })),
    (s.commentators ?? []).length ? el('div', {}, el('h2', { text: 'Commentators' }), table(['Name', 'Status'], s.commentators.map((m) => [m.name, m.status ?? '–']))) : null);
}

// ------------------------------------------------------------------ streaming
async function streaming(body, id, s) {
  const [{ outputs, billing }, setup] = await Promise.all([get(`/api/tournaments/${id}/destinations`), s.tournament.mode === 'laptop' ? get(`/api/tournaments/${id}/engine-setup`) : null]);
  const yt = s.youtube;
  const live = s.engine?.streaming?.active;
  const PLAT = { youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram' };
  const ytSource = { org: 'Your YouTube channel', golive: 'The Go Live channel', key: 'A stream key from YouTube Studio' }[yt.source];
  body.append(
    el('h2', { text: 'YouTube' }),
    el('div', { class: 'card' },
      el('p', {}, 'Streams to: ', el('strong', { text: ytSource }), yt.channelTitle ? ` (${yt.channelTitle})` : ''),
      yt.watchUrl ? el('p', {}, 'Broadcast: ', el('a', { href: yt.watchUrl, target: '_blank', rel: 'noopener', text: yt.watchUrl }), ` · ${yt.privacy ?? ''}`) : el('p', { class: 'muted', text: yt.source === 'key' ? 'YouTube Studio holds the broadcast.' : 'No broadcast yet: "Start show" makes one.' }),
      el('div', { class: 'row' },
        yt.source !== 'key' && !yt.broadcastId ? el('button', { class: 'btn primary', onclick: guard(async () => {
          const v = await dialog({ title: 'Create YouTube broadcast', ok: 'Create', fields: [{ name: 'title', label: 'Title (optional)' }, { name: 'privacy', label: 'Who can watch', type: 'select', value: 'unlisted', options: [{ value: 'public', label: 'Public' }, { value: 'unlisted', label: 'Unlisted (link only)' }, { value: 'private', label: 'Private' }] }] });
          if (!v) return; await post(`/api/tournaments/${id}/youtube/broadcast`, { title: v.title || undefined, privacy: v.privacy }); reloadTab(id, 'streaming');
        }), text: 'Create broadcast' }) : null,
        yt.source !== 'key' && yt.broadcastId && !live ? el('button', { class: 'btn', onclick: guard(async () => { await del(`/api/tournaments/${id}/youtube/broadcast`); reloadTab(id, 'streaming'); }), text: 'New broadcast next time' }) : null,
        yt.source !== 'org' && !live ? el('button', { class: 'btn', onclick: guard(async () => { if (yt.source === 'key') await del(`/api/tournaments/${id}/youtube/key`); else await put(`/api/tournaments/${id}/youtube/source`, { source: 'org' }); reloadTab(id, 'streaming'); }), text: 'Use our YouTube channel' }) : null,
        yt.source !== 'golive' && yt.goliveAvailable && !live ? el('button', { class: 'btn', onclick: guard(async () => { if (yt.source === 'key') await del(`/api/tournaments/${id}/youtube/key`); await put(`/api/tournaments/${id}/youtube/source`, { source: 'golive' }); reloadTab(id, 'streaming'); }), text: 'Use the Go Live channel' }) : null,
        !live ? el('button', { class: 'btn', onclick: guard(async () => {
          const v = await dialog({ title: 'Stream with a YouTube key', text: 'In YouTube Studio: Go live > Stream. Copy the stream key (and the video link, so the watch page can play it).', ok: 'Save', fields: [{ name: 'streamKey', label: 'Stream key', required: true }, { name: 'videoUrl', label: 'Video link (optional)' }] });
          if (!v) return; await put(`/api/tournaments/${id}/youtube/key`, { streamKey: v.streamKey, videoUrl: v.videoUrl || null }); reloadTab(id, 'streaming');
        }), text: 'Paste a stream key' }) : null)),
    el('h2', { text: 'Also stream to' }),
    table(['Where', 'On', 'Status', ''], outputs.platforms.map((p) => [el('strong', { text: p.platform === 'youtube' ? 'YouTube (main stream)' : PLAT[p.platform] }), p.enabled ? 'Yes' : 'No', p.error ? pill('bad', p.error) : pill(p.state === 'live' ? 'ok' : '', p.state),
      el('span', { class: 'row' },
        p.platform === 'instagram' ? el('button', { class: 'btn small', onclick: guard(async () => {
          const v = await dialog({ title: 'Instagram stream key', text: 'On instagram.com: Create > Live > streaming software. The key changes every time.', fields: [{ name: 'streamUrl', label: 'Stream URL', required: true }, { name: 'streamKey', label: 'Stream key', required: true }] });
          if (!v) return; await patch(`/api/tournaments/${id}/outputs`, { instagram: v }); reloadTab(id, 'streaming');
        }), text: p.hint ? `Key …${p.hint}` : 'Paste key' }) : null,
        p.platform !== 'youtube' ? el('button', { class: 'btn small', onclick: guard(async () => { await patch(`/api/tournaments/${id}/outputs`, { [p.platform]: { enabled: !p.enabled } }); reloadTab(id, 'streaming'); }), text: p.enabled ? 'Turn off' : 'Turn on' }) : null)])
      .concat(outputs.destinations.map((d) => [el('strong', { text: d.label ?? d.platform }), d.enabled ? 'Yes' : 'No', d.error ? pill('bad', d.error) : pill(d.state === 'live' ? 'ok' : '', d.state),
        el('span', { class: 'row' },
          el('button', { class: 'btn small', onclick: guard(async () => { await patch(`/api/tournaments/${id}/destinations/${d.id}`, { enabled: !d.enabled }); reloadTab(id, 'streaming'); }), text: d.enabled ? 'Turn off' : 'Turn on' }),
          el('button', { class: 'btn small danger', onclick: guard(async () => { await del(`/api/tournaments/${id}/destinations/${d.id}`); reloadTab(id, 'streaming'); }), text: 'Remove' }))]))),
    el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn small', onclick: guard(async () => {
      const v = await dialog({ title: 'Add a destination', text: 'Any service that gives an RTMP stream URL and key (another YouTube channel, a website player…).', ok: 'Add', fields: [{ name: 'label', label: 'Name', required: true }, { name: 'streamUrl', label: 'Stream URL', required: true }, { name: 'streamKey', label: 'Stream key', required: true }, { name: 'vertical', label: 'Vertical (9:16) for phones', type: 'checkbox' }] });
      if (!v) return; await post(`/api/tournaments/${id}/destinations`, { kind: 'key', ...v }); reloadTab(id, 'streaming');
    }), text: 'Add destination' }),
      billing ? el('span', { class: 'small muted', text: `${billing.destinations.used} of ${billing.destinations.limit} destinations used${billing.destinations.price ? ` · extra ones ${billing.destinations.price} credits` : ''}` }) : null),
    setup ? el('div', {}, el('h2', { text: 'Laptop production (OBS)' }),
      el('div', { class: 'card' }, el('p', { class: 'small', text: 'On the laptop with OBS, run the Go Live agent with these settings:' }),
        el('pre', { class: 'mono card', style: 'white-space:pre-wrap;user-select:all', text: setup.envFile }),
        el('button', { class: 'btn small', onclick: guard(async () => { if (!(await confirmBox('Make a new engine key?', 'The laptop agent must be restarted with the new key.', 'New key', false))) return; await post(`/api/tournaments/${id}/engine-key/rotate`); reloadTab(id, 'streaming'); }), text: 'New engine key' }))) : null);
}

// ------------------------------------------------------------------ scores
async function scores(body, id, s) {
  const [lb, { players }] = await Promise.all([get(`/api/tournaments/${id}/leaderboard`), get(`/api/tournaments/${id}/players`)]);
  const holes = lb.holes ?? [];
  if (!s.tournament.profile?.scoring) {
    body.append(el('p', { class: 'muted', text: 'This type of event has no hole-by-hole scoring. Players (for name captions) can still be listed below.' }));
  }
  const grid = el('div', { class: 'tablewrap' }, el('table', {},
    el('thead', {}, el('tr', {}, el('th', { text: 'Player' }), holes.map((h) => el('th', { class: 'n', text: `${h.number}` })), el('th', { class: 'n', text: 'Total' }), el('th', { class: 'n', text: 'To par' }))),
    el('tbody', {}, lb.rows.map((r) => el('tr', {}, el('td', {}, el('strong', { text: r.name }), r.club ? el('div', { class: 'small muted', text: r.club }) : null),
      holes.map((h) => {
        const v = r.scores?.[h.number] ?? '';
        const input = el('input', { type: 'number', min: 1, max: 20, value: v, style: 'width:52px;padding:4px;text-align:center' });
        input.onchange = guard(async () => { await put(`/api/tournaments/${id}/scores`, { playerId: r.playerId, hole: h.number, strokes: input.value === '' ? null : Number(input.value) }); toast(`${r.name}: hole ${h.number} saved`); });
        return el('td', { class: 'n' }, input);
      }),
      el('td', { class: 'n', text: r.holesPlayed ? r.strokes : '' }), el('td', { class: 'n', text: r.toParText }))))));
  body.append(
    holes.length ? null : el('div', { class: 'banner warn' }, 'No holes set. ', el('button', { class: 'btn small', onclick: guard(async () => { await put(`/api/tournaments/${id}/holes`, { preset: 'par72' }); reloadTab(id, 'scores'); }), text: 'Use a standard par 72 course' })),
    el('h2', { text: 'Scorecard' }), lb.rows.length ? grid : el('p', { class: 'muted', text: 'Add players first.' }),
    el('h2', { text: 'Players' }),
    table(['Name', 'Club / team', 'Category', 'Group', ''], players.map((p) => [p.name, p.club ?? '–', p.category ?? '–', p.groupNo ?? '–',
      el('button', { class: 'btn small danger', onclick: guard(async () => { await del(`/api/players/${p.id}`); reloadTab(id, 'scores'); }), text: 'Remove' })]), { empty: 'No players yet.' }),
    el('div', { class: 'row', style: 'margin-top:8px' },
      el('button', { class: 'btn small', onclick: guard(async () => {
        const v = await dialog({ title: 'Add player', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'club', label: 'Club / team' }, { name: 'category', label: 'Category' }, { name: 'groupNo', label: 'Group number', type: 'number' }] });
        if (!v) return; await post(`/api/tournaments/${id}/players`, { players: [{ name: v.name, club: v.club || null, category: v.category || null, groupNo: v.groupNo }] }); reloadTab(id, 'scores');
      }), text: 'Add player' }),
      el('button', { class: 'btn small', onclick: guard(async () => {
        const v = await dialog({ title: 'Import players (CSV)', text: 'One player per line: name, club, category, group. A header row is fine.', ok: 'Import', fields: [{ name: 'csv', label: 'CSV', type: 'textarea', required: true }] });
        if (!v) return; const r = await post(`/api/tournaments/${id}/players`, { csv: v.csv }); toast(`${r.players.length} players added`); reloadTab(id, 'scores');
      }), text: 'Import CSV' })));
}

// ------------------------------------------------------------------ chat
async function chat(body, id) {
  const out = el('div');
  const load = async () => {
    const c = await get(`/api/tournaments/${id}/chat`);
    const msgs = (c.messages ?? []).slice().reverse();
    out.replaceChildren(
      el('p', { class: 'small muted', text: `Watch-page chat ${c.enabled === false ? 'is off' : 'is on'}. YouTube and Facebook comments appear here too.` }),
      table(['When', 'From', 'Message', ''], msgs.map((m) => [when(m.at), `${m.author} (${m.source})`, el('span', { style: m.hidden ? 'opacity:.5;text-decoration:line-through' : '' }, m.text, m.question ? ' ' : '', m.question ? pill('warn', 'Question') : null),
        el('span', { class: 'row' },
          el('button', { class: 'btn small', onclick: guard(async () => { await patch(`/api/chat/${m.id}`, { pinned: !m.pinned }); load(); }), text: m.pinned ? 'Unpin' : 'Pin' }),
          el('button', { class: 'btn small', onclick: guard(async () => { await patch(`/api/chat/${m.id}`, { hidden: !m.hidden }); load(); }), text: m.hidden ? 'Show' : 'Hide' }),
          m.question ? el('button', { class: 'btn small', onclick: guard(async () => { await post(`/api/chat/${m.id}/on-air`, { visible: true }); toast('Question on air'); }), text: 'On air' }) : null,
          el('button', { class: 'btn small danger', onclick: guard(async () => { if (!(await confirmBox('Block this viewer?', 'All their messages are hidden and they cannot post again in this event.', 'Block'))) return; await post(`/api/chat/${m.id}/ban`); load(); }), text: 'Block' }))]), { empty: 'No messages yet.' }));
  };
  body.append(out);
  await load();
  const timer = setInterval(() => load().catch(() => {}), 5000);
  return () => clearInterval(timer);
}

// ------------------------------------------------------------------ clips
async function clips(body, id) {
  const { clips } = await get(`/api/tournaments/${id}/clips`);
  const file = (c, f) => `/api/clips/${c.id}/${f}?token=${encodeURIComponent(state.token)}`;
  body.append(
    el('p', { class: 'muted', text: 'Clips are made from the control room (Clip button) or the app. Ready clips can be shared or downloaded.' }),
    el('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fill,minmax(260px,1fr))' }, clips.map((c) => el('div', { class: 'card' },
      c.status === 'ready' ? el('video', { src: file(c, 'landscape.mp4'), poster: file(c, 'thumb.jpg'), controls: true, preload: 'none', style: 'width:100%;border-radius:8px;background:#000' }) : el('div', { class: 'empty', text: c.status === 'failed' ? `Failed: ${c.error ?? ''}` : 'Being made…' }),
      el('div', { style: 'margin-top:8px' }, el('strong', { text: c.title ?? c.cameraName }), el('div', { class: 'small muted', text: `${when(c.createdAt)} · ${c.durationSec} s` })),
      c.status === 'ready' ? el('div', { class: 'row', style: 'margin-top:8px' },
        el('a', { class: 'btn small', href: file(c, 'landscape.mp4'), download: 'clip.mp4', text: '16:9' }),
        el('a', { class: 'btn small', href: file(c, 'vertical.mp4'), download: 'clip-vertical.mp4', text: '9:16' }),
        el('button', { class: 'btn small', onclick: guard(async () => { const r = await post(`/api/clips/${c.id}/share`); await navigator.clipboard?.writeText(r.landscape ?? r.url ?? Object.values(r)[0]); toast('Share link copied'); }), text: 'Copy link' }),
        el('button', { class: 'btn small', onclick: guard(async () => { await patch(`/api/clips/${c.id}`, { public: !c.public }); reloadTab(id, 'clips'); }), text: c.public ? 'Hide from watch page' : 'Show on watch page' }),
        el('button', { class: 'btn small danger', onclick: guard(async () => { if (!(await confirmBox('Delete clip?', '', 'Delete'))) return; await del(`/api/clips/${c.id}`); reloadTab(id, 'clips'); }), text: 'Delete' })) : null))),
    clips.length ? null : el('div', { class: 'card empty', text: 'No clips yet.' }));
}

// ------------------------------------------------------------------ influencers & games (the Studio, inside the web app)
async function engagement(body, id) {
  const frame = el('iframe', { src: `/studio/${id}?embed=1`, title: 'Influencers and games', style: 'width:100%;min-height:1400px;border:0;border-radius:10px;background:var(--bg)' });
  // Grow with the content so the page scrolls, not the frame.
  frame.onload = () => { try { const fit = () => (frame.style.height = Math.max(900, frame.contentDocument.body.scrollHeight + 40) + 'px'); fit(); new ResizeObserver(fit).observe(frame.contentDocument.body); } catch {} };
  body.append(frame);
}

// ------------------------------------------------------------------ settings
async function settings(body, id, s) {
  const t = s.tournament;
  const { eventTypes } = await get('/api/event-types');
  const f = (name, label, input) => el('div', {}, el('label', { text: label }), input);
  const check = (k, label) => { const i = el('input', { type: 'checkbox', name: k }); i.checked = Boolean(t[k]); return el('label', { class: 'check', style: 'margin:6px 0' }, i, label); };
  const form = el('form', { class: 'card', onsubmit: guard(async (e) => {
    e.preventDefault(); const x = e.target.elements;
    await patch(`/api/tournaments/${id}`, { name: x.name.value.trim(), venue: x.venue.value.trim() || null, eventType: x.eventType.value, mode: x.mode.value,
      publicWatch: x.publicWatch.checked, chatEnabled: x.chatEnabled.checked, chatSlowSec: Number(x.chatSlowSec.value), autoFallback: x.autoFallback.checked });
    toast('Saved'); reloadTab(id, 'settings');
  }) },
    el('div', { class: 'form' },
      f('name', 'Event name', el('input', { name: 'name', value: t.name, required: true })),
      f('venue', 'Venue', el('input', { name: 'venue', value: t.venue ?? '' })),
      f('eventType', 'Type', el('select', { name: 'eventType' }, eventTypes.map((e) => el('option', { value: e.id, selected: e.id === t.eventType || undefined, text: e.label })))),
      f('mode', 'Production', el('select', { name: 'mode' }, [['cloud', 'Cloud (no laptop)'], ['laptop', 'Laptop with OBS']].map(([v, l]) => el('option', { value: v, selected: v === t.mode || undefined, text: l })))),
      f('chatSlowSec', 'Seconds between messages from one viewer', el('input', { name: 'chatSlowSec', type: 'number', min: 0, max: 300, value: t.chatSlowSec }))),
    el('div', { style: 'margin-top:10px' }, check('publicWatch', 'Public watch page'), check('chatEnabled', 'Viewers can chat on the watch page'), check('autoFallback', 'Show the fallback screen when the on-air camera drops')),
    el('button', { class: 'btn primary', text: 'Save' }));
  body.append(form,
    el('h2', { text: 'Archive' }),
    el('div', { class: 'card' }, el('p', { class: 'small muted', text: 'Archived events leave your list; their clips and reports stay.' }),
      el('button', { class: 'btn danger', onclick: guard(async () => { if (!(await confirmBox('Archive this event?', 'Invite links stop working.', 'Archive'))) return; await patch(`/api/tournaments/${id}`, { archived: true }); go('/web/events'); }), text: 'Archive event' })));
}
