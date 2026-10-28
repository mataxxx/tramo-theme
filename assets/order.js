/* Pedido por WhatsApp + SINPE Móvil: envío por Uber Flash (ubicación en el mapa), retiro en el Mercado Central o encomienda */
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
  var payShown = false;
  var cart = null, mode = null, map = null, pin = null, loc = null, last = null, page = 2, FIRST = 2, PAGES = 4, waLoc = false;

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
      loadFlags();
    }).catch(function () { $('[data-order-lines]', M).innerHTML = '<li class="ord-lines__load">No se pudo cargar el carrito. Intenta de nuevo.</li>'; });
  }
  /* Productos que no se envían por encomienda: se bloquea esa opción */
  var noCourier = [], variable = [];
  function loadFlags() {
    var root = (window.TRAMO && TRAMO.routes && TRAMO.routes.root) || '/';
    fetch(root + '?sections=order-flags', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var html = d && d['order-flags'] || '';
        var m = html.match(/<script[^>]*data-order-flags[^>]*>([\s\S]*?)<\/script>/);
        var data = m ? JSON.parse(m[1]) : {};
        noCourier = (data.noCourier || []).filter(Boolean);
        variable = (data.variable || []).filter(Boolean);
        applyCourierBlock();
        applyVariable();
      })
      .catch(function () {});
  }
  function applyVariable() {
    var on = variable.length > 0, n = $('[data-order-varnote]', M), l = $('[data-order-sublabel]', M);
    if (l) l.textContent = on ? 'Subtotal aproximado' : 'Subtotal';
    if (n) { n.hidden = !on; if (on) n.innerHTML = '⚖️ <b>' + variable.map(esc).join(', ') + '</b> ' + (variable.length > 1 ? 'son' : 'es') + ' de peso variable. Lo pesamos al preparar tu pedido y te confirmamos el total exacto por WhatsApp antes de pagar.'; }
  }
  function applyCourierBlock() {
    var radio = $('input[data-order-mode][value="courier"]', M); if (!radio) return;
    var opt = radio.closest('.ord-opt'), sub = $('[data-courier-sub]', M), box = $('[data-courier-block]', M);
    var blocked = noCourier.length > 0;
    radio.disabled = blocked;
    if (opt) opt.classList.toggle('is-disabled', blocked);
    if (sub) sub.textContent = blocked ? 'No disponible para tu pedido' : 'A cualquier parte del país';
    if (box) {
      box.hidden = !blocked;
      if (blocked) box.innerHTML = '<b>' + noCourier.map(esc).join(', ') + '</b> ' + (noCourier.length > 1 ? 'no se envían' : 'no se envía') + ' por encomienda. Elige Uber Flash o retiro en el Mercado Central, o quítalo del carrito para usar encomienda.';
    }
    if (blocked && mode === 'courier') { radio.checked = false; mode = null; $$('[data-order-pane]', M).forEach(function (p) { p.hidden = true; }); validate(); }
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
    var lead = $('[data-order-lead]', M); if (lead) lead.hidden = step === 'done';
    $('[data-order-prog]', M).hidden = step !== 'form';
    $('[data-order-body]', M).scrollTop = 0;
  }

  /* ---------- indicador "hay más abajo" ---------- */
  function moreCheck() {
    var bd = $('[data-order-body]', M), mb = $('[data-order-more]', M); if (!bd || !mb) return;
    mb.hidden = !(bd.scrollHeight - bd.scrollTop - bd.clientHeight > 40);
  }
  (function () { var bd = $('[data-order-body]', M); if (bd) bd.addEventListener('scroll', moreCheck, { passive: true }); window.addEventListener('resize', moreCheck); })();
  if (window.MutationObserver) new MutationObserver(function () { requestAnimationFrame(moreCheck); }).observe(M, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });

  /* ---------- pasos ---------- */
  var TITLES = ['', 'Tu pedido', 'Tus datos', 'Entrega', 'Pago'];
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
    if (page === 4) { var py = $('[data-order-payer]', M); if (py && !py.value) py.value = $('[data-order-name]', M).value.trim(); renderReview(); saveDraft(); }
    if (page === 2) setTimeout(function () { var n = $('[data-order-name]', M); if (!n.value) n.focus(); }, 320);
    validate();
  }
  function pageOk(n) {
    if (n === 1) return !!(cart && cart.item_count);
    if (n === 2) return $('[data-order-name]', M).value.trim().length > 1 && digits($('[data-order-phone]', M).value).length >= 8;
    if (n === 3) return !!mode && (mode === 'pickup' || (mode === 'delivery' && (!!loc || waLoc)) || (mode === 'courier' && !noCourier.length && courierOk()));
    if (n === 4) return ($('[data-order-payer]', M).value.trim().length > 2) && (!wantsFE() || ($('[data-order-fe-id]', M).value.replace(/\D/g, '').length >= 9 && $('[data-order-fe-name]', M).value.trim().length > 1 && /.+@.+\..+/.test($('[data-order-fe-mail]', M).value.trim()) && $('[data-order-fe-act]', M).value.trim().length > 2));
    return true;
  }
  function courierArea() { var el = $('[data-order-courier-area]', M); return el ? el.value.trim() : ''; }
  function courierAddr() { var el = $('[data-order-courier-address]', M); return el ? el.value.trim() : ''; }
  function courierOk() { return courierArea().length > 3 && courierAddr().length > 5; }
  function renderReview() {
    var r = $('[data-order-review]', M); if (!r || !cart) return;
    var ent = mode === 'pickup' ? 'Recoger en el Mercado Central' : mode === 'delivery' ? (D.delivery || 'Envío por Uber Flash') : mode === 'courier' ? (D.courier || 'Envío por encomienda') + ' · ' + courierArea() : '—';
    r.innerHTML = '<h3 class="ord-h">Resumen</h3><dl class="ord-rev">' +
      '<div><dt>A nombre de</dt><dd>' + esc($('[data-order-name]', M).value.trim()) + ' · ' + esc($('[data-order-phone]', M).value.trim()) + '</dd></div>' +
      '<div><dt>Entrega</dt><dd>' + esc(ent) + (mode === 'delivery' || mode === 'courier' ? ' <small>(envío se cotiza)</small>' : '') + '</dd></div>' +
      (mode ? '<div><dt>Cuándo</dt><dd>' + esc(etaPlain(mode)) + '</dd></div>' : '') + '</dl>';
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
    $$('[data-order-amount]', M).forEach(function (el) { el.textContent = t; });
  }

  /* ---------- horario: cuándo se entrega (automático según la hora de Costa Rica) ---------- */
  var DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  function hm(s, d) { var m = String(s || d).match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : hm(d, d); }
  function fmtHM(min) { var h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? 'p. m.' : 'a. m.'; var h12 = h % 12 || 12; return h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + ap; }
  function crNow() {
    var p = {};
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/Costa_Rica', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
    } catch (e) { var d = new Date(); return { day: d.getDay(), min: d.getHours() * 60 + d.getMinutes() }; }
    var wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
    return { day: wd, min: (+p.hour) * 60 + (+p.minute) };
  }
  function eta() {
    var open = hm(D.open, '07:30'), close = hm(D.close, '17:30'), cut = hm(D.cutoff, '16:30');
    var days = String(D.days || '1,2,3,4,5,6').split(',').map(function (x) { return +x; });
    var now = crNow(), isDay = days.indexOf(now.day) > -1;
    var r = { open: open, close: close, cut: cut, why: isDay ? (now.min >= cut ? 'late' : '') : 'closed' };
    if (isDay && now.min >= open && now.min < cut) { r.when = 'hoy'; r.today = true; r.label = 'hoy'; return r; }
    if (isDay && now.min < open) { r.when = 'hoy'; r.today = true; r.fromOpen = true; r.label = 'hoy desde las ' + fmtHM(open); return r; }
    for (var i = 1; i <= 7; i++) {
      var d = (now.day + i) % 7;
      if (days.indexOf(d) > -1) { r.when = i === 1 ? 'mañana' : 'el ' + DAYS[d]; r.today = false; r.label = r.when + ' desde las ' + fmtHM(open); return r; }
    }
    r.when = 'pronto'; r.label = 'pronto'; return r;
  }
  function etaText(m) {
    var e = eta(), late = e.today ? '' : e.why === 'late' ? ' <small>(los pedidos después de las ' + fmtHM(e.cut) + ' salen el siguiente día)</small>' : e.why === 'closed' ? ' <small>(hoy no abrimos)</small>' : '';
    if (m === 'pickup') return '🕒 Lo preparamos <b>' + e.label + '</b> · te escribimos por WhatsApp cuando esté listo para recoger' + late;
    if (m === 'delivery') return '🛵 Sale <b>' + e.label + '</b> por Uber Flash · te avisamos cuando vaya en camino' + late;
    if (m === 'courier') return '📦 Se despacha <b>' + e.label + '</b> · llega en hasta ' + (D.courierHours || 48) + ' h' + late;
    return '';
  }
  function etaPlain(m) { return etaText(m).replace(/<[^>]+>/g, '').replace(/^\S+\s/, ''); }
  function showEta(m) {
    var el = $('[data-order-eta]', M); if (!el) return;
    var t = etaText(m); el.hidden = !t; el.innerHTML = t;
  }

  /* ---------- modo de entrega ---------- */
  /* Botón final: retiro → "Realizar pago" (muestra monto y SINPE) → "Pago realizado" (envía). Envíos → "Confirmar pedido" */
  function sendLabel() {
    var btn = $('[data-order-send]', M), lb = $('[data-order-send-label]', M); if (!btn || !lb) return;
    var pick = mode === 'pickup';
    lb.textContent = pick ? (payShown ? 'Pago realizado' : 'Realizar pago') : 'Confirmar pedido';
    btn.classList.toggle('is-sinpe', pick && !payShown);
    btn.classList.toggle('is-done', pick && payShown);
  }
  function showPay() {
    payShown = true;
    var sb = $('[data-order-sinpebox]', M), pw = $('[data-order-paywith]', M);
    if (pw) pw.hidden = true;
    if (sb) { sb.hidden = false; try { sb.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {} }
    sendLabel();
  }
  function setMode(m) {
    try { return setModeInner(m); } catch (ex) { err('No se pudo elegir la entrega (' + (ex && ex.message || ex) + '). Intenta de nuevo.'); }
  }
  function setModeInner(m) {
    mode = m;
    $$('input[data-order-mode]', M).forEach(function (r) { r.checked = r.value === m; });
    $$('[data-order-pane]', M).forEach(function (p) { p.hidden = p.getAttribute('data-order-pane') !== m; });
    try { showEta(m); } catch (e2) {}
    payShown = false;
    var sb = $('[data-order-sinpebox]', M), pl = $('[data-order-paylater]', M), pw = $('[data-order-paywith]', M);
    if (sb) sb.hidden = true;
    if (pl) pl.hidden = m === 'pickup';
    if (pw) pw.hidden = m !== 'pickup';
    sendLabel();
    var sl = $('[data-order-sinpe-line]', M);
    if (sl) sl.innerHTML = m === 'pickup'
      ? 'Deposita <b class="ord-sinpe-box__amt" data-order-amount>' + (cart ? money(cart.total_price) : '') + '</b> al <b>SINPE Móvil</b>:'
      : 'Te enviamos por WhatsApp el total con el envío y lo pagas al <b>SINPE Móvil</b>:';
    var pt = $('[data-order-paytext]', M);
    if (pt) pt.innerHTML = m === 'pickup'
      ? 'Deposita <b>' + (cart ? money(cart.total_price) : 'el total') + '</b> por <b>SINPE Móvil</b>' + (D.sinpe ? ' al <b>' + esc(D.sinpe) + '</b>' + (D.sinpeName ? ' a nombre de ' + esc(D.sinpeName) : '') : '') + '. El sistema confirmará tu SINPE y te contactaremos por WhatsApp para coordinar el retiro.'
      : m === 'courier'
      ? 'Te enviaremos por WhatsApp el <b>monto total</b> (productos + encomienda). Pagas por <b>SINPE Móvil</b>; al confirmar tu pago despachamos tu pedido y te pasamos el número de guía.'
      : 'Te enviaremos por WhatsApp el <b>monto total</b> (productos + Uber Flash). Pagas por <b>SINPE Móvil</b>; al confirmar tu pago te contactamos para coordinar el envío.';
    if (m === 'delivery') { initMap(); if (!gotAuto && !loc) { gotAuto = true; locate($('[data-order-locate]', M), true); } }
    validate();
  }

  /* ---------- mapa: Google (limpio, estilo Uber, pin fijo al centro) o OpenStreetMap si no hay llave ---------- */
  var leafletP = null, googleP = null, kind = null, userMoved = false, cpin = null;
  var GSTYLE = [
    /* Sin negocios, buses ni íconos */
    { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
    { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
    { featureType: 'poi.attraction', stylers: [{ visibility: 'off' }] },
    { featureType: 'poi.place_of_worship', elementType: 'labels', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
    { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    /* Fondo claro y casas como cajitas (como Uber) */
    { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#f1efe9' }] },
    { featureType: 'landscape.man_made', elementType: 'geometry.fill', stylers: [{ color: '#e7e3da' }] },
    { featureType: 'landscape.man_made', elementType: 'geometry.stroke', stylers: [{ color: '#d3cdbf' }, { weight: 0.6 }] },
    /* Parques y zonas verdes */
    { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#cfe6c3' }, { visibility: 'on' }] },
    { featureType: 'poi.sports_complex', elementType: 'geometry', stylers: [{ color: '#d6ebcb' }] },
    { featureType: 'landscape.natural.landcover', elementType: 'geometry', stylers: [{ color: '#dcecd2' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#c4dcef' }] },
    /* Calles blancas con nombres nítidos */
    { featureType: 'road', elementType: 'geometry.fill', stylers: [{ color: '#ffffff' }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#e2ddd2' }] },
    { featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{ color: '#fbe7b5' }] },
    { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#efd38f' }] },
    { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#505a50' }] },
    { featureType: 'road', elementType: 'labels.text.stroke', stylers: [{ color: '#ffffff' }, { weight: 3 }] },
    { featureType: 'administrative', elementType: 'labels.text.fill', stylers: [{ color: '#6b6b6b' }] }
  ];
  function loadGoogle() {
    if (window.google && google.maps && google.maps.Map) return Promise.resolve();
    if (googleP) return googleP;
    googleP = new Promise(function (res, rej) {
      window.__ordGm = function () { res(); };
      window.gm_authFailure = function () { rej(new Error('auth')); if (kind === 'g') fallbackLeaflet(); };
      var js = document.createElement('script');
      js.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(D.gkey) + '&v=weekly&language=es&region=CR&loading=async&callback=__ordGm';
      js.async = true; js.onerror = rej; document.head.appendChild(js);
      setTimeout(function () { rej(new Error('timeout')); }, 8000);
    });
    return googleP;
  }
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletP) return leafletP;
    leafletP = new Promise(function (res, rej) {
      var css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(css);
      var js = document.createElement('script'); js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'; js.onload = res; js.onerror = rej; document.head.appendChild(js);
    });
    return leafletP;
  }
  function center0() { return { lat: parseFloat(D.lat) || 9.9349, lng: parseFloat(D.lng) || -84.0789 }; }
  function initMap() {
    if (map) { if (kind === 'l') setTimeout(function () { map.invalidateSize(); }, 60); return; }
    var el = $('[data-order-map]', M);
    el.classList.add('is-loading');
    if (D.gkey) {
      loadGoogle().then(function () { if (!map) initGoogle(el); }).catch(function () { if (!map || kind === 'g') fallbackLeaflet(); });
    } else initLeaflet(el);
  }
  function fallbackLeaflet() {
    var el = $('[data-order-map]', M); map = null; pin = null; accCircle = null; kind = null; cpin = null;
    el.innerHTML = ''; el.classList.remove('is-google'); initLeaflet(el);
  }
  function initGoogle(el) {
    el.classList.remove('is-loading'); el.classList.add('is-google'); kind = 'g';
    var c = loc || center0();
    map = new google.maps.Map(el, { center: c, zoom: loc ? 17 : 13, styles: GSTYLE, disableDefaultUI: true, zoomControl: true, clickableIcons: false, gestureHandling: 'greedy', keyboardShortcuts: false });
    cpin = document.createElement('div'); cpin.className = 'ord-cpin'; cpin.innerHTML = '<span></span><i></i>'; el.appendChild(cpin);
    map.addListener('dragstart', function () { userMoved = true; cpin.classList.add('is-lift'); });
    map.addListener('click', function (e) { userMoved = true; map.panTo(e.latLng); });
    map.addListener('idle', function () {
      cpin.classList.remove('is-lift');
      if (!userMoved) return; userMoved = false;
      var p = map.getCenter(); setWaLoc(false);
      loc = { lat: +p.lat().toFixed(6), lng: +p.lng().toFixed(6) };
      if (accCircle) { accCircle.setMap(null); accCircle = null; } acc = null;
      hint('moved'); validate();
    });
    if (loc) showAcc(loc.lat, loc.lng);
    hint(loc ? 'gps' : null);
  }
  function initLeaflet(el) {
    loadLeaflet().then(function () {
      el.classList.remove('is-loading'); kind = 'l';
      var c = center0();
      map = L.map(el, { zoomControl: true, attributionControl: true }).setView([c.lat, c.lng], 13);
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
    setWaLoc(false);
    loc = { lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
    if (src !== 'gps' && accCircle) { if (kind === 'g') accCircle.setMap(null); else if (map) map.removeLayer(accCircle); accCircle = null; acc = null; }
    if (kind === 'g' && map) {
      userMoved = false; map.setCenter({ lat: lat, lng: lng }); map.setZoom(zoom || Math.max(map.getZoom(), 16));
    } else if (kind === 'l' && window.L && map) {
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
    var h = $('[data-order-maphint]', M); if (!h) return;
    var g = kind === 'g';
    h.classList.toggle('is-ok', !!loc && state !== 'busy');
    h.classList.toggle('is-busy', state === 'busy');
    if (state === 'busy') { h.textContent = 'Buscando tu ubicación…'; return; }
    if (!loc) { h.textContent = g ? 'Mueve el mapa para poner el pin en tu casa.' : 'Toca el mapa o arrastra el pin hasta tu casa.'; return; }
    h.textContent = (acc && state === 'gps' ? '✓ Te ubicamos (±' + Math.round(acc) + ' m). ' : '✓ Ubicación marcada. ') + (g ? 'Si no es justo tu casa, mueve el mapa.' : 'Si no es justo tu casa, arrastra el pin.');
  }
  function showAcc(lat, lng) {
    if (!map || !acc || acc > 400) return;
    if (kind === 'g') {
      if (accCircle) { accCircle.setCenter({ lat: lat, lng: lng }); accCircle.setRadius(acc); }
      else accCircle = new google.maps.Circle({ map: map, center: { lat: lat, lng: lng }, radius: acc, strokeColor: '#2f7fd8', strokeWeight: 1, fillColor: '#2f7fd8', fillOpacity: .12, clickable: false });
    } else if (window.L) {
      if (accCircle) accCircle.setLatLng([lat, lng]).setRadius(acc);
      else accCircle = L.circle([lat, lng], { radius: acc, color: '#2f7fd8', weight: 1, fillColor: '#2f7fd8', fillOpacity: .12, interactive: false }).addTo(map);
    }
  }
  /* Ubicación rápida: primero la última conocida (al instante) y luego la va afinando sin bloquear el botón */
  function locate(btn, auto) {
    if (!navigator.geolocation) { if (!auto) err('Tu navegador no permite compartir la ubicación. Márcala en el mapa.'); return; }
    var got = false, best = null, wid = null, stopped = false, movedByUser = false, startLoc = loc;
    if (btn && !auto) btn.classList.add('is-busy');
    if (!auto) hint('busy');
    function apply(p) {
      if (loc !== startLoc && best === null && got) return;
      best = p; acc = p.coords.accuracy;
      place(p.coords.latitude, p.coords.longitude, acc < 60 ? 18 : 17, 'gps');
      showAcc(p.coords.latitude, p.coords.longitude);
      startLoc = loc;
    }
    function firstFix(p) { if (btn) btn.classList.remove('is-busy'); if (!got) { got = true; apply(p); } }
    function stop() { if (stopped) return; stopped = true; if (wid != null) navigator.geolocation.clearWatch(wid); if (btn) btn.classList.remove('is-busy'); if (!got) { hint(); if (!auto) err('No pudimos obtener tu ubicación. Revisa el permiso de ubicación o márcala en el mapa.'); } }
    navigator.geolocation.getCurrentPosition(firstFix, function (e) { if (e && e.code === 1) stop(); }, { enableHighAccuracy: false, timeout: 4000, maximumAge: 300000 });
    wid = navigator.geolocation.watchPosition(function (p) {
      if (!got) { firstFix(p); return; }
      if (loc !== startLoc) { stop(); return; } /* el cliente ya movió el pin: no lo pisamos */
      if (!best || p.coords.accuracy < best.coords.accuracy) apply(p);
      if (p.coords.accuracy <= 20) stop();
    }, function (e) { if (e && e.code === 1) stop(); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    setTimeout(stop, 10000);
  }

  function findMsg(html) { var r = $('[data-order-find-res]', M); r.innerHTML = html; r.hidden = !html; }
  var findToken = 0, findTimer = null;
  var gSession = null;
  function gToken() { if (!gSession) gSession = (Date.now().toString(36) + Math.random().toString(36).slice(2)); return gSession; }
  function googleSearch(q) {
    var lat = parseFloat(D.lat) || 9.93, lng = parseFloat(D.lng) || -84.08;
    return fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': D.gkey },
      body: JSON.stringify({ input: q, includedRegionCodes: ['cr'], languageCode: 'es', sessionToken: gToken(),
        locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 50000 } } })
    }).then(function (r) { if (!r.ok) throw new Error('google ' + r.status); return r.json(); })
      .then(function (d) {
        return ((d && d.suggestions) || []).filter(function (s) { return s.placePrediction; }).map(function (s) {
          var p = s.placePrediction; return { placeId: p.placeId, name: (p.text && p.text.text) || '' };
        });
      });
  }
  function googlePlace(id) {
    var tok = gToken(); gSession = null;
    return fetch('https://places.googleapis.com/v1/places/' + encodeURIComponent(id) + '?languageCode=es&sessionToken=' + encodeURIComponent(tok), {
      headers: { 'X-Goog-Api-Key': D.gkey, 'X-Goog-FieldMask': 'location' }
    }).then(function (r) { if (!r.ok) throw new Error('google ' + r.status); return r.json(); })
      .then(function (d) { return d && d.location ? { lat: d.location.latitude, lng: d.location.longitude } : null; });
  }
  function geoSearch(q) {
    if (D.gkey) return googleSearch(q).catch(function () { return []; }).then(function (list) { return list.length ? list : osmSearch(q); });
    return osmSearch(q);
  }
  function osmSearch(q) {
    var photon = fetch('https://photon.komoot.io/api/?limit=8&lat=9.93&lon=-84.08&q=' + encodeURIComponent(q + ' Costa Rica'))
      .then(function (r) { if (!r.ok) throw new Error('photon ' + r.status); return r.json(); })
      .then(function (d) {
        return ((d && d.features) || []).filter(function (f) { return f.properties && f.properties.countrycode === 'CR'; }).map(function (f) {
          var p = f.properties;
          return { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], name: [p.name, p.street, p.district || p.locality, p.city || p.county, p.state].filter(function (x, i, arr) { return x && arr.indexOf(x) === i; }).join(', ') };
        });
      });
    return photon.catch(function () { return []; }).then(function (list) {
      if (list.length) return list;
      return fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=cr&accept-language=es&q=' + encodeURIComponent(q))
        .then(function (r) { if (!r.ok) throw new Error('nominatim ' + r.status); return r.json(); })
        .then(function (a) { return (a || []).map(function (x) { return { lat: +x.lat, lng: +x.lon, name: x.display_name }; }); });
    });
  }
  function find(q, live) {
    q = String(q || '').trim();
    if (q.length < (D.gkey && live ? 4 : 3)) { if (!live) findMsg('<p class="ord-find-res__msg">Escribe al menos 3 letras.</p>'); else findMsg(''); return; }
    var mine = ++findToken;
    var b = $('[data-order-find-go]', M); if (b && !live) { b.disabled = true; b.textContent = '…'; }
    if (!live) findMsg('<p class="ord-find-res__msg ord-find-res__msg--soft">Buscando…</p>');
    geoSearch(q).then(function (list) {
      if (mine !== findToken) return;
      if (!list.length) { findMsg('<p class="ord-find-res__msg">No encontramos “' + esc(q) + '”. Prueba con un lugar conocido cercano (escuela, iglesia, comercio) o toca el mapa.</p>'); return; }
      M._findList = list;
      findMsg(list.slice(0, 5).map(function (x, i) { return '<button type="button" class="ord-find-res__item" data-find-pick="' + i + '">📍 ' + esc(x.name) + '</button>'; }).join(''));
    }).catch(function (e) {
      if (mine !== findToken) return;
      findMsg('<p class="ord-find-res__msg">El buscador de mapas no respondió. Toca el mapa para marcar tu casa o usa tu ubicación.</p>');
    }).then(function () { if (b) { b.disabled = false; b.textContent = 'Buscar'; } });
  }
  function setWaLoc(on) {
    waLoc = !!on;
    var lb = $('[data-order-waloc-label]', M); if (lb) lb.textContent = waLoc ? '✓ La envío por WhatsApp' : 'La envío por WhatsApp';
    var btn = $('[data-order-waloc]', M); if (btn) btn.classList.toggle('is-on', waLoc);
    var h = $('[data-order-maphint]', M); if (h) h.hidden = waLoc;
    var mp = $('[data-order-map]', M); if (mp) mp.classList.toggle('is-dim', waLoc);
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
      var bulkIt = /granel/i.test(it.variant_title || '');
      L1.push('• ' + (bulkIt ? '' : it.quantity + ' × ') + it.product_title + (bulkIt ? ' (A granel · ' + (it.quantity * 10) + ' g)' : (variantLabel(it) ? ' (' + variantLabel(it) + ')' : '')) + ' — ' + money(it.final_line_price));
    });
    L1.push('', '*Subtotal' + (variable.length ? ' aproximado' : '') + ':* ' + money(cart.total_price), '');
    if (variable.length) L1.push('⚖️ Peso variable (' + variable.join(', ') + '): espero el total exacto al pesar.', '');
    if (mode === 'pickup') {
      L1.push('*Entrega:* Recoger en ' + (D.pickup || 'el Mercado Central'));
    } else if (mode === 'courier') {
      L1.push('*Entrega:* ' + (D.courier || 'Encomienda'));
      L1.push('*Zona:* ' + courierArea());
      L1.push('*Dirección:* ' + courierAddr());
    } else {
      var n = $('[data-order-notes]', M).value.trim();
      L1.push('*Entrega:* ' + (D.delivery || 'Uber Flash'));
      L1.push('*Ubicación:* ' + (loc && !waLoc ? 'https://maps.google.com/?q=' + loc.lat + ',' + loc.lng : 'Se la envío aquí por WhatsApp 📍'));
      if (n) L1.push('*Señas:* ' + n);
    }
    if (mode) L1.push('*Cuándo:* ' + etaPlain(mode));
    L1.push('');
    if (wantsFE()) {
      L1.push('*Factura electrónica:* Sí');
      L1.push('Cédula ' + $('[data-order-fe-type]', M).value + ': ' + $('[data-order-fe-id]', M).value.trim());
      L1.push('Nombre: ' + $('[data-order-fe-name]', M).value.trim());
      L1.push('Actividad económica: ' + $('[data-order-fe-act]', M).value.trim());
      L1.push('Correo: ' + $('[data-order-fe-mail]', M).value.trim());
    } else {
      L1.push('*Factura electrónica:* No');
    }
    var payer = ($('[data-order-payer]', M) || {}).value; payer = payer ? payer.trim() : '';
    if (mode === 'pickup') L1.push('', '*Pago:* SINPE Móvil' + (D.sinpe ? ' al ' + D.sinpe + (D.sinpeName ? ' (' + D.sinpeName + ')' : '') : '') + ' por ' + money(cart.total_price) + '.');
    else L1.push('', '*Pago:* SINPE Móvil. Quedo atento al costo del envío y el total.');
    if (payer) L1.push('*SINPE a nombre de:* ' + payer);
    return L1.join('\n');
  }
  /* Copia del pedido a tu panel: borrador al llegar a Pago ("sin terminar") y definitivo al confirmar */
  var draftCode = null;
  function buildPayload(c, status) {
    var fe = wantsFE() ? ($('[data-order-fe-type]', M).value + ' ' + $('[data-order-fe-id]', M).value.trim() + ' · ' + $('[data-order-fe-name]', M).value.trim() + ' · Act. ' + $('[data-order-fe-act]', M).value.trim() + ' · ' + $('[data-order-fe-mail]', M).value.trim()) : '';
    return {
      code: c, status: status, mode: mode, eta: mode ? etaPlain(mode) : '', variable: variable,
      name: $('[data-order-name]', M).value.trim(), phone: $('[data-order-phone]', M).value.trim(),
      payer: (($('[data-order-payer]', M) || {}).value || '').trim(),
      location: mode === 'delivery' ? (loc && !waLoc ? 'https://maps.google.com/?q=' + loc.lat + ',' + loc.lng : (waLoc ? 'La envía por WhatsApp' : '')) : '',
      address: mode === 'courier' ? courierAddr() : (mode === 'delivery' ? (($('[data-order-notes]', M) || {}).value || '').trim() : ''),
      area: mode === 'courier' ? courierArea() : '',
      fe: fe,
      items: (cart && cart.items || []).map(function (it) {
        var bulk = /granel/i.test(it.variant_title || '');
        return { variant_id: it.variant_id, quantity: it.quantity, title: it.product_title, unit: it.price / 100,
          label: bulk ? 'A granel · ' + (it.quantity * 10) + ' g' : variantLabel(it) };
      }),
      message: message(c)
    };
  }
  function postOrder(c, status) {
    try {
      var root = (window.TRAMO && TRAMO.routes && TRAMO.routes.root) || '/';
      fetch(root.replace(/\/$/, '') + '/apps/tramo/order', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(buildPayload(c, status)) }).catch(function () {});
    } catch (e) {}
  }
  function saveDraft() {
    if (!cart || !cart.item_count || !mode) return;
    if (!draftCode) draftCode = code();
    postOrder(draftCode, 'incompleto');
  }
  function send() {
    if (!validate()) return;
    if (!D.wa) { err('Falta configurar el WhatsApp de la tienda.'); return; }
    var c = draftCode || code(); draftCode = null;
    var url = 'https://wa.me/' + D.wa + '?text=' + encodeURIComponent(message(c));
    try { localStorage.setItem(LS, JSON.stringify({ n: $('[data-order-name]', M).value.trim(), p: $('[data-order-phone]', M).value.trim() })); } catch (e) {}
    last = { code: c, url: url, mode: mode };
    /* Copia automática del pedido a la tienda (no depende de que el cliente envíe el WhatsApp) */
    postOrder(c, 'pago-pendiente');
    /* Celular: abrir WhatsApp en la misma pestaña (la app se abre sola). Computadora: pestaña nueva (WhatsApp Web). */
    var mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
    if (mobile) { setTimeout(function () { location.href = url; }, 60); }
    else { var w = null; try { w = window.open(url, '_blank'); if (w) { try { w.opener = null; } catch (e2) {} } } catch (e) {} if (!w) setTimeout(function () { location.href = url; }, 300); }
    $('[data-order-code]', M).textContent = c;
    $('[data-order-done-text]', M).textContent = mode === 'pickup'
      ? 'Solo falta tocar Enviar en WhatsApp. Deposita ' + money(cart.total_price) + (D.sinpe ? ' al SINPE ' + D.sinpe + (D.sinpeName ? ' a nombre de ' + D.sinpeName : '') : '') + '. No necesitas enviar comprobante: el sistema confirmará tu SINPE y te contactaremos por WhatsApp para coordinar el retiro.'
      : mode === 'courier'
      ? 'Solo falta tocar Enviar en WhatsApp. Te enviaremos por WhatsApp el monto total (productos + encomienda). Cuando confirmemos tu pago, despachamos tu pedido y te pasamos el número de guía.'
      : 'Solo falta tocar Enviar en WhatsApp.' + (waLoc ? ' Después envíanos tu ubicación en ese chat (📎 → Ubicación).' : '') + ' Te enviaremos por WhatsApp el monto total (productos + Uber Flash). Cuando confirmemos tu pago, te contactamos para coordinar el envío.';
    var rs = $('[data-order-resend]', M); rs.href = url; if (mobile) rs.removeAttribute('target');
    show('done');
    fetch('/cart/clear.js', { method: 'POST', headers: { Accept: 'application/json' } })
      .then(function () { document.dispatchEvent(new CustomEvent('tramo:cart-changed', { detail: { silent: true } })); })
      .catch(function () {});
  }

  /* ---------- eventos ---------- */
  /* Factura electrónica: el interruptor se activa con el toque en toda la fila (no depende del checkbox nativo) */
  function setFE(on) {
    var cb = $('[data-order-fe]', M), sw = $('[data-fe-switch]', M), f = $('[data-order-fe-fields]', M);
    if (cb) cb.checked = !!on;
    if (sw) sw.setAttribute('aria-checked', on ? 'true' : 'false');
    if (f) f.hidden = !on;
    if (on) { var n = $('[data-order-fe-name]', M); if (n && !n.value) n.value = $('[data-order-name]', M).value.trim(); }
    validate(); moreCheck();
  }
  M.addEventListener('click', function (e) {
    var sw = e.target.closest && e.target.closest('[data-fe-switch]'); if (!sw) return;
    e.preventDefault(); e.stopPropagation();
    setFE(!($('[data-order-fe]', M) || {}).checked);
  }, true);
  M.addEventListener('keydown', function (e) {
    if ((e.key === ' ' || e.key === 'Enter') && e.target.matches && e.target.matches('[data-fe-switch]')) { e.preventDefault(); setFE(!($('[data-order-fe]', M) || {}).checked); }
  });
  /* Opciones de entrega: se eligen con el toque en toda la tarjeta (no depende del radio, para iPhone) */
  M.addEventListener('click', function (e) {
    var opt = e.target.closest && e.target.closest('.ord-opt'); if (!opt) return;
    var inp = opt.querySelector('input[data-order-mode]'); if (!inp) return;
    e.preventDefault();
    if (inp.disabled) { applyCourierBlock(); return; }
    setMode(inp.value);
  });
  M.addEventListener('change', function (e) {
    if (e.target.matches('[data-order-mode]') && e.target.value !== mode) setMode(e.target.value);
    if (e.target.matches('[data-order-fe]')) { var f = $('[data-order-fe-fields]', M); f.hidden = !wantsFE(); if (wantsFE()) { var n = $('[data-order-fe-name]', M); if (!n.value) n.value = $('[data-order-name]', M).value.trim(); } validate(); }
  });
  M.addEventListener('input', validate);
  M.addEventListener('input', function (e) {
    if (!e.target.matches('[data-order-find-q]')) return;
    clearTimeout(findTimer); var v = e.target.value;
    findTimer = setTimeout(function () { find(v, true); }, D.gkey ? 650 : 450);
  });
  M.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.matches('[data-order-find-q]')) { e.preventDefault(); clearTimeout(findTimer); find(e.target.value); e.target.blur(); }
  });
  M.addEventListener('click', function (e) {
    var t = e.target;
    if (t.closest('[data-order-close]')) { close(); return; }
    var lb = t.closest('[data-order-locate]'); if (lb) { setWaLoc(false); locate(lb); return; }
    if (t.closest('[data-order-find-go]')) { clearTimeout(findTimer); find($('[data-order-find-q]', M).value); return; }
    if (t.closest('[data-order-waloc]')) { setWaLoc(!waLoc); validate(); return; }
    var fp = t.closest('[data-find-pick]'); if (fp && M._findList) {
      var x = M._findList[+fp.getAttribute('data-find-pick')]; if (!x) return;
      var qi = $('[data-order-find-q]', M); if (qi && x.name) qi.value = x.name.split(',')[0];
      if (x.placeId) { findMsg('<p class="ord-find-res__msg ord-find-res__msg--soft">Ubicando…</p>'); googlePlace(x.placeId).then(function (pt) { findMsg(''); if (pt) place(pt.lat, pt.lng, 18); else findMsg('<p class="ord-find-res__msg">No pudimos ubicar ese lugar. Toca el mapa.</p>'); }).catch(function () { findMsg('<p class="ord-find-res__msg">No pudimos ubicar ese lugar. Toca el mapa.</p>'); }); }
      else { findMsg(''); place(x.lat, x.lng, 17); }
      return;
    }
    if (t.closest('[data-order-more]')) { var bd = $('[data-order-body]', M); bd.scrollBy({ top: bd.clientHeight * 0.7, behavior: 'smooth' }); return; }
    var cp = t.closest('[data-order-copy]');
    if (cp && navigator.clipboard) { navigator.clipboard.writeText(cp.getAttribute('data-order-copy')).then(function () { var o = cp.textContent; cp.textContent = '¡Copiado!'; setTimeout(function () { cp.textContent = o; }, 1500); }); return; }
    if (t.closest('[data-order-next]')) { if (pageOk(page)) go(page + 1); return; }
    if (t.closest('[data-order-prev]')) { go(page - 1); return; }
    if (t.closest('[data-order-send]')) { if (mode === 'pickup' && !payShown && $('[data-order-sinpebox]', M)) { if (validate()) showPay(); return; } send(); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !M.hidden) close(); });
  M.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.matches('input:not([type=search]):not([data-order-find-q])') && page < PAGES) { e.preventDefault(); if (pageOk(page)) go(page + 1); }
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
