// Landing page: the live-events network, the control-room demo, the cost calculator,
// live prices and scroll effects. Uses window.GoLiveScenes from scenes.js.
(function () {
  'use strict';
  var G = window.GoLiveScenes;
  var reduced = G ? G.reduced : false;
  var inr = function (n) { return '₹' + Math.round(n).toLocaleString('en-IN'); };
  var num = function (n) { return Math.round(n).toLocaleString('en-IN'); };
  var SVGNS = 'http://www.w3.org/2000/svg';

  /** Runs fn only while el is on screen (and toggles .paused so CSS animations stop off screen). */
  function whileVisible(el, cb) {
    var vis = true;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        vis = es[0].isIntersecting;
        el.classList.toggle('paused', !vis);
        if (cb) cb(vis);
      }, { rootMargin: '80px' }).observe(el);
    }
    return function () { return vis && document.visibilityState === 'visible'; };
  }

  // ---------------------------------------------------------------- network
  var network = document.getElementById('network');
  if (network && G) {
    var EVENTS = ['golf', 'cricket', 'wedding', 'concert', 'conference', 'marathon'];
    var OUTS = [
      { key: 'youtube', name: 'YouTube', color: '#ff0033', glyph: '<svg viewBox="0 0 12 12"><path d="M4 2.5v7L10 6z" fill="#fff"/></svg>', views: 3120 },
      { key: 'facebook', name: 'Facebook', color: '#1877f2', glyph: '<svg viewBox="0 0 12 12"><path d="M6.8 11V6.6h1.5l.2-1.7H6.8V3.8c0-.5.1-.8.8-.8h.9V1.5A12 12 0 0 0 7.2 1.4C5.9 1.4 5 2.2 5 3.6v1.3H3.5v1.7H5V11z" fill="#fff"/></svg>', views: 1480 },
      { key: 'instagram', name: 'Instagram', color: 'linear-gradient(45deg,#f9a825,#e91e63,#7b1fa2)', glyph: '<svg viewBox="0 0 12 12"><rect x="1.8" y="1.8" width="8.4" height="8.4" rx="2.4" fill="none" stroke="#fff" stroke-width="1.2"/><circle cx="6" cy="6" r="2" fill="none" stroke="#fff" stroke-width="1.2"/></svg>', views: 940, vertical: true },
      { key: 'watch', name: 'Watch page', color: '#22b863', glyph: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.4" fill="none" stroke="#fff" stroke-width="1.2"/><path d="M1.8 6h8.4M6 1.6c1.6 2.6 1.6 6.2 0 8.8M6 1.6c-1.6 2.6-1.6 6.2 0 8.8" stroke="#fff" stroke-width=".9" fill="none"/></svg>', views: 610, watch: true }
    ];
    var evBox = document.getElementById('net-events');
    var outBox = document.getElementById('net-outs');
    var core = document.getElementById('net-core');
    var wires = document.getElementById('net-wires');
    var status = document.getElementById('core-status');

    var mons = EVENTS.map(function (k) { var m = G.monitor(k, { caption: true }); evBox.appendChild(m); return m; });

    var outs = OUTS.map(function (o) {
      var d = document.createElement('div');
      d.className = 'dest';
      d.innerHTML = '<div class="dest-head"><span class="glyph" style="background:' + o.color + '">' + o.glyph + '</span><span></span><span class="views"></span></div>';
      d.querySelector('.dest-head span:nth-child(2)').textContent = o.name;
      var screen = document.createElement('div');
      screen.className = 'dest-screen' + (o.vertical ? ' vertical' : '') + (o.watch ? ' watch' : '');
      if (o.vertical) screen.innerHTML = '<div class="v-frame"><div class="v-blur"></div><div class="v-main"></div></div>';
      if (o.watch) screen.innerHTML = '<div class="w-video"></div><div class="w-side"><div class="w-row lead"></div><div class="w-row"></div><div class="w-row"></div><div class="w-row"></div><div class="w-chat"></div></div>';
      d.appendChild(screen);
      outBox.appendChild(d);
      return { o: o, el: d, screen: screen, views: o.views, viewsEl: d.querySelector('.views') };
    });

    // Draw an event's current camera angle into a destination screen, cross-fading.
    function show(target, key) {
      var ev = G.EVENTS[key];
      var mon = mons[EVENTS.indexOf(key)];
      var layers = mon.querySelectorAll('.monitor-stage .scene');
      var cur = Math.max(0, Array.prototype.findIndex.call(layers, function (l) { return l.classList.contains('on'); }));
      var s = document.createElement('div');
      s.className = 'scene';
      s.innerHTML = G.svg(ev.angles[cur]);
      var old = target.querySelectorAll('.scene');
      target.appendChild(s);
      requestAnimationFrame(function () { s.classList.add('on'); });
      setTimeout(function () { old.forEach(function (n) { n.remove(); }); }, 400);
    }
    function paintOut(x, key) {
      if (x.o.vertical) { show(x.screen.querySelector('.v-blur'), key); show(x.screen.querySelector('.v-main'), key); }
      else if (x.o.watch) {
        show(x.screen.querySelector('.w-video'), key);
        var side = x.screen.querySelector('.w-side');
        var c = side.querySelector('.w-chat');
        var n = c.cloneNode();
        c.replaceWith(n); // replays the chat-in animation
      } else show(x.screen, key);
      x.el.classList.add('flash');
      setTimeout(function () { x.el.classList.remove('flash'); }, 700);
    }
    function paintViews() { outs.forEach(function (x) { x.viewsEl.innerHTML = '<b>' + num(x.views) + '</b><span class="w"> watching</span>'; }); }

    // Wires: curves from each event into the core, and from the core out to each platform.
    var paths = [];
    function layout() {
      if (getComputedStyle(wires).display === 'none') return;
      var box = network.getBoundingClientRect();
      var c = core.getBoundingClientRect();
      var cx = c.left - box.left, cy = c.top - box.top + c.height / 2, cr = c.width / 2;
      wires.setAttribute('viewBox', '0 0 ' + box.width + ' ' + box.height);
      var d = [];
      mons.forEach(function (m) {
        var r = m.getBoundingClientRect();
        var sx = r.right - box.left, sy = r.top - box.top + r.height / 2, ex = cx + 6, ey = cy;
        var k = (ex - sx) * 0.55;
        d.push('M' + sx + ' ' + sy + ' C' + (sx + k) + ' ' + sy + ' ' + (ex - k) + ' ' + ey + ' ' + ex + ' ' + ey);
      });
      outs.forEach(function (x) {
        var r = x.el.getBoundingClientRect();
        var sx = cx + cr * 2 - 6, sy = cy, ex = r.left - box.left, ey = r.top - box.top + r.height / 2;
        var k = (ex - sx) * 0.55;
        d.push('M' + sx + ' ' + sy + ' C' + (sx + k) + ' ' + sy + ' ' + (ex - k) + ' ' + ey + ' ' + ex + ' ' + ey);
      });
      if (!paths.length) build(d.length);
      d.forEach(function (v, i) { paths[i].setAttribute('d', v); });
    }
    function build(n) {
      for (var i = 0; i < n; i++) {
        var p = document.createElementNS(SVGNS, 'path');
        p.setAttribute('id', 'wire-' + i);
        p.setAttribute('class', 'wire');
        wires.appendChild(p);
        paths.push(p);
        if (reduced) continue;
        var outWire = i >= EVENTS.length;
        for (var j = 0; j < (outWire ? 3 : 2); j++) {
          var dot = document.createElementNS(SVGNS, 'circle');
          dot.setAttribute('r', outWire ? '2.6' : '2');
          dot.setAttribute('class', 'spark' + (outWire ? '' : ' dim'));
          var am = document.createElementNS(SVGNS, 'animateMotion');
          am.setAttribute('dur', (outWire ? 1.6 : 2.6) + (i % 3) * 0.2 + 's');
          am.setAttribute('repeatCount', 'indefinite');
          am.setAttribute('begin', '-' + (j * (outWire ? 0.55 : 1.3) + i * 0.17).toFixed(2) + 's');
          var mp = document.createElementNS(SVGNS, 'mpath');
          mp.setAttribute('href', '#wire-' + i);
          mp.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#wire-' + i);
          am.appendChild(mp);
          dot.appendChild(am);
          wires.appendChild(dot);
        }
      }
    }
    layout();
    window.addEventListener('resize', function () { requestAnimationFrame(layout); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
    setTimeout(layout, 600);

    // Spotlight: every few seconds one event is featured and goes out to every platform.
    var featured = -1;
    function feature(i) {
      featured = i;
      mons.forEach(function (m, j) { m.classList.toggle('featured', j === i); });
      paths.forEach(function (p, j) { p.classList.toggle('hot', j === i || j >= EVENTS.length); });
      var ev = G.EVENTS[EVENTS[i]];
      status.textContent = 'Sending ' + ev.label.toLowerCase() + ' to 4 platforms';
      outs.forEach(function (x, j) { setTimeout(function () { paintOut(x, EVENTS[i]); }, 180 + j * 120); });
    }
    paintViews();
    feature(0);
    var running = whileVisible(network);
    if (!reduced) {
      G.autoCut(network);
      setInterval(function () { if (running()) feature((featured + 1) % EVENTS.length); }, 3800);
      setInterval(function () {
        if (!running()) return;
        outs.forEach(function (x) { x.views = Math.max(200, x.views + Math.round((Math.random() - 0.3) * x.views * 0.012)); });
        paintViews();
      }, 1600);
    }
  }

  // ---------------------------------------------------------------- marquee (seamless loop)
  var mq = document.getElementById('marquee');
  if (mq) { var copy = mq.firstElementChild.cloneNode(true); copy.setAttribute('aria-hidden', 'true'); mq.appendChild(copy); }

  // ---------------------------------------------------------------- mixer demo
  var mixer = document.getElementById('mixer');
  if (mixer && G) {
    var CAMS = [
      { name: 'Cam 1  Stage', ev: 'concert', a: 0 },
      { name: 'Cam 2  Crowd', ev: 'concert', a: 1 },
      { name: 'Cam 3  Pitch', ev: 'football', a: 0 },
      { name: 'Cam 4  Track', ev: 'school', a: 0 }
    ];
    var feedsBox = document.getElementById('feeds');
    var pgmBox = document.getElementById('pgm');
    var l3 = document.getElementById('l3');
    var l3a = document.getElementById('l3a');
    var l3b = document.getElementById('l3b');
    var takeBtn = document.getElementById('take');
    var tcEl = document.getElementById('tc');
    var viewersEl = document.getElementById('viewers');
    var sceneEl = function (i) {
      var d = document.createElement('div');
      d.className = 'scene';
      d.innerHTML = G.svg(G.EVENTS[CAMS[i].ev].angles[CAMS[i].a]);
      return d;
    };
    var feeds = [];
    var pgm = 0, pvw = 2;
    CAMS.forEach(function (c, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'feed';
      b.setAttribute('aria-label', 'Preview ' + c.name.replace(/\s+/g, ' '));
      b.appendChild(sceneEl(i));
      var n = document.createElement('span');
      n.className = 'feed-name';
      n.textContent = c.name.replace(/\s+/g, ' ');
      b.appendChild(n);
      b.addEventListener('click', function () { userAction(); setPvw(i); });
      feedsBox.appendChild(b);
      feeds.push(b);
    });
    var current = sceneEl(pgm);
    pgmBox.insertBefore(current, pgmBox.firstChild);
    function caption() { var cap = G.EVENTS[CAMS[pgm].ev].caption; l3a.textContent = cap[0]; l3b.textContent = cap[1]; }
    caption();
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
      setTimeout(function () { caption(); l3.classList.remove('out'); }, reduced ? 0 : 420);
      paint();
    }
    takeBtn.addEventListener('click', function () { userAction(); take(); });
    paint();
    var pausedUntil = 0;
    function userAction() { pausedUntil = Date.now() + 9000; }
    var mixVisible = whileVisible(mixer);
    var mixRunning = function () { return mixVisible() && Date.now() > pausedUntil; };
    if (!reduced) {
      setInterval(function () {
        if (!mixRunning()) return;
        setPvw((pgm + 1 + Math.floor(Math.random() * 3)) % 4);
        setTimeout(function () { if (mixRunning()) take(); }, 1300);
      }, 3600);
      var start = performance.now() - (42 * 60 + 10) * 1000;
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      setInterval(function () {
        if (!mixVisible()) return;
        var ms = performance.now() - start;
        var s = Math.floor(ms / 1000);
        tcEl.textContent = pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60) + ':' + pad(Math.floor((ms % 1000) / 40));
      }, 40);
      var viewers = 1284;
      setInterval(function () {
        if (!mixVisible()) return;
        viewers = Math.max(900, viewers + Math.round((Math.random() - 0.35) * 14));
        viewersEl.textContent = num(viewers);
      }, 2000);
    }
  }

  // ---------------------------------------------------------------- reveal on scroll
  var reveals = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window && !reduced) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        var sib = Array.prototype.indexOf.call(e.target.parentNode.children, e.target);
        e.target.style.transitionDelay = Math.min(sib, 6) * 70 + 'ms';
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { threshold: 0.12 });
    reveals.forEach(function (n) { io.observe(n); });
  } else reveals.forEach(function (n) { n.classList.add('in'); });

  // Steps: the connecting line fills as the section scrolls through the viewport.
  var steps = document.getElementById('steps');
  if (steps) {
    var items = steps.querySelectorAll('li');
    var onScroll = function () {
      var r = steps.getBoundingClientRect();
      var vh = window.innerHeight;
      var p = Math.min(1, Math.max(0, (vh * 0.8 - r.top) / (r.height + vh * 0.25)));
      if (reduced) p = 1;
      steps.style.setProperty('--p', p.toFixed(3));
      items.forEach(function (li, i) { li.classList.toggle('done', p >= i / (items.length - 1) - 0.02); });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // Feature cards: a soft red glow follows the pointer.
  document.querySelectorAll('.spec').forEach(function (c) {
    c.addEventListener('pointermove', function (e) {
      var r = c.getBoundingClientRect();
      c.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      c.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
  });

  // ---------------------------------------------------------------- prices
  var P = { freeCameras: 2, freeMinutes: 10, cameraPrice: 100, minutePrice: 5 };
  var inrPerCredit = 1;
  function oursCredits(cams, hours) {
    return Math.max(0, cams - P.freeCameras) * P.cameraPrice + Math.max(0, hours * 60 - P.freeMinutes) * P.minutePrice;
  }
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
      // The dearest rate per credit, so the website never understates the cost.
      inrPerCredit = Math.max.apply(null, packs.map(function (p) { return p.priceInr / p.credits; }));
    }
    var ex = document.getElementById('example');
    if (ex) {
      var c = oursCredits(4, 3);
      ex.textContent = 'Example: a 3-hour show with 4 cameras uses ' + num(c) + ' credits, about ' + inr(c * inrPerCredit) + '.';
    }
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
      var k = Math.min(1, (t - t0) / 500);
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
  var calcSeen = false;
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
    rows(document.getElementById('ours'), [
      ['Phones at the event', 'Yours'],
      ['First ' + P.freeCameras + ' cameras and ' + P.freeMinutes + ' minutes', 'Free'],
      [extraCams + ' extra camera' + (extraCams === 1 ? '' : 's'), inr(extraCams * P.cameraPrice * inrPerCredit)],
      [num(paidMin) + ' live minutes', inr(paidMin * P.minutePrice * inrPerCredit)],
      ['Cloud mixing, graphics, restreaming', 'Included']
    ]);
    var oursTotal = oursCredits(cams, hours) * inrPerCredit;
    if (!calcSeen) return; // totals count up the first time the calculator scrolls into view
    animateTo(document.getElementById('crew-total'), crewTotal);
    animateTo(document.getElementById('ours-total'), oursTotal);
    animateTo(document.getElementById('saving'), crewTotal - oursTotal);
    var pct = crewTotal > 0 ? Math.round((1 - oursTotal / crewTotal) * 100) : 0;
    document.getElementById('saving-pct').textContent = pct + '% less than hiring a crew for this event';
  }
  if (calc) {
    document.getElementById('cams').addEventListener('input', update);
    document.getElementById('hours').addEventListener('input', update);
    if ('IntersectionObserver' in window && !reduced) {
      var cio = new IntersectionObserver(function (es) {
        if (es[0].isIntersecting) { calcSeen = true; update(); cio.disconnect(); }
      }, { threshold: 0.3 });
      cio.observe(calc);
    } else calcSeen = true;
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
