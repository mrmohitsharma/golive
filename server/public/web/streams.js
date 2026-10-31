// The main stream picker: where viewers watch. Any option can be the main one; it can be
// paused (stops sending, keeps its setup) and switched to another at any time. Used by the
// setup bar (step 3) and at the top of an event's Streaming tab.
import { get, post, put, patch, del, el, dialog, toast, guard, go } from './core.js';
import { info } from './guide.js';

const pill = (cls, text) => el('span', { class: 'pill ' + cls, text });

/** Asks how to stream to YouTube when it is not set up yet. Returns true when it is. */
async function setUpYoutube(id, s) {
  const org = await get(`/api/orgs/${s.tournament.orgId}/youtube`).catch(() => ({ connected: false }));
  const yt = s.youtube;
  const options = [
    org.connected ? { value: 'org', label: `Your channel${org.channelTitle ? `: ${org.channelTitle}` : ''}` } : null,
    yt.goliveAvailable ? { value: 'golive', label: 'The Go Live channel (no YouTube account needed)' } : null,
    { value: 'key', label: 'A stream key from YouTube Studio' },
    !org.connected ? { value: 'connect', label: 'Connect our YouTube channel first (opens Channels)' } : null,
  ].filter(Boolean);
  const v = await dialog({
    title: 'Stream to YouTube', ok: 'Use this',
    text: 'Pick the YouTube channel the show goes to. With a stream key, copy it from YouTube Studio > Go live > Stream.',
    fields: [
      { name: 'how', label: 'How', type: 'select', value: options[0].value, options },
      { name: 'streamKey', label: 'Stream key (stream key only)' },
      { name: 'videoUrl', label: 'YouTube video link (optional, stream key only)' },
    ],
  });
  if (!v) return false;
  if (v.how === 'connect') { go('/web/channels'); return false; }
  if (v.how === 'key') {
    if (!v.streamKey) throw new Error('Paste the stream key from YouTube Studio.');
    await put(`/api/tournaments/${id}/youtube/key`, { streamKey: v.streamKey, videoUrl: v.videoUrl || null });
  } else {
    if (yt.source === 'key') await del(`/api/tournaments/${id}/youtube/key`);
    await put(`/api/tournaments/${id}/youtube/source`, { source: v.how });
  }
  return true;
}

/** Adds a stream-key destination (Instagram or any RTMP service). Returns its id. */
async function addKeyDestination(id, platform) {
  const insta = platform === 'instagram';
  const v = await dialog({
    title: insta ? 'Stream to Instagram' : 'Stream to another service', ok: 'Add',
    text: insta ? 'On instagram.com: Create > Live > Streaming software. Copy the stream URL and key (Instagram makes a new key every time).' : 'Paste the RTMP stream URL and key from the service (Twitch, LinkedIn, Kick, your website…).',
    fields: [
      { name: 'label', label: 'Name', value: insta ? 'Instagram' : '', required: !insta },
      { name: 'streamUrl', label: 'Stream URL', required: true, placeholder: 'rtmps://…' },
      { name: 'streamKey', label: 'Stream key', required: true },
      { name: 'vertical', label: 'Vertical 9:16 (for phones)', type: 'checkbox', value: insta },
    ],
  });
  if (!v) return null;
  const r = await post(`/api/tournaments/${id}/destinations`, { kind: 'key', platform: insta ? 'instagram' : 'other', streamUrl: v.streamUrl, streamKey: v.streamKey, label: v.label || undefined, vertical: v.vertical });
  return r.destination?.id ?? r.outputs?.destinations?.at(-1)?.id ?? null;
}

/**
 * Renders the picker into `box` and keeps it fresh after each change.
 * opts.onChange(outputs) is called after a change (the setup bar uses it to tick the step).
 */
