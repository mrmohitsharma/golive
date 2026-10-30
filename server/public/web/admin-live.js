import { state, get, post, el, stat, num, confirmBox, toast, guard, go } from './core.js';

export const title = 'Live monitor';

export async function render(view) {
  const load = async () => {
    const { live } = await get('/api/admin/live-monitor');
    view.replaceChildren(
      el('div', { class: 'grid' }, stat(live.length, 'Live events'), stat(num(live.reduce((s, l) => s + l.watchingOnPage, 0)), 'Watching on our pages'),
        stat(num(live.reduce((s, l) => s + (l.watchingOnYoutube ?? 0), 0)), 'Watching on YouTube'), stat(live.reduce((s, l) => s + l.cameras, 0), 'Cameras')),
      el('h2', { text: 'On air now' }),
      live.length ? el('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fill,minmax(320px,1fr))' }, live.map((l) => el('div', { class: 'card' },
        el('div', { class: 'row' }, el('span', { class: 'pill live', text: 'LIVE' }), el('strong', { text: l.name }), el('div', { class: 'sp' }),
          el('span', { class: 'pill ' + (l.engineConnected ? 'ok' : 'bad'), text: l.engineConnected ? 'Engine OK' : 'Engine offline' })),
        el('div', { class: 'muted small', style: 'margin:6px 0' }, el('a', { href: '/web/admin/clubs/' + l.orgId, onclick: (e) => { e.preventDefault(); go('/web/admin/clubs/' + l.orgId); }, text: l.orgName }), ` · ${l.mode} · ${l.cameras} cameras`),
        l.onAirCameraId ? el('img', { src: `/api/cameras/${l.onAirCameraId}/thumbnail.jpg?token=${encodeURIComponent(state.token)}&t=${Date.now()}`, alt: 'On air', style: 'width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:8px;background:#000', onerror: (e) => e.target.remove() }) : null,
        el('div', { class: 'small', style: 'margin:8px 0' }, `On air: ${l.onAir ?? '–'} · ${l.liveMinutes} min live`, l.remainingMinutes != null ? ` · ${l.remainingMinutes} min of credit left` : ''),
        el('div', { class: 'small' }, `Watching: ${l.watchingOnPage} on our page · ${l.watchingOnYoutube ?? '–'} on YouTube`),
        l.warnings.length ? el('div', { class: 'banner warn small' }, l.warnings.join(' · ')) : null,
        el('div', { class: 'row', style: 'margin-top:10px' },
          el('a', { class: 'btn small', href: l.watchUrl, target: '_blank', rel: 'noopener', text: 'Watch' }),
          el('a', { class: 'btn small', href: '/web/e/' + l.tournamentId + '/control', text: 'Control room' }),
          el('button', { class: 'btn small danger', onclick: guard(async () => {
            if (!(await confirmBox('End this broadcast now?', `${l.name} will stop on YouTube, Facebook and the watch page. The club is told an administrator ended it.`, 'End broadcast'))) return;
            await post(`/api/admin/events/${l.tournamentId}/stop`); toast('Stop sent'); load();
          }), text: 'Emergency stop' }))))) : el('div', { class: 'card empty', text: 'Nothing is live right now.' }));
  };
  await load();
  const t = setInterval(() => load().catch(() => {}), 10000);
  return () => clearInterval(t);
}
