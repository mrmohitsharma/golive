// Sign-up and log-in forms. The session token is kept in this browser only (localStorage),
// the same token the app uses; it lets the account page show credits and buy more.
(function () {
  'use strict';
  var form = document.getElementById('auth-form');
  if (!form) return;
  var mode = form.getAttribute('data-mode');
  var errBox = document.getElementById('form-error');
  var submit = document.getElementById('submit');
  var side = document.getElementById('auth-side');
  var lamp = document.getElementById('lamp-text');

  document.querySelectorAll('[data-toggle-pw]').forEach(function (b) {
    b.addEventListener('click', function () {
      var input = document.getElementById(b.getAttribute('aria-controls'));
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.textContent = show ? 'Hide' : 'Show';
    });
  });

  if (mode === 'signup' && form.getAttribute('data-signup') === 'false') {
    showError('New sign-ups are closed right now. If you were invited, log in with the email your organiser added.');
    Array.prototype.forEach.call(form.elements, function (el) { el.disabled = true; });
    return;
  }

  // The tally lamp turns red when the form is ready to go live.
  function armed() {
    var ok = Array.prototype.every.call(form.querySelectorAll('input[required]'), function (i) {
      return i.type === 'checkbox' ? i.checked : i.value.trim().length > 0;
    });
    if (side) side.classList.toggle('armed', ok);
    if (lamp) lamp.textContent = ok ? 'Ready' : 'Standing by';
  }
  form.addEventListener('input', armed);
  form.addEventListener('change', armed);

  function showError(msg) {
    errBox.textContent = msg;
    errBox.classList.remove('show');
    void errBox.offsetWidth;
    errBox.classList.add('show');
  }
  function invalid(id, msg) {
    var el = document.getElementById(id);
    el.setAttribute('aria-invalid', 'true');
    el.focus();
    showError(msg);
    return false;
  }
  function validate() {
    form.querySelectorAll('[aria-invalid]').forEach(function (n) { n.removeAttribute('aria-invalid'); });
    var v = function (id) { return document.getElementById(id).value.trim(); };
    if (mode === 'signup') {
      if (!v('name')) return invalid('name', 'Enter your name.');
      if (v('orgName').length < 2) return invalid('orgName', 'Enter your organisation name (at least 2 characters).');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('email'))) return invalid('email', 'Enter a valid email address, like you@example.com.');
    var pw = document.getElementById('password').value;
    if (mode === 'signup' && pw.length < 8) return invalid('password', 'Use a password of at least 8 characters.');
    if (mode === 'login' && !pw) return invalid('password', 'Enter your password.');
    if (mode === 'signup' && !document.getElementById('agree').checked) return invalid('agree', 'Tick the box to accept the Terms of service and Privacy policy.');
    return true;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!validate()) return;
    errBox.classList.remove('show');
    var body = { email: document.getElementById('email').value.trim(), password: document.getElementById('password').value };
    if (mode === 'signup') {
      body.name = document.getElementById('name').value.trim();
      body.orgName = document.getElementById('orgName').value.trim();
    }
    var label = submit.querySelector('span:last-child');
    var old = label.textContent;
    submit.disabled = true;
    label.textContent = mode === 'signup' ? 'Creating account…' : 'Logging in…';
    fetch(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d.token) {
          var msg = (res.d.error && res.d.error.message) || 'Something went wrong. Try again in a minute.';
          throw new Error(msg);
        }
        try {
          localStorage.setItem('baas.token', res.d.token);
          localStorage.setItem('baas.session', JSON.stringify({ user: res.d.user, orgs: res.d.orgs }));
        } catch (err) {}
        window.location.href = '/account' + (mode === 'signup' ? '?welcome=1' : '');
      })
      .catch(function (err) {
        submit.disabled = false;
        label.textContent = old;
        showError(err.message || 'Could not reach the server. Check your connection and try again.');
      });
  });
  armed();

  // Sign in with Google: shown only when the server has a Google client ID (GET /api/auth/config).
  var row = document.getElementById('google-row');
  function finish(d, created) {
    try {
      localStorage.setItem('baas.token', d.token);
      localStorage.setItem('baas.session', JSON.stringify({ user: d.user, orgs: d.orgs }));
    } catch (err) {}
    window.location.href = '/account' + (created || !(d.orgs || []).length ? '?welcome=1' : '');
  }
  function onGoogle(resp) {
    errBox.classList.remove('show');
    fetch('/api/auth/google', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: resp.credential }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d.token) throw new Error((res.d.error && res.d.error.message) || 'Google sign-in did not work. Try again.');
        finish(res.d, res.d.newUser);
      })
      .catch(function (err) { showError(err.message || 'Could not reach the server. Try again.'); });
  }
  if (row && !(mode === 'signup' && form.getAttribute('data-signup') === 'false')) {
    fetch('/api/auth/config').then(function (r) { return r.json(); }).then(function (c) {
      if (!c.google || !c.google.clientId) return;
      var s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = function () {
        if (!window.google || !google.accounts || !google.accounts.id) return;
        google.accounts.id.initialize({ client_id: c.google.clientId, callback: onGoogle, ux_mode: 'popup', context: mode === 'signup' ? 'signup' : 'signin' });
        var w = Math.min(400, document.getElementById('google-btn').parentNode.clientWidth || 360);
        google.accounts.id.renderButton(document.getElementById('google-btn'), {
          type: 'standard', theme: 'outline', size: 'large', shape: 'rectangular', width: w,
          text: mode === 'signup' ? 'signup_with' : 'continue_with'
        });
        row.hidden = false;
      };
      document.head.appendChild(s);
    }).catch(function () {});
  }
})();
