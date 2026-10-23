/* Pedido por WhatsApp + SINPE Móvil: retiro en el Mercado Central o envío por Uber Flash con ubicación en el mapa */
(function () {
  'use strict';
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var M = $('[data-order]');
  if (!M) return;
  var D = M.dataset;
  var fmt = new Intl.NumberFormat('es-CR', { style: 'currency', currency: D.currency || 'CRC', maximumFractionDigits: 0 });
  function money(c) { return fmt.format(c / 100); }
  var LS = 'tramo.order.me';
  var cart = null, mode = null, map = null, pin = null, loc = null, last = null, page = 2, FIRST = 2, PAGES = 4;

  /* ---------- abrir / cerrar ---------- */
  function open() {
    var dr = document.querySelector('.drawer.is-open'); if (dr) { var c = dr.querySelector('[data-drawer-close]'); if (c) c.click(); }
    show('form'); go(FIRST);
    M.hidden = false;
    document.body.classList.add('is-locked', 'is-ord');
    requestAnimationFrame(function () { M.classList.add('is-open'); });
    try { var me = JSON.parse(localStorage.getItem(LS) || '{}'); if (me.n && !$('[data-order-name]', M).value) $('[data-order-name]', M).value = me.n; if (me.p && !$('[data-order-phone]', M).value) $('[data-order-phone]', M).value = me.p; } catch (e) {}
    $('[data-order-lines]', M).innerHTML = '<li class="ord-lines__load">Cargando tu carrito…</li>';
    fetch('/cart.js', { headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); }).then(function (c) {
      cart = c;
      if (!c.item_count) { close(); return; }
      renderCart(); go(page);
    }).catch(function () { $('[data-order-lines]', M).innerHTML = '<li class="ord-lines__load">No se pudo cargar el carrito. Intenta de nuevo.</li>'; });
  }
  function close() {
    M.classList.remove('is-open');
    document.body.classList.remove('is-ord');
    if (!document.querySelector('.drawer.is-open') && !document.body.classList.contains('is-bmodal')) document.body.classList.remove('is-locked');
    setTimeout(function () { M.hidden = true; }, 260);
  }
  function show(step) {
    $$('[data-order-step]', M).forEach(function (s) { s.hidden = s.getAttribute('data-order-step') !== step; });
    $('[data-order-foot]', M).hidden = step !== 'form';
    $('[data-order-title]', M).textContent = step === 'done' ? 'Último paso' : 'Finalizar pedido';
    $('[data-order-prog]', M).hidden = step !== 'form';
    $('[data-order-body]', M).scrollTop = 0;
  }

  /* ---------- pasos ---------- */
  var TITLES = ['', 'Tu pedido', 'Tus datos', 'Entrega', 'Factura y envío'];
  function go(n) {
    page = Math.max(FIRST, Math.min(PAGES, n));
    $$('[data-order-page]', M).forEach(function (p) { var on = +p.getAttribute('data-order-page') === page; p.hidden = !on; if (on) { p.classList.remove('is-in'); void p.offsetWidth; p.classList.add('is-in'); } });
    $$('[data-order-dot]', M).forEach(function (d) { var k = +d.getAttribute('data-order-dot'); d.classList.toggle('is-done', k < page); d.classList.toggle('is-on', k === page); });
    $('[data-order-prog-fill]', M).style.width = ((page - FIRST) / (PAGES - FIRST) * 100) + '%';
    $('[data-order-prev]', M).hidden = page === FIRST;
    $('[data-order-next]', M).hidden = page === PAGES;
    $('[data-order-send]', M).hidden = page !== PAGES;
    $('[data-order-next-label]', M).textContent = 'Continuar';
    $('[data-order-body]', M).scrollTop = 0;
    if (page === 3 && mode === 'delivery') initMap();
    if (page === 4) renderReview();
    if (page === 2) setTimeout(function () { var n = $('[data-order-name]', M); if (!n.value) n.focus(); }, 320);
    validate();
  }
  function pageOk(n) {
    if (n === 1) return !!(cart && cart.item_count);
    if (n === 2) return $('[data-order-name]', M).value.trim().length > 1 && digits($('[data-order-phone]', M).value).length >= 8;
    if (n === 3) return !!mode && (mode === 'pickup' || !!loc);
    if (n === 4) return !wantsFE() || ($('[data-order-fe-id]', M).value.replace(/\D/g, '').length >= 9 && $('[data-order-fe-name]', M).value.trim().length > 1 && /.+@.+\..+/.test($('[data-order-fe-mail]', M).value.trim()));
    return true;
  }
  function renderReview() {
    var r = $('[data-order-review]', M); if (!r || !cart) return;
    var ent = mode === 'pickup' ? 'Recoger en el Mercado Central' : mode === 'delivery' ? (D.delivery || 'Envío por Uber Flash') : '—';
    r.innerHTML = '<h3 class="ord-h">Resumen</h3><dl class="ord-rev">' +
      '<div><dt>A nombre de</dt><dd>' + esc($('[data-order-name]', M).value.trim()) + ' · ' + esc($('[data-order-phone]', M).value.trim()) + '</dd></div>' +
      '<div><dt>Entrega</dt><dd>' + esc(ent) + (mode === 'delivery' ? ' <small>(envío se cotiza)</small>' : '') + '</dd></div></dl>';
  }

  function variantLabel(it) {
    var v = it.variant_title; return v && v !== 'Default Title' ? v : '';
  }
  function renderCart() {
    $('[data-order-lines]', M).innerHTML = cart.items.map(function (it) {
      var img = it.image ? it.image.replace(/(\.[a-z]+)(\?|$)/i, '_120x$1$2') : '';
      return '<li><span class="ord-lines__img">' + (img ? '<img src="' + esc(img) + '" alt="" loading="lazy">' : '') + '<i>' + it.quantity + '</i></span>' +
        '<span class="ord-lines__name"><b>' + esc(it.product_title) + '</b>' + (variantLabel(it) ? '<small>' + esc(variantLabel(it)) + '</small>' : '') + '</span>' +
        '<span class="ord-lines__price">' + money(it.final_line_price) + '</span></li>';
    }).join('');
    var t = money(cart.total_price);
    $('[data-order-subtotal]', M).textContent = t;
  }

  /* ---------- modo de entrega ---------- */
  function setMode(m) {
    mode = m;
    $$('[data-order-pane]', M).forEach(function (p) { p.hidden = p.getAttribute('data-order-pane') !== m; });
    $('[data-order-send-label]', M).textContent = m === 'delivery' ? 'Enviar pedido y ubicación' : 'Enviar pedido por WhatsApp';
    var pt = $('[data-order-paytext]', M);
    if (pt) pt.innerHTML = m === 'pickup'
      ? 'Pagas por <b>SINPE Móvil</b> antes de retirar' + (D.sinpe ? ': <b>' + esc(D.sinpe) + '</b>' + (D.sinpeName ? ' a nombre de ' + esc(D.sinpeName) : '') : '') + '. Envíanos el comprobante por WhatsApp.'
      : 'Pagas por <b>SINPE Móvil</b> antes del envío. Te pasamos los datos, el costo del Uber Flash y el total por WhatsApp.';
    if (m === 'delivery') { initMap(); if (!gotAuto && !loc) { gotAuto = true; locate($('[data-order-locate]', M), true); } }
    validate();
  }

  /* ---------- mapa (OpenStreetMap + Leaflet, sin llave) ---------- */
  var leafletP = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletP) return leafletP;
    leafletP = new Promise(function (res, rej) {
      var css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(css);
      var js = document.createElement('script'); js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'; js.onload = res; js.onerror = rej; document.head.appendChild(js);
    });
    return leafletP;
  }
  function initMap() {
    if (map) { setTimeout(function () { map.invalidateSize(); }, 60); return; }
    var el = $('[data-order-map]', M);
    el.classList.add('is-loading');
    loadLeaflet().then(function () {
      el.classList.remove('is-loading');
      var c = [parseFloat(D.lat) || 9.9349, parseFloat(D.lng) || -84.0789];
      map = L.map(el, { zoomControl: true, attributionControl: true }).setView(c, 13);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
      map.on('click', function (e) { place(e.latlng.lat, e.latlng.lng); });
      if (loc) { place(loc.lat, loc.lng, acc && acc < 60 ? 18 : 17, acc ? 'gps' : null); showAcc(loc.lat, loc.lng); }
      setTimeout(function () { map.invalidateSize(); }, 80);
    }).catch(function () {
      el.classList.remove('is-loading');
      el.innerHTML = '<p class="ord-map__fail">No se pudo cargar el mapa. Usa "Usar mi ubicación" o escribe tu dirección en las señas.</p>';
    });
  }
  var pinIcon = null;
  function place(lat, lng, zoom, src) {
    loc = { lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
    if (src !== 'gps' && accCircle) { map.removeLayer(accCircle); accCircle = null; acc = null; }
    if (window.L && map) {
      if (!pinIcon) pinIcon = L.divIcon({ className: 'ord-pin', html: '<span></span>', iconSize: [34, 44], iconAnchor: [17, 42] });
      if (!pin) {
        pin = L.marker([lat, lng], { draggable: true, icon: pinIcon }).addTo(map);
        pin.on('dragend', function () { var p = pin.getLatLng(); loc = { lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) }; if (accCircle) { map.removeLayer(accCircle); accCircle = null; } hint('moved'); validate(); });
      } else pin.setLatLng([lat, lng]);
      map.setView([lat, lng], zoom || Math.max(map.getZoom(), 16));
    }
    hint(src); validate();
  }
  var acc = null, accCircle = null, gotAuto = false;
  function hint(state) {
    var h = $('[data-order-maphint]', M);
    h.classList.toggle('is-ok', !!loc && state !== 'busy');
    h.classList.toggle('is-busy', state === 'busy');
    if (state === 'busy') { h.textContent = 'Buscando tu ubicación exacta…'; return; }
    if (!loc) { h.textContent = 'Toca el mapa o arrastra el pin hasta tu casa.'; return; }
    h.textContent = acc && state === 'gps'
      ? '✓ Te ubicamos con una precisión de ±' + Math.round(acc) + ' m. Si el pin no está justo en tu casa, arrástralo.'
      : '✓ Ubicación marcada. Si no está justo en tu casa, arrastra el pin.';
  }
  function showAcc(lat, lng) {
    if (!(window.L && map) || !acc) return;
    if (accCircle) accCircle.setLatLng([lat, lng]).setRadius(acc);
    else accCircle = L.circle([lat, lng], { radius: acc, color: '#2f7fd8', weight: 1, fillColor: '#2f7fd8', fillOpacity: .12, interactive: false }).addTo(map);
  }
  /* GPS como Uber: se queda escuchando unos segundos y se queda con la lectura más precisa */
  function locate(btn, auto) {
    if (!navigator.geolocation) { if (!auto) err('Tu navegador no permite compartir la ubicación. Márcala en el mapa.'); return; }
    if (btn) btn.classList.add('is-busy');
    hint('busy');
    var best = null, done = false, wid = null;
    function finish() {
      if (done) return; done = true;
      if (wid != null) navigator.geolocation.clearWatch(wid);
      if (btn) btn.classList.remove('is-busy');
      if (!best) { hint(); if (!auto) err('No pudimos obtener tu ubicación. Revisa el permiso de ubicación del navegador o márcala en el mapa.'); return; }
      acc = best.coords.accuracy;
      place(best.coords.latitude, best.coords.longitude, acc < 60 ? 18 : 17, 'gps');
      showAcc(best.coords.latitude, best.coords.longitude);
    }
    wid = navigator.geolocation.watchPosition(function (p) {
      if (!best || p.coords.accuracy < best.coords.accuracy) {
        best = p; acc = p.coords.accuracy;
        place(p.coords.latitude, p.coords.longitude, acc < 60 ? 18 : 17, 'gps');
        showAcc(p.coords.latitude, p.coords.longitude);
        hint('busy');
      }
      if (p.coords.accuracy <= 20) finish();
    }, function (e) {
      if (e && e.code === 1) { best = null; finish(); }
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    setTimeout(finish, 9000);
  }
  function find(q) {
    q = (q || '').trim(); if (!q) return;
    var b = $('[data-order-find] button', M); b.disabled = true; b.textContent = '…';
    fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=cr&accept-language=es&q=' + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (a) {
        if (!a || !a[0]) { err('No encontramos esa dirección. Prueba con un lugar conocido cercano o marca en el mapa.'); return; }
        place(parseFloat(a[0].lat), parseFloat(a[0].lon), 16);
      })
      .catch(function () { err('No se pudo buscar. Marca tu ubicación en el mapa.'); })
      .then(function () { b.disabled = false; b.textContent = 'Buscar'; });
  }

  /* ---------- validar y enviar ---------- */
  function err(msg) { var e = $('[data-order-err]', M); e.textContent = msg; e.hidden = !msg; if (msg) setTimeout(function () { e.hidden = true; }, 5000); }
  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function validate() {
    var okPage = pageOk(page);
    $('[data-order-next]', M).disabled = !okPage;
    var all = pageOk(1) && pageOk(2) && pageOk(3) && pageOk(4);
    $('[data-order-send]', M).disabled = !all;
    return all;
  }
  function wantsFE() { var r = $('[data-order-fe]:checked', M); return !!(r && r.value === 'si'); }
  function code() {
    var A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '', r = new Uint8Array(4);
    (window.crypto || window.msCrypto).getRandomValues(r);
    for (var i = 0; i < 4; i++) s += A[r[i] % 32];
    return (D.prefix || 'PED') + '-' + s;
  }
  function message(c) {
    var name = $('[data-order-name]', M).value.trim(), phone = $('[data-order-phone]', M).value.trim();
    var L1 = ['*Pedido ' + c + '* · ' + (D.shop || ''), '', '*Nombre:* ' + name, '*Teléfono:* ' + phone, ''];
    cart.items.forEach(function (it) {
      L1.push('• ' + it.quantity + ' × ' + it.product_title + (variantLabel(it) ? ' (' + variantLabel(it) + ')' : '') + ' — ' + money(it.final_line_price));
    });
    L1.push('', '*Subtotal:* ' + money(cart.total_price), '');
    if (mode === 'pickup') {
      L1.push('*Entrega:* Recoger en ' + (D.pickup || 'el Mercado Central'));
    } else {
      var n = $('[data-order-notes]', M).value.trim();
      L1.push('*Entrega:* ' + (D.delivery || 'Uber Flash'));
      L1.push('*Ubicación:* https://maps.google.com/?q=' + loc.lat + ',' + loc.lng);
      if (n) L1.push('*Señas:* ' + n);
    }
    L1.push('');
    if (wantsFE()) {
      L1.push('*Factura electrónica:* Sí');
      L1.push('Cédula ' + $('[data-order-fe-type]', M).value + ': ' + $('[data-order-fe-id]', M).value.trim());
      L1.push('Nombre: ' + $('[data-order-fe-name]', M).value.trim());
      L1.push('Correo: ' + $('[data-order-fe-mail]', M).value.trim());
    } else {
      L1.push('*Factura electrónica:* No');
    }
    if (mode === 'pickup') L1.push('', '*Pago:* SINPE Móvil' + (D.sinpe ? ' al ' + D.sinpe + (D.sinpeName ? ' (' + D.sinpeName + ')' : '') : '') + ' por ' + money(cart.total_price) + '. Te envío el comprobante.');
    else L1.push('', '*Pago:* SINPE Móvil. Quedo atento a los datos, el costo del envío y el total.');
    return L1.join('\n');
  }
  function send() {
    if (!validate()) return;
    if (!D.wa) { err('Falta configurar el WhatsApp de la tienda.'); return; }
    var c = code(), url = 'https://wa.me/' + D.wa + '?text=' + encodeURIComponent(message(c));
    try { localStorage.setItem(LS, JSON.stringify({ n: $('[data-order-name]', M).value.trim(), p: $('[data-order-phone]', M).value.trim() })); } catch (e) {}
    last = { code: c, url: url, mode: mode };
    var w = null; try { w = window.open(url, '_blank'); if (w) w.opener = null; } catch (e) {}
    if (!w) setTimeout(function () { location.href = url; }, 900);
    $('[data-order-code]', M).textContent = c;
    $('[data-order-done-text]', M).textContent = mode === 'pickup'
      ? 'Solo falta tocar Enviar en WhatsApp. Deposita ' + money(cart.total_price) + (D.sinpe ? ' al SINPE ' + D.sinpe + (D.sinpeName ? ' a nombre de ' + D.sinpeName : '') : '') + ' y envíanos el comprobante. Te mandamos la ubicación exacta del local y te avisamos cuando esté listo.'
      : 'Solo falta tocar Enviar en WhatsApp. Te respondemos con el costo del Uber Flash, el total y los datos de SINPE.';
    $('[data-order-resend]', M).href = url;
    show('done');
    fetch('/cart/clear.js', { method: 'POST', headers: { Accept: 'application/json' } })
      .then(function () { document.dispatchEvent(new CustomEvent('tramo:cart-changed', { detail: { silent: true } })); })
      .catch(function () {});
  }

  /* ---------- eventos ---------- */
  M.addEventListener('change', function (e) {
    if (e.target.matches('[data-order-mode]')) setMode(e.target.value);
    if (e.target.matches('[data-order-fe]')) { var f = $('[data-order-fe-fields]', M); f.hidden = !wantsFE(); if (wantsFE()) { var n = $('[data-order-fe-name]', M); if (!n.value) n.value = $('[data-order-name]', M).value.trim(); } validate(); }
  });
  M.addEventListener('input', validate);
  M.addEventListener('submit', function (e) { var f = e.target.closest('[data-order-find]'); if (f) { e.preventDefault(); find($('[data-order-find-q]', M).value); } });
  M.addEventListener('click', function (e) {
    var t = e.target;
    if (t.closest('[data-order-close]')) { close(); return; }
    var lb = t.closest('[data-order-locate]'); if (lb) { locate(lb); return; }
    var cp = t.closest('[data-order-copy]');
    if (cp && navigator.clipboard) { navigator.clipboard.writeText(cp.getAttribute('data-order-copy')).then(function () { var o = cp.textContent; cp.textContent = '¡Copiado!'; setTimeout(function () { cp.textContent = o; }, 1500); }); return; }
    if (t.closest('[data-order-next]')) { if (pageOk(page)) go(page + 1); return; }
    if (t.closest('[data-order-prev]')) { go(page - 1); return; }
    if (t.closest('[data-order-send]')) send();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !M.hidden) close(); });
  M.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.matches('input:not([type=search])') && page < PAGES) { e.preventDefault(); if (pageOk(page)) go(page + 1); }
  });

  /* Cualquier botón de pago abre este pedido en lugar del checkout de Shopify */
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-order-open], [data-checkout-button], a[href="/checkout"], a[href^="/checkout?"]');
    if (!t || M.contains(t)) return;
    e.preventDefault(); e.stopPropagation();
    open();
  }, true);
  document.addEventListener('submit', function (e) {
    var f = e.target; if (f && f.matches && f.matches('[data-cart-form], form[action="/cart"]') && e.submitter && e.submitter.name === 'checkout') { e.preventDefault(); open(); }
  }, true);
  window.TramoOrder = { open: open, close: close };
})();
