// Landing page: the animated control room, the cost calculator and live prices.
(function () {
  'use strict';
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var inr = function (n) { return '₹' + Math.round(n).toLocaleString('en-IN'); };
  var num = function (n) { return Math.round(n).toLocaleString('en-IN'); };

  // ---------------------------------------------------------------- scenes
  // Simple drawn "camera feeds" of different events, so the product reads as any-event, not one sport.
  function crowd() {
    var s = '';
    var tones = ['#d9a066', '#8a5a3b', '#c48a5c', '#5e3b26', '#e6b98a'];
    var shirts = ['#e3342b', '#2f7cf6', '#f2b13a', '#e8eef5', '#22a45a', '#7a4fd1'];
    for (var row = 0; row < 6; row++) {
      for (var i = 0; i < 20; i++) {
        var x = i * 8.6 + (row % 2 ? 4 : 0) - 2;
        var y = 34 + row * 10.5;
        var d = ((i * 7 + row * 3) % 10) / 10;
        s += '<g class="bob" style="animation-delay:-' + d + 's">' +
          '<ellipse cx="' + x + '" cy="' + (y + 8) + '" rx="5" ry="4" fill="' + shirts[(i + row * 2) % shirts.length] + '"/>' +
          '<circle cx="' + x + '" cy="' + y + '" r="3.2" fill="' + tones[(i * 3 + row) % tones.length] + '"/></g>';
      }
    }
    return s;
  }
  var SCENES = [
    {
      name: 'Cam 1  Stage', l3: ['Main stage', 'Live from the opening ceremony'],
      svg: '<rect width="160" height="90" fill="#22123d"/><rect y="0" width="160" height="40" fill="#1a0d30"/>' +
        '<polygon class="sweep" points="38,-4 46,-4 72,66 14,66" fill="#ffe7a8" opacity=".22"/>' +
        '<polygon class="sweep" style="animation-delay:-2.5s" points="114,-4 122,-4 146,66 90,66" fill="#a9c9ff" opacity=".2"/>' +
        '<rect x="20" y="58" width="120" height="7" fill="#3b2357"/><rect y="65" width="160" height="25" fill="#0f0820"/>' +
        '<g fill="#0a0612"><circle cx="64" cy="38" r="4.2"/><rect x="59.5" y="42" width="9" height="16" rx="3"/>' +
        '<circle cx="96" cy="40" r="4"/><rect x="91.5" y="44" width="9" height="14" rx="3"/><rect x="76" y="47" width="2" height="11"/></g>' +
        '<g fill="#05030a">' + [10, 26, 42, 58, 74, 90, 106, 122, 138, 154].map(function (x, i) { return '<circle class="bob" style="animation-delay:-' + (i % 4) * 0.4 + 's" cx="' + x + '" cy="86" r="6"/>'; }).join('') + '</g>'
    },
    {
      name: 'Cam 2  Pitch', l3: ['Final', 'Rangers 2 – 1 United'],
      svg: '<rect width="160" height="90" fill="#2f8f46"/>' +
        [0, 40, 80, 120].map(function (x) { return '<rect x="' + x + '" width="20" height="90" fill="#2a8240"/>'; }).join('') +
        '<g fill="none" stroke="#e8f5ea" stroke-width="1.2" opacity=".85"><rect x="6" y="8" width="148" height="74"/><line x1="80" y1="8" x2="80" y2="82"/><circle cx="80" cy="45" r="12"/><rect x="6" y="28" width="18" height="34"/><rect x="136" y="28" width="18" height="34"/></g>' +
        '<g class="bob"><circle cx="58" cy="40" r="2.6" fill="#e3342b"/><circle cx="70" cy="58" r="2.6" fill="#e3342b"/><circle cx="96" cy="30" r="2.6" fill="#e3342b"/></g>' +
        '<g class="bob" style="animation-delay:-.9s"><circle cx="88" cy="50" r="2.6" fill="#2f7cf6"/><circle cx="110" cy="44" r="2.6" fill="#2f7cf6"/><circle cx="104" cy="64" r="2.6" fill="#2f7cf6"/></g>' +
        '<circle cx="84" cy="47" r="1.4" fill="#fff"/>'
    },
    {
      name: 'Cam 3  Hole 7', l3: ['Hole 7', 'A. Mehta   −4   thru 15'],
      svg: '<rect width="160" height="90" fill="#9fd0f0"/><rect y="0" width="160" height="22" fill="#b7dcf4"/>' +
        '<g fill="#3f7d4a"><ellipse cx="18" cy="40" rx="22" ry="12"/><ellipse cx="52" cy="38" rx="20" ry="10"/><ellipse cx="128" cy="39" rx="26" ry="12"/><ellipse cx="160" cy="42" rx="18" ry="10"/></g>' +
        '<rect y="42" width="160" height="48" fill="#5aa04b"/><ellipse cx="80" cy="64" rx="96" ry="22" fill="#6fb35a"/>' +
        '<ellipse cx="96" cy="60" rx="38" ry="11" fill="#86ca6c"/><ellipse cx="98" cy="60" rx="2.6" ry="1.1" fill="#1d3a1d"/>' +
        '<line x1="98" y1="30" x2="98" y2="60" stroke="#f4f4f4" stroke-width="1"/><polygon class="bob" points="98,30 110,33.5 98,37" fill="#e3342b"/>' +
        '<g fill="#1d2a36"><circle cx="40" cy="56" r="2.6"/><rect x="38.4" y="58.4" width="3.2" height="9" rx="1.2"/><line x1="41" y1="60" x2="49" y2="66" stroke="#1d2a36" stroke-width="1"/></g>' +
        '<circle cx="62" cy="63" r="1" fill="#fff"/>'
    },
    {
      name: 'Cam 4  Crowd', l3: ['Viewer question', '“Who is leading after 15?”'],
      svg: '<rect width="160" height="90" fill="#2a1f16"/><rect y="8" width="160" height="16" fill="#e3342b"/>' +
        '<g fill="#fff" opacity=".9">' + [12, 40, 68, 96, 124, 152].map(function (x) { return '<rect x="' + (x - 8) + '" y="14" width="14" height="4" rx="2"/>'; }).join('') + '</g>' + crowd()
    }
  ];
  function sceneEl(i) {
    var d = document.createElement('div');
    d.className = 'scene';
    d.innerHTML = '<svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g class="drift">' + SCENES[i].svg + '</g></svg>';
    return d;
  }

  // ---------------------------------------------------------------- mixer
  var mixer = document.getElementById('mixer');
  if (mixer) {
    var feedsBox = document.getElementById('feeds');
    var pgmBox = document.getElementById('pgm');
    var l3 = document.getElementById('l3');
    var l3a = document.getElementById('l3a');
    var l3b = document.getElementById('l3b');
    var takeBtn = document.getElementById('take');
    var tcEl = document.getElementById('tc');
    var viewersEl = document.getElementById('viewers');
    var feeds = [];
    var pgm = 2;
    var pvw = 3;

    SCENES.forEach(function (sc, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'feed';
      b.setAttribute('aria-label', 'Preview ' + sc.name.replace(/\s+/g, ' '));
      b.appendChild(sceneEl(i));
      var n = document.createElement('span');
      n.className = 'feed-name';
      n.textContent = sc.name.replace(/\s+/g, ' ');
      b.appendChild(n);
      b.addEventListener('click', function () { userAction(); setPvw(i); });
      feedsBox.appendChild(b);
      feeds.push(b);
    });

    var current = sceneEl(pgm);
    pgmBox.insertBefore(current, pgmBox.firstChild);
    l3a.textContent = SCENES[pgm].l3[0];
    l3b.textContent = SCENES[pgm].l3[1];

    function paint() {
      feeds.forEach(function (f, i) {
        f.classList.toggle('pgm-on', i === pgm);
        f.classList.toggle('pvw', i === pvw && i !== pgm);
        f.setAttribute('aria-pressed', String(i === pvw));
      });
    }
    function setPvw(i) { pvw = i; paint(); }
    function take() {
      if (pvw === pgm) return;
      takeBtn.classList.add('hit');
      setTimeout(function () { takeBtn.classList.remove('hit'); }, 220);
      var next = sceneEl(pvw);
      pgmBox.insertBefore(next, current);
      var old = current;
      current = next;
      if (reduced) old.remove(); else { old.classList.add('leaving'); setTimeout(function () { old.remove(); }, 200); }
      var prev = pgm;
      pgm = pvw;
      pvw = prev;
      l3.classList.add('out');
      setTimeout(function () {
        l3a.textContent = SCENES[pgm].l3[0];
        l3b.textContent = SCENES[pgm].l3[1];
        l3.classList.remove('out');
      }, reduced ? 0 : 420);
      paint();
    }
    takeBtn.addEventListener('click', function () { userAction(); take(); });
    paint();

    // Auto-direct: preview the next camera, then take it. Pauses after a visitor clicks and when off screen.
    var visible = true;
    var pausedUntil = 0;
    function userAction() { pausedUntil = Date.now() + 9000; }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { visible = es[0].isIntersecting; }).observe(mixer);
    }
    var running = function () { return visible && document.visibilityState === 'visible' && Date.now() > pausedUntil; };
    if (!reduced) {
      setInterval(function () {
        if (!running()) return;
        setPvw((pgm + 1 + Math.floor(Math.random() * 3)) % 4);
        setTimeout(function () { if (running()) take(); }, 1300);
      }, 3600);
    }

    // Timecode (25 fps) and a gently moving viewer count.
    var start = performance.now() - (42 * 60 + 10) * 1000;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    function tick() {
      var ms = performance.now() - start;
      var s = Math.floor(ms / 1000);
      tcEl.textContent = pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60) + ':' + pad(Math.floor((ms % 1000) / 40));
    }
    if (!reduced) setInterval(function () { if (visible) tick(); }, 40);
    var viewers = 1284;
    if (!reduced) setInterval(function () {
      if (!visible) return;
      viewers = Math.max(900, viewers + Math.round((Math.random() - 0.35) * 14));
      viewersEl.textContent = num(viewers);
    }, 2000);
  }

  // ---------------------------------------------------------------- prices
  var P = { freeCameras: 2, freeMinutes: 10, cameraPrice: 100, minutePrice: 5 };
  var inrPerCredit = 1;

  function fillPrices(packs) {
    document.querySelectorAll('[data-p]').forEach(function (n) { n.textContent = num(P[n.getAttribute('data-p')]); });
    if (packs && packs.length) {
      var body = document.getElementById('packs');
      if (body) {
        body.replaceChildren.apply(body, packs.map(function (p) {
          var tr = document.createElement('tr');
          [p.label, inr(p.priceInr), num(p.credits)].forEach(function (v) { var td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });
          return tr;
        }));
      }
      // Use the dearest rate per credit so the website never understates the cost.
      inrPerCredit = Math.max.apply(null, packs.map(function (p) { return p.priceInr / p.credits; }));
    }
    var ex = document.getElementById('example');
    if (ex) {
      var c = oursCredits(4, 3);
      ex.textContent = 'Example: a 3-hour show with 4 cameras uses ' + num(c) + ' credits, about ' + inr(c * inrPerCredit) + '.';
    }
  }
  function oursCredits(cams, hours) {
    return Math.max(0, cams - P.freeCameras) * P.cameraPrice + Math.max(0, hours * 60 - P.freeMinutes) * P.minutePrice;
  }

  // ---------------------------------------------------------------- calculator
  var calc = document.getElementById('calc');
  var shown = {};
  function animateTo(el, value) {
    var from = shown[el.id] || 0;
    shown[el.id] = value;
    if (reduced) { el.textContent = inr(value); return; }
    var t0 = performance.now();
    (function step(t) {
      var k = Math.min(1, (t - t0) / 380);
      k = 1 - Math.pow(1 - k, 3);
      el.textContent = inr(from + (value - from) * k);
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }
  function rows(dl, list) {
    dl.replaceChildren();
    list.forEach(function (r) {
      var dt = document.createElement('dt'); dt.textContent = r[0];
      var dd = document.createElement('dd'); dd.textContent = r[1];
      dl.appendChild(dt); dl.appendChild(dd);
    });
  }
  function update() {
    if (!calc) return;
    var cams = +document.getElementById('cams').value;
    var hours = +document.getElementById('hours').value;
    document.getElementById('cams-out').textContent = cams;
    document.getElementById('hours-out').textContent = hours;
    var days = Math.ceil(hours / 8);
    var crew = [
      ['Camera operators with cameras (' + cams + ')', cams * 6000 * days],
      ['Vision mixer and director', 15000 * days],
      ['Live streaming kit and internet', 8000 * days],
      ['Scoreboard and graphics operator', 6000 * days],
      ['Crew travel and setup', 5000]
    ];
    var crewTotal = crew.reduce(function (a, r) { return a + r[1]; }, 0);
    rows(document.getElementById('crew'), crew.map(function (r) { return [r[0], inr(r[1])]; }));

    var extraCams = Math.max(0, cams - P.freeCameras);
    var paidMin = Math.max(0, hours * 60 - P.freeMinutes);
    var ours = [
      ['Phones at the event', 'Yours'],
      ['First ' + P.freeCameras + ' cameras and ' + P.freeMinutes + ' minutes', 'Free'],
      [extraCams + ' extra camera' + (extraCams === 1 ? '' : 's'), inr(extraCams * P.cameraPrice * inrPerCredit)],
      [num(paidMin) + ' live minutes', inr(paidMin * P.minutePrice * inrPerCredit)],
      ['Cloud production, graphics, restreaming', 'Included']
    ];
    var oursTotal = oursCredits(cams, hours) * inrPerCredit;
    rows(document.getElementById('ours'), ours);
    animateTo(document.getElementById('crew-total'), crewTotal);
    animateTo(document.getElementById('ours-total'), oursTotal);
    animateTo(document.getElementById('saving'), crewTotal - oursTotal);
    var pct = crewTotal > 0 ? Math.round((1 - oursTotal / crewTotal) * 100) : 0;
    document.getElementById('saving-pct').textContent = pct + '% less than hiring a crew for this event';
  }
  if (calc) {
    document.getElementById('cams').addEventListener('input', update);
    document.getElementById('hours').addEventListener('input', update);
  }

  fillPrices(null);
  update();
  fetch('/api/public/pricing').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (!d || !d.pricing) return;
    P = d.pricing;
    fillPrices(d.packs);
    update();
  }).catch(function () {});
})();
