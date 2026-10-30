import { get, el, table, guard, download } from './core.js';

export const title = 'Reports';
const REPORTS = [
  ['revenue', 'Revenue by month and club', 'Payments, coupon discounts, refunds and credits given.'],
  ['usage', 'Usage by month and club', 'Events live, live hours, camera hours, cloud engine hours, credits used.'],
  ['growth', 'Sign-ups and conversion by week', 'Sign-ups, and how many created an event, went live and paid.'],
  ['viewership', 'Viewership by event', 'Viewers, minutes watched, influencer viewers, games played, prizes.'],
  ['sms', 'SMS by event', 'Sent, failed, not sent for lack of credits, and cost.'],
  ['margin', 'Cost and margin by month', 'Revenue against estimated running costs.'],
];

export async function render(view) {
  const months = el('select', {}, [[3, 'Last 3 months'], [6, 'Last 6 months'], [12, 'Last 12 months'], [24, 'Last 24 months']].map(([v, t]) => el('option', { value: v, selected: v === 6 || undefined, text: t })));
  const preview = el('div');
  const show = guard(async (kind, label) => {
    const r = await get(`/api/admin/reports/${kind}?months=${months.value}`);
    preview.replaceChildren(el('h2', { text: label }), table(r.head, r.rows.slice(0, 200), { empty: 'No data for this period.' }), r.rows.length > 200 ? el('p', { class: 'small muted', text: `First 200 of ${r.rows.length} rows; download the CSV for all.` }) : null);
  });
  view.append(
    el('div', { class: 'row', style: 'margin-bottom:12px' }, el('div', { style: 'width:220px' }, months)),
    el('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fill,minmax(300px,1fr))' }, REPORTS.map(([k, label, text]) => el('div', { class: 'card' },
      el('strong', { text: label }), el('p', { class: 'small muted', text }),
      el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => show(k, label), text: 'View' }),
        el('button', { class: 'btn small', onclick: guard(() => download(`/api/admin/reports/${k}.csv?months=${months.value}`, `${k}.csv`)), text: 'Download CSV' }))))),
    preview);
}