export async function mainStreamCard(box, id, opts = {}) {
  const [s, d] = await Promise.all([get(`/api/tournaments/${id}/state`), get(`/api/tournaments/${id}/destinations`)]);
  const o = d.outputs;
  const m = o.main;
  const live = s.engine?.streaming?.active;
  const yt = s.youtube;
  const facebook = o.platforms.find((p) => p.platform === 'facebook');
  const refresh = async () => { const r = await mainStreamCard(box, id, opts); opts.onChange?.(r); };
  const use = (main, before) => guard(async () => {
    if (before && !(await before())) return;
    await patch(`/api/tournaments/${id}/outputs`, { main });
    toast('Main stream changed');
    await refresh();
  });
  const choices = [
    o.watch ? { id: 'watch', icon: '▶', name: 'Watch page', sub: 'Our own player on your event page and website. Works with no setup. No YouTube logos or ads.' } : null,
    { id: 'youtube', icon: '▶', name: 'YouTube', sub: yt.connected ? `${{ org: 'Your channel', golive: 'Go Live channel', key: 'Stream key' }[yt.source]}${yt.channelTitle ? ` · ${yt.channelTitle}` : ''}` : 'Your channel, the Go Live channel, or a stream key', before: () => (yt.connected ? true : setUpYoutube(id, s)) },
    { id: 'facebook', icon: 'f', name: 'Facebook Page', sub: facebook?.configured ? 'Your connected Page' : 'Connect your Page in Club > Channels first', disabled: !facebook?.configured },
    { id: 'instagram-key', icon: '◎', name: 'Instagram', sub: 'Paste the stream key from instagram.com', add: 'instagram' },
    { id: 'other-key', icon: '⇪', name: 'Other service', sub: 'Any RTMP stream URL and key', add: 'other' },
    ...o.destinations.map((x) => ({ id: `d:${x.id}`, icon: '⇪', name: x.label, sub: x.kind === 'channel' ? 'Another YouTube channel' : `Stream key${x.hint ? ' …' + x.hint : ''}` })),
  ].filter(Boolean);

  const current = el('div', { class: 'main-now' },
    el('div', { style: 'flex:1;min-width:220px' },
      el('div', { class: 'small muted', text: 'Main stream' }),
      el('div', { class: 'row', style: 'gap:8px' }, el('strong', { style: 'font-size:17px', text: m.label }),
        m.paused ? pill('warn', 'Paused') : m.ready ? pill('ok', live ? 'Sending' : 'Ready') : pill('warn', 'Needs setup')),
      m.link ? el('a', { class: 'small', href: m.link, target: '_blank', rel: 'noopener', text: m.link }) : el('div', { class: 'small muted', text: m.id === 'youtube' ? 'The YouTube link appears when the broadcast is made (Start show).' : 'Viewers watch it on that service.' })),
    el('div', { class: 'row' },
      m.link ? el('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(m.link).then(() => toast('Link copied')), text: 'Copy link' }) : null,
      el('button', {
        class: 'btn small', 'data-tour': 'pause-main',
        onclick: guard(async () => {
          const body = m.id === 'watch' ? { watch: { enabled: m.paused } } : m.id.startsWith('d:') ? null : { [m.id]: { enabled: m.paused } };
          if (body) await patch(`/api/tournaments/${id}/outputs`, body);
          else await patch(`/api/tournaments/${id}/destinations/${m.id.slice(2)}`, { enabled: m.paused });
          toast(m.paused ? 'Main stream resumed' : 'Main stream paused');
          await refresh();
        }),
        text: m.paused ? 'Resume' : 'Pause',
      })));

  box.replaceChildren(
    el('div', { class: 'card main-stream', 'data-tour': 'main-stream' },
      el('div', { class: 'row', style: 'margin-bottom:8px' }, el('strong', { text: 'Where viewers watch' }), info('streaming', 'Main stream and destinations')),
      current,
      el('div', { class: 'small muted', style: 'margin:12px 0 6px', text: live ? 'You are live: switching the main stream applies right away.' : 'Choose the main stream (you can switch or pause it any time):' }),
      el('div', { class: 'choices' }, choices.map((c) => el('button', {
        class: 'choice' + (c.id === m.id ? ' on' : ''), type: 'button', disabled: c.disabled || undefined,
        onclick: c.add
          ? guard(async () => { const dest = await addKeyDestination(id, c.add); if (!dest) return; await patch(`/api/tournaments/${id}/outputs`, { main: `d:${dest}` }); toast('Main stream changed'); await refresh(); })
          : c.id === m.id ? null : use(c.id, c.before),
      }, el('span', { class: 'ci', text: c.icon }), el('span', {}, el('strong', { text: c.name }), el('div', { class: 'small muted', text: c.sub })),
        c.id === m.id ? el('span', { class: 'tick', text: '✓' }) : null)))),
    opts.compact ? null : el('div', { class: 'small muted', style: 'margin-top:6px', text: 'Other places that are switched on also get the show (Also stream to, below).' }));
  return o;
}
