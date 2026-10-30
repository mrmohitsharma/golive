import { get, el, stat, table, num, when, go } from './core.js';

export const title = 'Viewership';

export async function render(view, params) {
  const days = el('select', {}, [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last year']].map(([v, t]) => el('option', { value: v, selected: v === 30 || undefined, text: t })));
  const out = el('div');
  const load = async () => {
    const [v, w] = await Promise.all([get('/api/admin/viewership?days=' + days.value), get('/api/admin/wins')]);
    const t = v.totals;
    out.replaceChildren(
      el('div', { class: 'grid' }, stat(num(t.viewers), 'Watch-page viewers'), stat(num(t.watchMinutes), 'Minutes watched'), stat(num(t.viaInfluencers), 'Came via influencers'),
        stat(num(t.influencers), 'Influencer links made'), stat(num(t.gamesPlayed), 'Games played'), stat(t.playRate + '%', 'Played when shown'),
        stat(num(t.prizesWon), 'Prizes won'), stat(num(t.prizesClaimed), 'Prizes claimed'), stat(num(t.prizesUnclaimed), 'Waiting to be claimed', t.prizesUnclaimed > 0),
        stat(num(t.addonsBought), 'Add-ons bought'), stat(num(t.notCounted), 'Not counted (bots, fake views)')),
      el('h2', { text: 'Top events by minutes watched' }),
      table(['Event', 'Club', { t: 'Viewers', n: true }, { t: 'Minutes', n: true }, { t: 'Via influencers', n: true }, ''], v.topEvents.map((e) => [el('strong', { text: e.name }), e.club, num(e.viewers), num(e.watchMinutes), num(e.viaInfluencers),
        el('a', { class: 'btn small', href: '/studio/' + e.id, target: '_blank', text: 'Reports' })]), { empty: 'No viewers in this period.' }),
      el('h2', { text: 'Top influencers' }),
      table(['Influencer', 'Platform', 'Event', 'Club', { t: 'Viewers', n: true }, { t: 'Minutes', n: true }], v.topInfluencers.map((i) => [el('strong', { text: i.name }), `${i.platform}${i.handle ? ' · ' + i.handle : ''}`, i.event, i.club, num(i.viewers), num(i.watchMinutes)]), { empty: 'No influencer viewers in this period.' }),
      el('h2', { text: 'Prizes (audit)' }),
      table(['When', 'Prize', 'Game', 'Event', 'Club', 'Winner', 'Status'], w.wins.map((x) => [when(x.at), x.prize + (x.sponsor ? ` · ${x.sponsor}` : ''), x.game, x.event, x.club,
        el('span', { class: 'mono small', text: [x.phone, x.email].filter(Boolean).join(' · ') || '–' }),
        el('span', { class: 'pill ' + ({ claimed: 'ok', sent: 'ok', expired: 'bad', won: 'warn' }[x.status] ?? ''), text: x.status })]), { empty: 'No prizes yet.' }));
  };
  days.onchange = load;
  view.append(el('div', { class: 'row', style: 'margin-bottom:12px' }, el('div', { style: 'width:220px' }, days)), out);
  await load();
}
