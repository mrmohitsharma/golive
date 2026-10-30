import { get, el, stat, inr, num, go, barChart } from './core.js';

export const title = 'Dashboard';

export async function render(view) {
  const load = async () => {
    const d = await get('/api/admin/dashboard');
    const a = d.alerts;
    const alerts = [
      a.failedPayments24h && [`${a.failedPayments24h} failed payment${a.failedPayments24h > 1 ? 's' : ''} in the last 24 h`, '/web/admin/money'],
      a.stuckPayments && [`${a.stuckPayments} payment${a.stuckPayments > 1 ? 's' : ''} started but not confirmed (over 30 min)`, '/web/admin/money'],
      a.failedMessages24h && [`${a.failedMessages24h} SMS failed in the last 24 h`, '/web/admin/sms'],
      a.urgentTickets && [`${a.urgentTickets} urgent support ticket${a.urgentTickets > 1 ? 's' : ''}`, '/web/admin/support'],
      a.openTickets && [`${a.openTickets} open support ticket${a.openTickets > 1 ? 's' : ''}`, '/web/admin/support'],
      a.suspendedClubs && [`${a.suspendedClubs} club${a.suspendedClubs > 1 ? 's' : ''} suspended`, '/web/admin/clubs'],
      a.lowBalanceActiveClubs && [`${a.lowBalanceActiveClubs} active club${a.lowBalanceActiveClubs > 1 ? 's' : ''} with under 100 credits`, '/web/admin/clubs'],
      ...a.engineWarnings.map((w) => [`${w.name}: ${w.text}`, '/web/admin/live']),
    ].filter(Boolean);
    const period = (p, label) => el('div', {},
      el('h2', { text: label }),
      el('div', { class: 'grid' }, stat(inr(p.revenueInr), 'Revenue'), stat(p.payments, 'Payments'), stat(p.newClubs, 'New clubs'), stat(p.newEvents, 'New events'),
        stat(p.eventsWentLive, 'Events that went live'), stat(num(p.creditsSpent), 'Credits used'), stat(num(p.watchMinutes), 'Watch-page minutes')));
    view.replaceChildren(
      el('div', { class: 'grid' },
        stat(d.now.liveEvents, 'Live now'), stat(d.now.cameras, 'Cameras on live events'),
        stat(num(d.now.watchingOnPage), 'Watching on our pages'), stat(num(d.now.watchingOnYoutube), 'Watching on YouTube')),
      alerts.length
        ? el('div', { class: 'banner warn' }, el('strong', { text: 'Needs attention' }), el('ul', { style: 'margin:6px 0 0;padding-left:18px' },
            alerts.map(([t, href]) => el('li', {}, href ? el('a', { href, onclick: (e) => { e.preventDefault(); go(href); }, text: t }) : t))))
        : el('div', { class: 'banner', style: 'border:1px solid var(--line)', text: 'All clear: no failed payments, SMS failures or engine warnings.' }),
      period(d.today, 'Today'),
      period(d.month, 'This month'),
      el('h2', { text: 'Revenue, last 30 days' }),
      el('div', { class: 'card' }, barChart(d.series, { value: (r) => r.revenueInr, label: (r) => r.day.slice(5), fmt: inr })),
      el('h2', { text: 'New events, last 30 days' }),
      el('div', { class: 'card' }, barChart(d.series, { value: (r) => r.newEvents, label: (r) => r.day.slice(5), height: 110 })));
  };
  await load();
  const t = setInterval(() => load().catch(() => {}), 30000);
  return () => clearInterval(t);
}
