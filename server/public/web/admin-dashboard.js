import { get, el, stat, inr, num } from './core.js';

export const title = 'Dashboard';

export async function render(view) {
  const o = await get('/api/admin/overview');
  view.append(
    el('div', { class: 'grid' },
      stat(o.liveNow, 'Live now'),
      stat(o.clubs, 'Clubs'),
      stat(o.suspended, 'Suspended clubs', o.suspended > 0),
      stat(o.tournamentsThisMonth, 'Events this month'),
      stat(inr(o.revenueThisMonthInr), 'Revenue this month'),
      stat(inr(o.revenueTotalInr), 'Revenue all time'),
      stat(num(o.creditsSpentThisMonth), 'Credits spent this month'),
      stat(num(o.creditsHeldByClubs), 'Credits held by clubs')),
    el('h2', { text: 'Sign-up to first live (last 90 days)' }),
    el('div', { class: 'grid' },
      stat(o.onboarding.signups, 'Sign-ups'),
      stat(o.onboarding.reached.event, 'Created an event'),
      stat(o.onboarding.reached.camera, 'Added a camera'),
      stat(o.onboarding.reached.live, 'Went live'),
      stat(o.onboarding.medianMinutes.live == null ? '–' : o.onboarding.medianMinutes.live + ' min', 'Median time to first live')),
    el('p', { class: 'small muted', text: `Billing ${o.billingEnabled ? 'on' : 'off'} · Payments ${o.paymentsEnabled ? 'on (' + o.cashfreeMode + ')' : 'off'}` }));
}
