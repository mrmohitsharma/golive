// Drawn "camera feeds" of real-world events, used across the website. Each event has two
// camera angles (SVG, 160x90) and an on-screen caption, the way a broadcast would show it.
(function () {
  'use strict';

  function crowd(y0, rows, opts) {
    opts = opts || {};
    var s = '';
    var tones = ['#d9a066', '#8a5a3b', '#c48a5c', '#5e3b26', '#e6b98a'];
    var shirts = opts.shirts || ['#e3342b', '#2f7cf6', '#f2b13a', '#e8eef5', '#22a45a', '#7a4fd1'];
    for (var row = 0; row < rows; row++) {
      for (var i = 0; i < 20; i++) {
        var x = i * 8.6 + (row % 2 ? 4 : 0) - 2;
        var y = y0 + row * 10.5;
        var d = ((i * 7 + row * 3) % 10) / 10;
        s += '<g class="bob" style="animation-delay:-' + d + 's">' +
          '<ellipse cx="' + x + '" cy="' + (y + 8) + '" rx="5" ry="4" fill="' + shirts[(i + row * 2) % shirts.length] + '"/>' +
          '<circle cx="' + x + '" cy="' + y + '" r="3.2" fill="' + tones[(i * 3 + row) % tones.length] + '"/>' +
          (opts.lights && (i + row) % 5 === 0 ? '<rect class="twinkle" style="animation-delay:-' + d * 2 + 's" x="' + (x + 2) + '" y="' + (y - 9) + '" width="2.2" height="3.4" rx=".5" fill="#fff6c9"/>' : '') +
          '</g>';
      }
    }
    return s;
  }
  function sil(x, y, s, fill) { // a standing person
    s = s || 1;
    return '<g fill="' + (fill || '#0a0612') + '"><circle cx="' + x + '" cy="' + y + '" r="' + 3.6 * s + '"/><rect x="' + (x - 4 * s) + '" y="' + (y + 3.6 * s) + '" width="' + 8 * s + '" height="' + 14 * s + '" rx="' + 3 * s + '"/></g>';
  }
  function runner(x, y, c, dur, delay) {
    return '<g class="run" style="animation-duration:' + dur + 's;animation-delay:-' + delay + 's"><g class="stride">' +
      '<circle cx="' + x + '" cy="' + y + '" r="2.4" fill="#5e3b26"/><rect x="' + (x - 2) + '" y="' + (y + 2.4) + '" width="4" height="6" rx="1.5" fill="' + c + '"/>' +
      '<path d="M' + (x - 1) + ' ' + (y + 8) + 'l-2.6 5M' + (x + 1) + ' ' + (y + 8) + 'l2.6 5" stroke="#2b1c12" stroke-width="1.4" stroke-linecap="round"/></g></g>';
  }
  function garland(x1, x2, y, sag) {
    var s = '';
    for (var i = 0; i <= 14; i++) {
      var t = i / 14;
      var x = x1 + (x2 - x1) * t;
      var yy = y + Math.sin(Math.PI * t) * sag;
      s += '<circle cx="' + x.toFixed(1) + '" cy="' + yy.toFixed(1) + '" r="1.7" fill="' + (i % 2 ? '#f39c12' : '#f7c948') + '"/>';
    }
    return s;
  }
  function lights(y, n) {
    var s = '';
    for (var i = 0; i < n; i++) {
      var x = 4 + i * (152 / (n - 1));
      s += '<circle class="twinkle" style="animation-delay:-' + (i % 5) * 0.37 + 's" cx="' + x.toFixed(1) + '" cy="' + (y + Math.sin(i) * 1.5).toFixed(1) + '" r="1.1" fill="#ffe8a3"/>';
    }
    return s;
  }

  var EVENTS = {
    golf: {
      label: 'Golf', where: 'Hole 7', caption: ['Hole 7', 'A. Mehta   −4   thru 15'], cams: 4,
      angles: [
        '<rect width="160" height="90" fill="#9fd0f0"/><rect width="160" height="22" fill="#b7dcf4"/>' +
        '<g fill="#3f7d4a"><ellipse cx="18" cy="40" rx="22" ry="12"/><ellipse cx="52" cy="38" rx="20" ry="10"/><ellipse cx="128" cy="39" rx="26" ry="12"/><ellipse cx="160" cy="42" rx="18" ry="10"/></g>' +
        '<rect y="42" width="160" height="48" fill="#5aa04b"/><ellipse cx="80" cy="64" rx="96" ry="22" fill="#6fb35a"/>' +
        '<ellipse cx="96" cy="60" rx="38" ry="11" fill="#86ca6c"/><ellipse cx="98" cy="60" rx="2.6" ry="1.1" fill="#1d3a1d"/>' +
        '<line x1="98" y1="30" x2="98" y2="60" stroke="#f4f4f4" stroke-width="1"/><polygon class="bob" points="98,30 110,33.5 98,37" fill="#e3342b"/>' +
        '<g fill="#1d2a36"><circle cx="40" cy="56" r="2.6"/><rect x="38.4" y="58.4" width="3.2" height="9" rx="1.2"/><line x1="41" y1="60" x2="49" y2="66" stroke="#1d2a36" stroke-width="1"/></g>' +
        '<circle cx="62" cy="63" r="1" fill="#fff"/>',
        '<rect width="160" height="90" fill="#78bf62"/><ellipse cx="80" cy="70" rx="120" ry="44" fill="#8fd174"/>' +
        '<ellipse cx="104" cy="58" rx="7" ry="3" fill="#1d3a1d"/><line x1="104" y1="10" x2="104" y2="58" stroke="#f4f4f4" stroke-width="1.6"/>' +
        '<polygon class="bob" points="104,10 126,16 104,22" fill="#e3342b"/><circle class="roll" cx="60" cy="66" r="3" fill="#fff"/>' +
        '<g fill="#1d2a36"><rect x="20" y="20" width="10" height="56" rx="4"/><circle cx="25" cy="15" r="6"/><line x1="30" y1="40" x2="52" y2="68" stroke="#cfd6dd" stroke-width="1.4"/></g>'
      ]
    },
    cricket: {
      label: 'Cricket', where: 'Final', caption: ['Final', 'Strikers 182/4   18.2 ov'], cams: 5,
      angles: [
        '<rect width="160" height="90" fill="#3d8b3d"/><ellipse cx="80" cy="50" rx="92" ry="52" fill="#46994a"/>' +
        '<rect x="0" y="0" width="160" height="8" fill="#e9eef2"/><polygon points="72,14 88,14 96,86 64,86" fill="#cdb27c"/>' +
        '<g fill="#f5f0e1"><rect x="78" y="16" width="1" height="5"/><rect x="80" y="16" width="1" height="5"/><rect x="76" y="16" width="1" height="5"/>' +
        '<rect x="76" y="74" width="1.6" height="9"/><rect x="79.2" y="74" width="1.6" height="9"/><rect x="82.4" y="74" width="1.6" height="9"/></g>' +
        sil(88, 60, 0.9, '#1a3b8f') + sil(80, 22, 0.55, '#f2f2f2') + '<circle class="bowl" cx="80" cy="30" r="1.2" fill="#c81d25"/>' +
        '<g fill="#f2f2f2">' + [20, 40, 120, 140].map(function (x, i) { return '<g class="bob" style="animation-delay:-' + i * 0.3 + 's"><circle cx="' + x + '" cy="' + (36 + (i % 2) * 14) + '" r="1.8"/></g>'; }).join('') + '</g>',
        '<rect width="160" height="90" fill="#1d2433"/><rect x="34" y="6" width="92" height="30" rx="2" fill="#0b0f17" stroke="#3a465c"/>' +
        '<text x="80" y="20" text-anchor="middle" font-size="9" font-weight="700" fill="#f2b13a" font-family="Arial">STRIKERS 182/4</text>' +
        '<text x="80" y="31" text-anchor="middle" font-size="6.5" fill="#cfd6dd" font-family="Arial">NEED 24 OFF 10</text>' + crowd(44, 5, {})
      ]
    },
    wedding: {
      label: 'Wedding', where: 'Mandap', caption: ['Live', 'Riya & Kabir   Jaipur'], cams: 3,
      angles: [
        '<rect width="160" height="90" fill="#3b0f22"/><rect y="66" width="160" height="24" fill="#5b1630"/>' +
        '<polygon points="30,66 130,66 150,90 10,90" fill="#8c1d3a"/>' +
        '<rect x="34" y="18" width="5" height="48" fill="#d9a441"/><rect x="121" y="18" width="5" height="48" fill="#d9a441"/>' +
        '<path d="M28 20 Q80 -6 132 20 Z" fill="#c0392b"/><rect x="28" y="18" width="104" height="4" fill="#d9a441"/>' +
        garland(40, 120, 24, 10) + garland(40, 120, 30, 14) + lights(6, 18) +
        '<g class="sway">' + sil(72, 40, 1.05, '#f3c06b') + sil(88, 40, 1.05, '#7a1430') + '</g>' +
        '<g class="sparkle"><circle cx="58" cy="44" r="1" fill="#fff6c9"/><circle cx="104" cy="38" r="1" fill="#fff6c9"/></g>',
        '<rect width="160" height="90" fill="#2a0c1c"/>' + lights(8, 22) + lights(16, 22) +
        '<polygon class="sweep" points="30,-4 38,-4 64,70 8,70" fill="#ff9ad5" opacity=".18"/><polygon class="sweep" style="animation-delay:-2s" points="122,-4 130,-4 152,70 98,70" fill="#ffd27a" opacity=".2"/>' +
        crowd(48, 4, { shirts: ['#f39c12', '#e84393', '#d9a441', '#c0392b', '#ffd27a', '#9b59b6'] })
      ]
    },
    concert: {
      label: 'Concert', where: 'Main stage', caption: ['Main stage', 'The Midnight Raagas'], cams: 6,
      angles: [
        '<rect width="160" height="90" fill="#22123d"/><rect width="160" height="40" fill="#1a0d30"/>' +
        '<polygon class="sweep" points="38,-4 46,-4 72,66 14,66" fill="#ffe7a8" opacity=".22"/>' +
        '<polygon class="sweep" style="animation-delay:-2.5s" points="114,-4 122,-4 146,66 90,66" fill="#a9c9ff" opacity=".2"/>' +
        '<rect x="20" y="58" width="120" height="7" fill="#3b2357"/><rect y="65" width="160" height="25" fill="#0f0820"/>' +
        '<g fill="#0a0612"><circle cx="64" cy="38" r="4.2"/><rect x="59.5" y="42" width="9" height="16" rx="3"/>' +
        '<circle cx="96" cy="40" r="4"/><rect x="91.5" y="44" width="9" height="14" rx="3"/><rect x="76" y="47" width="2" height="11"/></g>' +
        '<g fill="#05030a">' + [10, 26, 42, 58, 74, 90, 106, 122, 138, 154].map(function (x, i) { return '<circle class="bob" style="animation-delay:-' + (i % 4) * 0.4 + 's" cx="' + x + '" cy="86" r="6"/>'; }).join('') + '</g>',
        '<rect width="160" height="90" fill="#140a26"/><polygon class="sweep" points="76,-4 84,-4 120,60 40,60" fill="#ff5fa2" opacity=".2"/>' +
        crowd(30, 6, { lights: true, shirts: ['#2b1d3f', '#3a2456', '#1f1530', '#452b66'] })
      ]
    },
    conference: {
      label: 'Conference', where: 'Hall A', caption: ['Keynote', 'S. Rao   The future of retail'], cams: 3,
      angles: [
        '<rect width="160" height="90" fill="#0f1b2d"/><rect x="18" y="8" width="124" height="46" rx="2" fill="#1e3a5f"/>' +
        '<g fill="#5fb3ff">' + [0, 1, 2, 3, 4, 5].map(function (i) { return '<rect class="bar" style="animation-delay:-' + i * 0.4 + 's" x="' + (34 + i * 16) + '" y="' + (44 - (8 + i * 5)) + '" width="9" height="' + (8 + i * 5) + '"/>'; }).join('') + '</g>' +
        '<rect x="30" y="47" width="100" height="1" fill="#8fb6dd"/><text x="30" y="17" font-size="5.5" font-weight="700" fill="#e8eef5" font-family="Arial">Online sales, 2021 to 2026</text>' +
        '<rect y="60" width="160" height="30" fill="#0a1220"/>' + sil(124, 52, 0.8, '#e8eef5') + '<polygon points="114,64 134,64 131,84 117,84" fill="#2c4466"/>' +
        '<g fill="#05090f">' + [8, 22, 36, 50, 64, 78, 92].map(function (x) { return '<circle cx="' + x + '" cy="86" r="6"/>'; }).join('') + '</g>',
        '<rect width="160" height="90" fill="#16233a"/><rect x="50" y="6" width="60" height="26" fill="#2f5d91"/>' + sil(80, 34, 0.5, '#e8eef5') +
        crowd(44, 5, { shirts: ['#2c3e50', '#34495e', '#7f8c8d', '#1f3a5a', '#4a5d73'] })
      ]
    },
    marathon: {
      label: 'Marathon', where: 'Km 21', caption: ['Km 21', 'Leaders   1:04:12'], cams: 4,
      angles: [
        '<rect width="160" height="90" fill="#ffd59e"/><rect width="160" height="24" fill="#ffe7c2"/>' +
        '<g fill="#d79a6b">' + [[0, 26, 14, 22], [16, 18, 12, 30], [30, 30, 18, 18], [110, 22, 14, 26], [126, 14, 16, 34], [144, 26, 16, 22]].map(function (b) { return '<rect x="' + b[0] + '" y="' + b[1] + '" width="' + b[2] + '" height="' + b[3] + '"/>'; }).join('') + '</g>' +
        '<polygon points="0,48 160,48 160,90 0,90" fill="#6d7680"/><rect y="46" width="160" height="3" fill="#e9eef2"/><rect y="66" width="160" height="1.4" fill="#f5f5f5" opacity=".7"/>' +
        '<rect x="56" y="16" width="3" height="32" fill="#c81d25"/><rect x="101" y="16" width="3" height="32" fill="#c81d25"/><rect x="56" y="14" width="48" height="9" fill="#c81d25"/>' +
        '<text x="80" y="21" text-anchor="middle" font-size="6" font-weight="700" fill="#fff" font-family="Arial">FINISH</text>' +
        runner(30, 54, '#2f7cf6', 6, 0) + runner(30, 60, '#e3342b', 7, 2.5) + runner(30, 52, '#22a45a', 6.5, 4.2) + runner(30, 64, '#f2b13a', 7.5, 1.4),
        '<rect width="160" height="90" fill="#7d8791"/><rect width="160" height="30" fill="#ffd59e"/><rect y="28" width="160" height="2" fill="#e9eef2"/>' +
        '<g transform="translate(-10 0) scale(2)">' + runner(40, 24, '#2f7cf6', 7, 0) + runner(40, 26, '#e3342b', 8, 3) + '</g>'
      ]
    },
    football: {
      label: 'Football', where: 'Final', caption: ['Final', 'Rangers 2 – 1 United'], cams: 4,
      angles: [
        '<rect width="160" height="90" fill="#2f8f46"/>' +
        [0, 40, 80, 120].map(function (x) { return '<rect x="' + x + '" width="20" height="90" fill="#2a8240"/>'; }).join('') +
        '<g fill="none" stroke="#e8f5ea" stroke-width="1.2" opacity=".85"><rect x="6" y="8" width="148" height="74"/><line x1="80" y1="8" x2="80" y2="82"/><circle cx="80" cy="45" r="12"/><rect x="6" y="28" width="18" height="34"/><rect x="136" y="28" width="18" height="34"/></g>' +
        '<g class="bob"><circle cx="58" cy="40" r="2.6" fill="#e3342b"/><circle cx="70" cy="58" r="2.6" fill="#e3342b"/><circle cx="96" cy="30" r="2.6" fill="#e3342b"/></g>' +
        '<g class="bob" style="animation-delay:-.9s"><circle cx="88" cy="50" r="2.6" fill="#2f7cf6"/><circle cx="110" cy="44" r="2.6" fill="#2f7cf6"/><circle cx="104" cy="64" r="2.6" fill="#2f7cf6"/></g>' +
        '<circle class="roll" cx="84" cy="47" r="1.4" fill="#fff"/>',
        '<rect width="160" height="90" fill="#202733"/>' + crowd(30, 6, { shirts: ['#e3342b', '#e3342b', '#ffffff', '#2f7cf6'] })
      ]
    },
    school: {
      label: 'Sports day', where: 'Track', caption: ['100 m final', 'Lane 4   12.41 s'], cams: 3,
      angles: [
        '<rect width="160" height="90" fill="#4f9a50"/><rect y="30" width="160" height="56" fill="#c0533a"/>' +
        [37, 45, 53, 61, 69, 77].map(function (y) { return '<rect y="' + y + '" width="160" height=".8" fill="#f5e8e2"/>'; }).join('') +
        '<rect x="132" y="30" width="2" height="56" fill="#fff"/>' +
        runner(20, 30, '#2f7cf6', 4, 0) + runner(20, 38, '#f2b13a', 4.4, 1) + runner(20, 46, '#22a45a', 4.2, 2) + runner(20, 54, '#e3342b', 4.6, 0.5) + runner(20, 62, '#7a4fd1', 4.3, 1.6),
        '<rect width="160" height="90" fill="#bfe1f5"/><rect y="50" width="160" height="40" fill="#4f9a50"/>' + crowd(48, 4, { shirts: ['#ffffff', '#2f7cf6', '#ffffff', '#e3342b'] })
      ]
    }
  };

  function svg(markup) {
    return '<svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g class="drift">' + markup + '</g></svg>';
  }

  /** A live monitor: cuts between the event's camera angles on its own. */
  function monitor(key, opts) {
    opts = opts || {};
    var ev = EVENTS[key];
    var box = document.createElement('div');
    box.className = 'monitor' + (opts.className ? ' ' + opts.className : '');
    box.setAttribute('data-event', key);
    var stage = document.createElement('div');
    stage.className = 'monitor-stage';
    ev.angles.forEach(function (a, i) {
      var layer = document.createElement('div');
      layer.className = 'scene' + (i === 0 ? ' on' : '');
      layer.innerHTML = svg(a);
      stage.appendChild(layer);
    });
    box.appendChild(stage);
    if (opts.caption !== false) {
      var cap = document.createElement('div');
      cap.className = 'cap';
      cap.innerHTML = '<b></b><span></span>';
      cap.firstChild.textContent = ev.caption[0];
      cap.lastChild.textContent = ev.caption[1];
      box.appendChild(cap);
    }
    if (opts.badge !== false) {
      var tag = document.createElement('div');
      tag.className = 'mon-tag';
      tag.innerHTML = '<i></i><span></span>';
      tag.lastChild.textContent = ev.label + (opts.short ? '' : ' · ' + ev.cams + ' cams');
      box.appendChild(tag);
    }
    return box;
  }

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** Every monitor on the page cuts to another angle now and then, like a director would. */
  function autoCut(root) {
    if (reduced) return;
    setInterval(function () {
      if (document.visibilityState !== 'visible' || (root && root.classList.contains('paused'))) return;
      var mons = (root || document).querySelectorAll('.monitor');
      if (!mons.length) return;
      var m = mons[Math.floor(Math.random() * mons.length)];
      var layers = m.querySelectorAll('.monitor-stage .scene');
      if (layers.length < 2) return;
      var cur = Array.prototype.findIndex.call(layers, function (l) { return l.classList.contains('on'); });
      layers[cur].classList.remove('on');
      layers[(cur + 1) % layers.length].classList.add('on');
      m.classList.remove('cut');
      void m.offsetWidth;
      m.classList.add('cut');
    }, 1400);
  }

  window.GoLiveScenes = { EVENTS: EVENTS, svg: svg, monitor: monitor, autoCut: autoCut, reduced: reduced };
})();
