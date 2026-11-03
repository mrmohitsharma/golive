// Event branding (V8): watch-page theme by kind of event, colour, own logo (paid per event;
// the Go Live logo otherwise), logo watermark and a TV-style scrolling ticker in the video.
// A live preview shows the watch page bar and the video with watermark and ticker.
import { get, post, patch, del, el, toast, guard, go, confirmBox, num } from './core.js';

const GL = '<svg viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="14" fill="#ee3b2f"/><circle cx="15" cy="15" r="10.5" fill="none" stroke="#fff" stroke-width="1.6" stroke-dasharray="46 20" stroke-linecap="round"/><path d="M12.6 10.4v9.2l7.4-4.6z" fill="#fff"/></svg>';

const readFile = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error('Could not read the file.'));
  r.readAsDataURL(file);
});

/** Buys an add-on; offers the wallet when credits are short. Returns the new view or null. */
async function buy(id, what, price) {
  const label = what === 'branding' ? 'Your own logo and watermark' : 'The scrolling ticker';
  if (!(await confirmBox(`${label} for this event`, `${num(price)} credits from the club's wallet, once for this event.`, `Buy for ${num(price)} credits`, false))) return null;
  try {
    const r = await post(`/api/tournaments/${id}/branding/buy`, { what });
    toast(`${label}: ready to use`);
    return r;
  } catch (e) {
    if (e.status === 402) { if (await confirmBox('Not enough credits', `${e.message} Buy credits now?`, 'Buy credits', false)) go('/web/wallet'); return null; }
    throw e;
  }
}

