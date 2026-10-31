import { get, put, post, el, stat, table, when, toast, guard, go } from './core.js';

export const title = 'Streaming';

const dur = (s) => s == null ? '–' : s < 60 ? `${s} s` : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.round(s / 60)} min`;
const size = (b) => b == null ? '–' : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;

export async function render(view) {
  const { settings: s, sessions } = await get('/api/admin/streaming');
  const stats = s.hasApiKey && s.pullZoneId ? await get('/api/admin/streaming/stats?days=30').then((r) => r.stats).catch((e) => ({ error: e.message })) : null;
  const f = {
    host: el('input', { value: s.host ?? '', placeholder: 'gogetslive.b-cdn.net' }),
    pullZoneId: el('input', { type: 'number', value: s.pullZoneId ?? '', placeholder: 'From the address bar: dash.bunny.net/cdn/<id>/…' }),
    apiKey: el('input', { type: 'password', placeholder: s.hasApiKey ? `Saved (…${s.apiKeyHint}); leave empty to keep` : 'Account settings > API key' }),
    cost: el('select', {}, [['0.005', 'Bunny Volume: $0.005 per GB'], ['0.03', 'Bunny Standard (Asia): $0.03 per GB'], ['0.01', 'Bunny Standard (Europe/US): $0.01 per GB']].map(([v, t]) => el('option', { value: v, text: t, selected: Number(v) === s.costPerGbUsd || undefined }))),
  };
  if (![0.005, 0.03, 0.01].includes(s.costPerGbUsd)) f.cost.append(el('option', { value: String(s.costPerGbUsd), text: `$${s.costPerGbUsd} per GB`, selected: true }));
  const on = el('input', { type: 'checkbox' }); on.checked = s.playerEnabled;
  const lock = el('input', { type: 'checkbox' }); lock.checked = s.lockOrigin;
  const checks = el('div');
  const live = sessions.filter((x) => !x.endedAt).length;

  view.append(
    !s.available ? el('div', { class: 'banner warn', text: 'HLS_ENABLED is false in the server settings (.env): the watch player cannot run until it is turned on.' }) : null,
    el('div', { class: 'grid' },
      stat(s.playerEnabled && s.available ? 'On' : 'Off', 'Our watch player'),
      stat(live, 'Streams being written now'),
      stat(stats && !stats.error ? `${stats.bandwidthGb} GB` : '–', 'CDN bandwidth, 30 days'),
      stat(stats && !stats.error ? `₹${stats.costInr.toLocaleString('en-IN')}` : '–', `CDN cost, 30 days${stats && !stats.error ? ` ($${stats.costUsd})` : ''}`)),
    stats && stats.error ? el('div', { class: 'banner warn', text: `Bunny statistics: ${stats.error}` }) : null,
    el('h2', { text: 'Watch player and CDN' }),
    el('div', { class: 'card' },
      el('p', { class: 'small muted', text: `The programme is turned into ${s.renditions.split(',').map((r) => r.split(':')[0] + 'p').join(' and ')} on this server and played on the watch page and /embed with our own player. Viewers load it through the CDN, which pulls from ${s.originUrl}/hls. Recordings are kept ${s.retentionDays} days as replays.` }),
      el('div', { class: 'form' },
        el('div', {}, el('label', { text: 'CDN hostname' }), f.host),
        el('div', {}, el('label', { text: 'Bunny pull zone id' }), f.pullZoneId),
        el('div', {}, el('label', { text: 'Bunny API key' }), f.apiKey),
        el('div', {}, el('label', { text: 'CDN price (for the cost figures)' }), f.cost)),
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('label', { class: 'check' }, on, 'Use our player on the watch page (YouTube stays as an extra)'),
        el('label', { class: 'check' }, lock, 'Only the CDN may read the stream')),
      s.lockOrigin && s.originSecret ? el('div', { class: 'banner', style: 'margin-top:10px' },
        el('div', { text: 'In Bunny: Pull zone > Edge rules > Add edge rule. Action: "Set Request Header", header X-Origin-Secret, value:' }),
        el('code', { style: 'user-select:all;word-break:break-all', text: s.originSecret }),
        el('div', { class: 'small muted', text: 'Condition: Request URL matches *. Until this rule is saved, viewers get errors.' })) : null,
      el('div', { class: 'row', style: 'margin-top:12px' },
        el('button', { class: 'btn primary', onclick: guard(async () => {
          await put('/api/admin/streaming', { playerEnabled: on.checked, host: f.host.value.trim(), pullZoneId: f.pullZoneId.value ? Number(f.pullZoneId.value) : null, apiKey: f.apiKey.value.trim() || undefined, costPerGbUsd: Number(f.cost.value), lockOrigin: lock.checked });
          toast('Streaming settings saved'); go('/web/admin/streaming');
        }), text: 'Save' }),
        el('button', { class: 'btn', onclick: guard(async (b) => {
          checks.replaceChildren(el('p', { class: 'muted small', text: 'Checking…' }));
          const r = await post('/api/admin/streaming/test', {});
          checks.replaceChildren(table(['Check', 'Result', ''], r.checks.map((c) => [c.name, el('span', { class: 'pill ' + (c.ok ? 'ok' : 'warn'), text: c.ok ? 'OK' : 'Check' }), c.detail])));
        }), text: 'Test the setup' })),
      checks),
    el('h2', { text: 'Recent streams' }),
    table(['Started', 'Event', 'Club', 'Length', 'Size', 'Status'], sessions.map((x) => [when(x.startedAt), x.event, x.club, dur(x.durationSec), size(x.bytes),
      el('span', { class: 'pill ' + (x.deleted ? '' : x.endedAt ? 'ok' : 'live'), text: x.deleted ? 'Deleted' : x.endedAt ? 'Replay' : 'Live' })]),
      { onclick: (i) => go('/web/e/' + sessions[i].eventId + '/streaming'), empty: 'Nothing streamed with our player yet.' }));
}
