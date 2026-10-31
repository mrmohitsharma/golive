/*
 * Go Live player: plays our HLS stream (live or replay) with hls.js, or natively on iPhone.
 * Used by /watch and /embed. GoLivePlayer.mount(box, { src, live, title }) returns
 * { isPlaying(), isUnmuted(), destroy() }; onPlaying(bool) is called when playback starts/stops.
 *
 * To keep CDN costs down it only downloads video someone is watching: it stops loading when
 * the tab has been hidden for 30 s (not in picture-in-picture), asks "Still watching?" after
 * opts.idleMinutes (40) without a tap or key, and on mobile data or Data Saver starts and stays
 * at 480p unless the viewer picks a higher quality. Players are capped to their on-screen size.
 */
(function () {
  var CSS = [
    '.glp{position:absolute;inset:0;background:#000;overflow:hidden;font:14px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#fff}',
    '.glp video{position:absolute;inset:0;width:100%;height:100%;background:#000}',
    '.glp-top{position:absolute;top:10px;left:10px;right:10px;display:flex;gap:8px;align-items:center;pointer-events:none}',
    '.glp-top>*{pointer-events:auto}',
    '.glp-live{display:inline-flex;align-items:center;gap:6px;border:0;border-radius:6px;padding:4px 9px;font:800 12px/1 system-ui,sans-serif;letter-spacing:.05em;color:#fff;background:#e53935;cursor:pointer}',
    '.glp-live::before{content:"";width:7px;height:7px;border-radius:50%;background:#fff}',
    '.glp-live.behind{background:rgba(0,0,0,.6)}',
    '.glp-live.behind::before{background:#bbb}',
    '.glp-q{margin-left:auto;background:rgba(0,0,0,.6);color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:6px;padding:3px 6px;font-size:12px}',
    '.glp-sound{position:absolute;left:50%;bottom:64px;transform:translateX(-50%);border:0;border-radius:999px;padding:9px 16px;font-weight:700;background:rgba(255,255,255,.92);color:#111;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4)}',
    '.glp-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;background:rgba(0,0,0,.55);font-weight:600}',
    '.glp-play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:76px;height:76px;border-radius:50%;border:0;background:rgba(229,57,53,.95);cursor:pointer}',
    '.glp-idle{position:absolute;inset:0;display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;text-align:center;padding:20px;background:rgba(0,0,0,.72);font-weight:700;font-size:17px}',
    '.glp-idle button{border:0;border-radius:999px;padding:10px 20px;font:700 15px/1 system-ui,sans-serif;background:#e53935;color:#fff;cursor:pointer}',
    '.glp-play::after{content:"";position:absolute;left:31px;top:24px;border-left:22px solid #fff;border-top:14px solid transparent;border-bottom:14px solid transparent}',
  ].join('');

  function h(tag, attrs) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    return e;
  }

  function mount(box, opts) {
    if (!document.getElementById('glp-css')) {
      var st = h('style', { id: 'glp-css' });
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var root = h('div', { class: 'glp' });
    var video = h('video', { playsinline: '', 'webkit-playsinline': '', muted: '', autoplay: '', controls: '', title: opts.title || '' });
    video.muted = true;
    var top = h('div', { class: 'glp-top' });
    var liveBtn = opts.live ? h('button', { class: 'glp-live', type: 'button', text: 'LIVE', title: 'Go to live' }) : null;
    var quality = h('select', { class: 'glp-q', 'aria-label': 'Quality', hidden: '' });
    var sound = h('button', { class: 'glp-sound', type: 'button', text: '🔊 Tap for sound' });
    var msg = null;
    if (liveBtn) top.appendChild(liveBtn);
    top.appendChild(quality);
    root.append(video, top, sound);
    box.replaceChildren(root);

    var hls = null, dead = false, playing = false, retry = null;
    // Mobile data or Data Saver (Android Chrome reports it; iPhone Safari picks its own quality).
    var conn = navigator.connection || {};
    var saver = Boolean(conn.saveData || conn.type === 'cellular' || /^(slow-2g|2g|3g)$/.test(conn.effectiveType || ''));
    var capIndex = -1;
    var say = function (text) {
      if (msg) msg.remove();
      msg = null;
      if (text) { msg = h('div', { class: 'glp-msg', text: text }); root.appendChild(msg); }
    };
    var setPlaying = function (v) {
      if (v === playing) return;
      playing = v;
      if (opts.onPlaying) opts.onPlaying(v);
    };
    var showSound = function () { sound.hidden = !(video.muted || video.volume === 0); };
    sound.onclick = function () { video.muted = false; if (video.volume === 0) video.volume = 1; video.play().catch(function () {}); showSound(); };
    video.addEventListener('volumechange', showSound);
    video.addEventListener('playing', function () { say(null); setPlaying(true); });
    video.addEventListener('pause', function () { setPlaying(false); });
    video.addEventListener('ended', function () { setPlaying(false); });
    video.addEventListener('waiting', function () { setPlaying(false); });

    var start = function () {
      var p = video.play();
      if (p && p.catch) p.catch(function () {
        // Autoplay refused even muted (data saver, low power): a big play button.
        var b = h('button', { class: 'glp-play', type: 'button', 'aria-label': 'Play' });
        b.onclick = function () { b.remove(); video.play().catch(function () {}); };
        root.appendChild(b);
      });
    };

    var liveEdge = function () {
      if (hls && hls.liveSyncPosition) return hls.liveSyncPosition;
      var s = video.seekable;
      return s && s.length ? s.end(s.length - 1) - 6 : null;
    };
    if (liveBtn) {
      liveBtn.onclick = function () { var e = liveEdge(); if (e) video.currentTime = e; video.play().catch(function () {}); };
      video.addEventListener('timeupdate', function () {
        var e = liveEdge();
        liveBtn.classList.toggle('behind', e != null && e - video.currentTime > 15);
      });
    }

    // ---- only download what someone watches
    var sleeping = null; // 'hidden' | 'idle' | null
    var idleBox = null;
    var sleep = function (why) {
      if (dead || sleeping) return;
      sleeping = why;
      if (hls) hls.stopLoad();
      video.pause();
    };
    var wake = function () {
      if (dead || !sleeping) return;
      sleeping = null;
      if (idleBox) { idleBox.remove(); idleBox = null; }
      if (hls) hls.startLoad(opts.live ? -1 : video.currentTime);
      if (opts.live) { var e = liveEdge(); if (e) video.currentTime = e; }
      video.play().catch(function () {});
    };
    var hiddenTimer = null;
    var onVisibility = function () {
      clearTimeout(hiddenTimer);
      if (document.hidden) {
        hiddenTimer = setTimeout(function () {
          if (document.hidden && document.pictureInPictureElement !== video) sleep('hidden');
        }, (opts.hiddenSec || 30) * 1000);
      } else if (sleeping === 'hidden') wake();
    };
    document.addEventListener('visibilitychange', onVisibility);
    var lastTouch = Date.now();
    var touched = function () { lastTouch = Date.now(); };
    ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(function (ev) { document.addEventListener(ev, touched, { passive: true }); });
    var idleMs = (opts.idleMinutes || 40) * 60000;
    var idleTimer = setInterval(function () {
      if (dead || sleeping || video.paused || Date.now() - lastTouch < idleMs) return;
      sleep('idle');
      idleBox = h('div', { class: 'glp-idle' });
      var go = h('button', { type: 'button', text: 'Keep watching' });
      go.onclick = function () { touched(); wake(); };
      idleBox.append(h('div', { text: 'Still watching?' }), go);
      root.appendChild(idleBox);
    }, Math.min(15000, idleMs / 2));

    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({
        capLevelToPlayerSize: true,
        // Size by CSS pixels: a phone-sized player gets 480p, full screen on a laptop gets 720p.
        ignoreDevicePixelRatio: true,
        maxBufferLength: 20,
        liveSyncDurationCount: 3,
        manifestLoadingMaxRetry: 20,
        manifestLoadingRetryDelay: 2000,
        levelLoadingMaxRetry: 20,
        fragLoadingMaxRetry: 10,
      });
      hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
        var lv = hls.levels;
        if (saver) {
          lv.forEach(function (l, i) { if (l.height && l.height <= 480) capIndex = i; });
          if (capIndex >= 0) { hls.autoLevelCapping = capIndex; hls.startLevel = capIndex; hls.nextLevel = capIndex; }
        }
        if (lv.length > 1) {
          quality.replaceChildren(h('option', { value: '-1', text: capIndex >= 0 ? 'Auto (data saver)' : 'Auto' }));
          lv.map(function (l, i) { return [l, i]; }).reverse().forEach(function (x) { quality.appendChild(h('option', { value: String(x[1]), text: (x[0].height || '?') + 'p' })); });
          quality.hidden = false;
          quality.onchange = function () {
            var v = Number(quality.value);
            // Picking a quality lifts the data-saver cap; Auto puts it back.
            hls.autoLevelCapping = v === -1 ? capIndex : -1;
            hls.currentLevel = v;
          };
        }
        start();
      });
      hls.on(window.Hls.Events.ERROR, function (_e, d) {
        if (!d.fatal || dead) return;
        if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
        setPlaying(false);
        say(opts.live ? 'Reconnecting…' : 'Could not load the video. Retrying…');
        clearTimeout(retry);
        retry = setTimeout(function () { if (!dead) { hls.loadSource(opts.src); hls.startLoad(); } }, 3000);
      });
      hls.loadSource(opts.src);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = opts.src;
      video.addEventListener('loadedmetadata', start);
      video.addEventListener('error', function () {
        setPlaying(false);
        say(opts.live ? 'Reconnecting…' : 'Could not load the video.');
        clearTimeout(retry);
        retry = setTimeout(function () { if (!dead) { video.src = opts.src; video.load(); } }, 3000);
      });
    } else {
      say('This browser cannot play the video. Try Chrome or Safari.');
    }
    showSound();

    return {
      video: video,
      isPlaying: function () { return playing && !video.paused; },
      isUnmuted: function () { return !video.muted && video.volume > 0; },
      dataSaver: function () { return capIndex >= 0; },
      isSleeping: function () { return sleeping; },
      destroy: function () {
        dead = true;
        clearTimeout(retry);
        clearTimeout(hiddenTimer);
        clearInterval(idleTimer);
        document.removeEventListener('visibilitychange', onVisibility);
        ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(function (ev) { document.removeEventListener(ev, touched); });
        if (hls) hls.destroy();
        video.removeAttribute('src');
        try { video.load(); } catch (e) {}
        setPlaying(false);
      },
    };
  }

  window.GoLivePlayer = { mount: mount };
})();