export async function render(body, id) {
  let v = await get(`/api/tournaments/${id}/branding`);
  const draw = () => {
    const b = v.branding;
    const th = v.themes.find((x) => x.id === b.theme) ?? v.themes[0];
    const accent = b.accent ?? th.accent;
    const save = (p, msg) => guard(async () => { v = await patch(`/api/tournaments/${id}/branding`, p); if (msg) toast(msg); draw(); });

    // ---------------------------------------------------------------- live preview
    const logo = b.logoUrl ? el('img', { src: b.logoUrl, alt: 'Logo' }) : el('div', { class: 'gl' });
    if (!b.logoUrl) logo.innerHTML = GL + '<span>GO LIVE</span>';
    const wm = b.watermark.enabled ? el('div', { class: 'bp-wm ' + b.watermark.size, style: `opacity:${b.watermark.opacity}` }) : null;
    if (wm) { if (b.logoUrl) wm.append(el('img', { src: b.logoUrl, alt: '' })); else wm.innerHTML = '<div class="gl">' + GL + '<span>GO LIVE</span></div>'; }
    const items = v.tickerItems;
    const ticker = b.ticker.enabled && items.length ? el('div', { class: 'bp-tk' },
      el('span', { class: 'bp-tk-l', text: b.ticker.label }),
      el('div', { class: 'bp-tk-run' }, el('div', { class: 'bp-tk-track', style: `animation-duration:${Math.max(8, items.reduce((a, x) => a + x.text.length, 0) / (b.ticker.speed === 'fast' ? 9 : b.ticker.speed === 'slow' ? 4 : 6))}s` },
        ...[...items, ...items].map((x) => el('span', { class: 'bp-it' + (x.sponsor ? ' sp' : '') }, x.sponsor ? el('b', { text: 'SPONSOR' }) : null, x.text))))) : null;
    const preview = el('div', { class: 'bp', style: `--bg:${th.bg};--panel:${th.panel};--panel2:${th.panel2};--ink:${th.ink};--muted:${th.muted};--accent:${accent};--live:${th.live}` },
      el('div', { class: 'bp-bar f-' + th.font }, el('div', { class: 'bp-logo' }, logo), el('div', { style: 'flex:1;min-width:0' }, el('div', { class: 'bp-org', text: 'Your club' }), el('div', { class: 'bp-title', text: 'Your event' })),
        el('span', { class: 'bp-clock', text: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }), el('span', { class: 'bp-live', text: 'LIVE' })),
      el('div', { class: 'bp-video' }, el('div', { class: 'bp-pic' }), wm, ticker),
      el('div', { class: 'small', style: 'color:var(--muted);padding:8px 12px', text: 'Preview: the watch page bar on top, the video below with the watermark and the ticker (also on YouTube, Facebook and Instagram).' }));

    // ---------------------------------------------------------------- themes
    const groups = [...new Set(v.themes.map((x) => x.group))];
    const themes = el('div', {}, ...groups.map((g) => el('div', { style: 'margin-bottom:12px' },
      el('div', { class: 'small muted', style: 'margin-bottom:6px', text: g }),
      el('div', { class: 'theme-grid' }, v.themes.filter((x) => x.group === g).map((x) => el('button', {
        type: 'button', class: 'theme-card' + (x.id === b.theme ? ' on' : ''), title: x.label,
        style: `background:linear-gradient(135deg, ${x.panel2}, ${x.bg})`, onclick: x.id === b.theme ? null : save({ theme: x.id, accent: null }, `Theme: ${x.label}`),
      }, el('span', { class: 'sw', style: `background:${x.accent}` }), el('span', { class: 'sw', style: `background:${x.live}` }), el('span', { class: 'tl', text: x.label })))))));
    const color = el('input', { type: 'color', value: accent, onchange: (e) => save({ accent: e.target.value }, 'Colour saved')() });

    // ---------------------------------------------------------------- logo
    const fileIn = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, onchange: guard(async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (f.size > 1_500_000) throw new Error('The logo must be 1.5 MB or smaller.');
      v = await post(`/api/tournaments/${id}/branding/logo`, { dataUrl: await readFile(f) });
      toast('Logo uploaded'); draw();
    }) });
    const logoCard = el('div', { class: 'card' },
      el('strong', { text: 'Your logo' }),
      el('p', { class: 'small muted', style: 'margin:4px 0 10px', text: 'Top left of the watch page, and the watermark in the video. Without one, the Go Live logo is used. PNG with a clear background works best (up to 1.5 MB).' }),
      v.owned.branding
        ? el('div', { class: 'row', style: 'flex-wrap:wrap' },
            el('button', { class: 'btn primary', onclick: () => fileIn.click(), text: b.logoUrl ? 'Change logo' : 'Upload logo' }),
            b.logoUrl ? el('button', { class: 'btn', onclick: guard(async () => { v = await del(`/api/tournaments/${id}/branding/logo`); toast('Back to the Go Live logo'); draw(); }), text: 'Use the Go Live logo' }) : null, fileIn)
        : el('div', { class: 'row', style: 'flex-wrap:wrap' },
            el('span', { class: 'small', text: `Your own logo and watermark: ${num(v.prices.branding)} credits for this event.` }),
            el('button', { class: 'btn primary', onclick: guard(async () => { const r = await buy(id, 'branding', v.prices.branding); if (r) { v = r; draw(); } }), text: `Buy (${num(v.prices.branding)} credits)` })));

    // ---------------------------------------------------------------- watermark
    const wmCard = el('div', { class: 'card' },
      el('div', { class: 'row' }, el('strong', { text: 'Watermark in the video' }), el('div', { class: 'sp' }),
        el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: b.watermark.enabled || undefined, onchange: (e) => save({ watermark: { enabled: e.target.checked } }, e.target.checked ? 'Watermark on' : 'Watermark off')() }), 'Show')),
      el('p', { class: 'small muted', style: 'margin:4px 0 10px', text: 'Your logo (or the Go Live logo), see-through, at the bottom right of the video. Part of the stream, so it shows on YouTube, Facebook, Instagram and in clips.' }),
      el('div', { class: 'row', style: 'flex-wrap:wrap' },
        el('label', { class: 'small' }, 'Size ', el('select', { onchange: (e) => save({ watermark: { size: e.target.value } })() },
          ['small', 'medium', 'large'].map((x) => el('option', { value: x, selected: x === b.watermark.size || undefined, text: x[0].toUpperCase() + x.slice(1) })))),
        el('label', { class: 'small', style: 'display:flex;align-items:center;gap:8px' }, 'See-through ',
          el('input', { type: 'range', min: '0.2', max: '1', step: '0.05', value: String(b.watermark.opacity), onchange: (e) => save({ watermark: { opacity: Number(e.target.value) } })() }))));

    // ---------------------------------------------------------------- ticker
    const lines = el('textarea', { rows: 4, placeholder: 'One line each, e.g.\nFinal: Gurgaon XI vs City FC at 4 pm\nFollow us @ourclub for highlights', value: b.ticker.lines.join('\n') });
    const sponsors = el('textarea', { rows: 3, placeholder: 'One sponsor message each, e.g.\nBrought to you by Sharma Motors: 10% off this week', value: b.ticker.sponsors.join('\n') });
    const label = el('input', { maxlength: '16', value: b.ticker.label, style: 'width:120px' });
    const speed = el('select', {}, [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']].map(([k, l]) => el('option', { value: k, selected: k === b.ticker.speed || undefined, text: l })));
    const split = (t) => t.value.split('\n').map((x) => x.trim()).filter(Boolean);
    const tkCard = el('div', { class: 'card' },
      el('div', { class: 'row' }, el('strong', { text: 'Scrolling ticker' }), el('div', { class: 'sp' }),
        v.owned.ticker
          ? el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: b.ticker.enabled || undefined, onchange: (e) => save({ ticker: { enabled: e.target.checked, lines: split(lines), sponsors: split(sponsors), label: label.value, speed: speed.value } }, e.target.checked ? 'Ticker on air' : 'Ticker off')() }), 'On air')
          : null),
      el('p', { class: 'small muted', style: 'margin:4px 0 10px', text: 'A news-channel style line that keeps scrolling along the bottom of the video. Your lines, with a sponsor message after every two. Change it any time, also from the control room.' }),
      v.owned.ticker
        ? el('div', { class: 'form' },
            el('label', {}, 'Your lines', lines),
            el('label', {}, 'Sponsor messages', sponsors),
            el('div', { class: 'row', style: 'flex-wrap:wrap' }, el('label', { class: 'small' }, 'Label ', label), el('label', { class: 'small' }, 'Speed ', speed), el('div', { class: 'sp' }),
              el('button', { class: 'btn primary', onclick: save({ ticker: { lines: split(lines), sponsors: split(sponsors), label: label.value, speed: speed.value } }, 'Ticker saved'), text: 'Save ticker' })))
        : el('div', { class: 'row', style: 'flex-wrap:wrap' },
            el('span', { class: 'small', text: `The ticker costs ${num(v.prices.ticker)} credits for this event.` }),
            el('button', { class: 'btn primary', onclick: guard(async () => { const r = await buy(id, 'ticker', v.prices.ticker); if (r) { v = r; draw(); } }), text: `Buy (${num(v.prices.ticker)} credits)` })));

    body.replaceChildren(
      el('div', { class: 'brand-layout' },
        el('div', {},
          el('div', { class: 'card' },
            el('div', { class: 'row' }, el('strong', { text: 'Theme' }), el('span', { class: 'small muted', text: `· ${th.label}` }), el('div', { class: 'sp' }),
              el('label', { class: 'small', style: 'display:flex;align-items:center;gap:6px' }, 'Main colour', color),
              b.accent ? el('button', { class: 'btn small ghost', onclick: save({ accent: null }, 'Theme colour'), text: 'Reset' }) : null),
            el('p', { class: 'small muted', style: 'margin:4px 0 10px', text: 'Colours and type of the watch page and of the graphics in the video. Free. Pick the kind of event closest to yours.' }),
            themes),
          logoCard, wmCard, tkCard),
        el('div', { class: 'brand-preview' }, preview)));
  };
  draw();
}
