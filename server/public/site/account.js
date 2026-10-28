// Account page: who is signed in, the organisation's credit balance, and buying a credit pack.
(function () {
  'use strict';
  var root = document.getElementById('account');
  if (!root) return;
  var token = null;
  try { token = localStorage.getItem('baas.token'); } catch (e) {}
  if (!token) { window.location.replace('/login'); return; }

  var $ = function (id) { return document.getElementById(id); };
  var num = function (n) { return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };
  var inr = function (n) { return '₹' + Number(n).toLocaleString('en-IN'); };
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function signOut() {
    try { localStorage.removeItem('baas.token'); localStorage.removeItem('baas.session'); } catch (e) {}
    window.location.href = '/';
  }
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: Object.assign({ authorization: 'Bearer ' + token }, body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (r.status === 401) { signOut(); throw new Error('Your session ended. Log in again.'); }
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error((d.error && d.error.message) || 'Something went wrong (' + r.status + ').');
        return d;
      });
    });
  }
  $('sign-out').addEventListener('click', signOut);

  if (/[?&]welcome=1/.test(location.search)) {
    var w = $('welcome');
    w.textContent = 'Your account is ready. Follow the steps below to get your first event on air.';
    w.classList.add('show');
    history.replaceState(null, '', '/account');
  }

  // App store links (shown only when configured on the server).
  var stores = $('stores');
  var play = root.getAttribute('data-play');
  var ios = root.getAttribute('data-ios');
  if (play) stores.appendChild(el('a', { class: 'btn btn-ghost', href: play, target: '_blank', rel: 'noopener', text: 'Get it on Google Play' }));
  if (ios) stores.appendChild(el('a', { class: 'btn btn-ghost', href: ios, target: '_blank', rel: 'noopener', text: 'Download on the App Store' }));
  if (!play && !ios) stores.appendChild(el('span', { class: 'notice' }, ['The app is in early access. Email ', el('a', { href: 'mailto:' + root.getAttribute('data-email') + '?subject=App%20download', text: root.getAttribute('data-email') }), ' for the download link.']));

  var orgs = [];
  var orgId = null;

  api('GET', '/api/me').then(function (me) {
    var p = me.principal || {};
    $('hello').textContent = 'Hi ' + (p.name || '').split(' ')[0];
    orgs = me.orgs || [];
    if (!orgs.length) {
      // New Google sign-ups have no organisation yet: ask for its name here (one field).
      $('org-line').textContent = p.email;
      var input = el('input', { id: 'new-org', type: 'text', maxlength: '100', placeholder: 'Your club, school, company or event brand', 'aria-label': 'Organisation name' });
      var btn = el('button', { class: 'btn btn-live', type: 'button', text: 'Create organisation' });
      var box = el('div', {}, [
        el('p', { text: 'Name your organisation. Viewers see it on the watch page, and credits belong to it.' }),
        el('div', { class: 'name-org' }, [input, btn])
      ]);
      $('credits-body').replaceChildren(box);
      btn.addEventListener('click', function () {
        var name = input.value.trim();
        if (name.length < 2) { input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
        btn.disabled = true;
        api('POST', '/api/orgs', { name: name }).then(function () { location.reload(); }).catch(function (e) {
          btn.disabled = false;
          box.appendChild(el('p', { class: 'notice', text: (e && e.message) || 'Could not create it. Try again.' }));
        });
      });
      input.focus();
      return;
    }
    var saved = null;
    try { saved = localStorage.getItem('baas.org'); } catch (e) {}
    orgId = (orgs.find(function (o) { return o.id === saved; }) || orgs[0]).id;
    if (orgs.length > 1) {
      var pick = $('org-pick');
      orgs.forEach(function (o) { pick.appendChild(el('option', { value: o.id, text: o.name })); });
      pick.value = orgId;
      pick.hidden = false;
      pick.addEventListener('change', function () {
        orgId = pick.value;
        try { localStorage.setItem('baas.org', orgId); } catch (e) {}
        showOrg(p);
      });
    }
    showOrg(p);
  }).catch(function (e) { $('org-line').textContent = e.message; });

  function showOrg(p) {
    var o = orgs.find(function (x) { return x.id === orgId; });
    $('org-line').textContent = o.name + ', signed in as ' + p.email + ' (' + o.role + ')';
    loadCredits();
  }

  function loadCredits() {
    var box = $('credits-body');
    box.replaceChildren(el('p', { class: 'notice', text: 'Loading your balance…' }));
    api('GET', '/api/orgs/' + orgId + '/billing').then(function (b) {
      var kids = [];
      if (!b.enabled) {
        box.replaceChildren(el('p', { class: 'notice', text: 'Events are free on this server right now. There is nothing to pay.' }));
        return;
      }
      kids.push(el('div', { class: 'balance' }, [num(b.balance), el('small', { text: 'credits' })]));
      kids.push(el('p', { style: 'color:var(--muted);margin-bottom:18px', text: 'Every event includes ' + b.pricing.freeCameras + ' cameras and ' + b.pricing.freeMinutes + ' live minutes free; then ' + num(b.pricing.cameraPrice) + ' credits per extra camera and ' + num(b.pricing.minutePrice) + ' per live minute.' }));
      if (b.suspended) {
        kids.push(el('p', { class: 'notice', text: 'This organisation is paused' + (b.suspendedReason ? ': ' + b.suspendedReason : '.') + ' Contact us to resume.' }));
      } else if (!b.paymentsEnabled) {
        kids.push(el('p', { class: 'notice' }, ['Online payment is not switched on yet. Email ', el('a', { href: 'mailto:' + root.getAttribute('data-email') + '?subject=Add%20credits', text: root.getAttribute('data-email') }), ' to add credits.']));
      } else {
        kids.push(buyForm(b));
      }
      if (b.transactions && b.transactions.length) {
        var kindText = { purchase: 'Bought credits', cameras: 'Extra cameras', minutes: 'Live minutes', admin: 'Adjustment', refund: 'Refund' };
        var list = el('dl', { style: 'display:grid;grid-template-columns:1fr auto;gap:6px 16px;margin:8px 0 0;font-size:15px' });
        b.transactions.slice(0, 6).forEach(function (t) {
          list.appendChild(el('dt', { style: 'color:var(--muted)', text: (kindText[t.kind] || t.kind) + (t.tournamentName ? ', ' + t.tournamentName : '') }));
          list.appendChild(el('dd', { style: 'margin:0;text-align:right;font-variant-numeric:tabular-nums;font-weight:600', text: (t.credits > 0 ? '+' : '') + num(t.credits) }));
        });
        kids.push(el('h3', { style: 'margin-top:26px', text: 'Recent activity' }), list);
      }
      box.replaceChildren.apply(box, kids);
    }).catch(function (e) {
      box.replaceChildren(el('p', { class: 'notice', text: /cannot do this|not allowed|forbidden/i.test(e.message) ? 'Only the organisation owner and admins can see credits.' : e.message }));
    });
  }

  function buyForm(b) {
    var form = el('form', { novalidate: '' });
    var err = el('div', { class: 'form-error', role: 'alert' });
    form.appendChild(el('h3', { text: 'Buy credits' }));
    form.appendChild(err);
    var pickBox = el('div', { class: 'pack-pick', role: 'radiogroup', 'aria-label': 'Credit pack' });
    b.packs.forEach(function (p, i) {
      var input = el('input', { type: 'radio', name: 'pack', value: p.id });
      if (i === 0) input.checked = true;
      pickBox.appendChild(el('label', {}, [
        el('span', { class: 'name' }, [input, p.label + ', ' + num(p.credits) + ' credits']),
        el('span', { class: 'price', text: inr(p.priceInr) })
      ]));
    });
    form.appendChild(pickBox);
    var phone = el('input', { id: 'phone', type: 'tel', autocomplete: 'tel', inputmode: 'tel', placeholder: '98765 43210' });
    if (b.details && b.details.phone) phone.value = b.details.phone;
    form.appendChild(el('div', { class: 'field' }, [
      el('label', { for: 'phone', text: 'Mobile number for the receipt' }), phone
    ]));
    var btn = el('button', { class: 'btn btn-live', type: 'submit', style: 'width:100%' }, [el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', { text: 'Continue to payment' })]);
    form.appendChild(btn);
    form.appendChild(el('p', { style: 'font-size:14px;color:var(--muted);margin-top:10px', text: 'You pay on Cashfree\'s secure page by UPI, card or net banking. Credits are added as soon as the payment is confirmed.' }));
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var packId = (form.querySelector('input[name=pack]:checked') || {}).value;
      var mobile = phone.value.replace(/[\s-]/g, '');
      if (!/^(\+91)?[6-9]\d{9}$/.test(mobile) && !/^\+\d{8,15}$/.test(mobile)) {
        err.textContent = 'Enter a 10-digit mobile number.';
        err.classList.add('show');
        phone.setAttribute('aria-invalid', 'true');
        phone.focus();
        return;
      }
      btn.disabled = true;
      btn.lastChild.textContent = 'Opening payment…';
      api('POST', '/api/orgs/' + orgId + '/billing/checkout', { packId: packId, phone: mobile }).then(function (r) {
        window.location.href = r.checkoutUrl;
      }).catch(function (e2) {
        btn.disabled = false;
        btn.lastChild.textContent = 'Continue to payment';
        err.textContent = e2.message;
        err.classList.add('show');
      });
    });
    return form;
  }
})();
