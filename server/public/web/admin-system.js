import { get, el, stat, table, inr, num, barChart } from './core.js';

export const title = 'System';

export async function render(view) {
  const load = async () => {
    const s = await get('/api/admin/system');
    const cur = s.margin.at(-1);
    view.replaceChildren(
      el('h2', { text: 'Health' }),
      el('div', { class: 'grid' },
        stat(s.media.reachable ? 'OK' : 'Down', 'Media server (MediaMTX)', !s.media.reachable), stat(s.media.streams, 'Streams coming in'),
        stat(s.live.events, 'Live events'), stat(s.live.cloudEngines, 'Cloud engines live'), stat(s.live.enginesDisconnected, 'Engines disconnected', s.live.enginesDisconnected > 0),
        stat(s.server.load[0], `Load (${s.server.cpus} CPUs)`), stat(s.server.memoryUsedPct + '%', 'Memory used', s.server.memoryUsedPct > 90),
        stat(s.database.sizeMb + ' MB', 'Database'), stat(s.server.uptimeMin < 120 ? s.server.uptimeMin + ' min' : Math.round(s.server.uptimeMin / 60) + ' h', 'Server up for')),
      !s.media.reachable ? el('div', { class: 'banner bad', text: `Media server not reachable: ${s.media.error ?? ''}` }) : null,
      el('div', { class: 'grid', style: 'margin-top:10px' }, s.disks.map((d) => stat(`${d.freeGb} GB free`, `${d.path} (of ${d.totalGb} GB)`, d.freeGb < 5))),
      el('h2', { text: 'Integrations' }),
      table(['Service', 'State'], Object.entries(s.integrations).map(([k, v]) => [{ payments: 'Payments', sms: 'SMS', youtube: 'YouTube', cloud: 'Cloud production', invoices: 'GST invoices' }[k] ?? k, v])),
      el('h2', { text: 'Cost against revenue' }),
      el('div', { class: 'grid' }, stat(inr(cur.revenueInr), 'Revenue this month (after refunds)'), stat(inr(cur.costInr), 'Estimated cost this month'),
        stat(inr(cur.marginInr), 'Margin this month', cur.marginInr < 0), stat(num(cur.liveHours) + ' h', 'Live hours'), stat(num(cur.cloudHours) + ' h', 'Cloud engine hours')),
      el('div', { class: 'card', style: 'margin-top:10px' }, el('div', { class: 'small muted', style: 'margin-bottom:6px', text: 'Margin by month (₹)' }),
        barChart(s.margin.map((m) => ({ ...m, pos: Math.max(0, m.marginInr) })), { value: (r) => r.pos, label: (r) => r.month, fmt: inr, height: 120 })),
      table(['Month', { t: 'Revenue', n: true }, { t: 'Fixed', n: true }, { t: 'Cloud', n: true }, { t: 'Bandwidth', n: true }, { t: 'SMS', n: true }, { t: 'Cost', n: true }, { t: 'Margin', n: true }],
        s.margin.slice().reverse().map((m) => [m.month, inr(m.revenueInr), inr(m.costs.fixed), inr(m.costs.cloud), inr(m.costs.bandwidth), inr(m.costs.sms), inr(m.costInr),
          el('span', { style: `color:${m.marginInr < 0 ? 'var(--bad)' : '#7ee0a6'};font-weight:700`, text: inr(m.marginInr) })])),
      el('p', { class: 'small muted', text: 'Costs are estimates from the rates in Settings and the usage we measure (cloud engine hours, camera hours, SMS sent). Check them against your AWS and MSG91 bills.' }),
      el('p', { class: 'small muted', text: `Version ${s.server.version} · Node ${s.server.node} · ${num(s.database.rows.users)} users · ${num(s.database.rows.events)} events · ${num(s.database.rows.viewers)} viewers` }));
  };
  await load();
  const t = setInterval(() => load().catch(() => {}), 30000);
  return () => clearInterval(t);
}
