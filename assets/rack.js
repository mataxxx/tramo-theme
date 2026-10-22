/* Arma tu especiero — constructor por pasos (modelo → frascos → listo) */
(function () {
  'use strict';
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

  /* Colores de frasco por especia (hasta que haya una imagen SVG propia) */
  var PALETTE = [
    [/paprika|pimenton|chile|chipotle|harissa|berbere|cayena|aji|achiote/, '#b8432a'],
    [/curry|curcuma|azafran|ras el|mostaza/, '#d39a26'],
    [/ajo|cebolla|sal|jengibre|nuez|cardamomo/, '#e6d3ac'],
    [/pimienta|clavo|comino|anis|cafe|cacao|canela/, '#5a3a24'],
    [/oregano|albahaca|romero|tomillo|perejil|eneldo|laurel|mejorana|hierbas|chimichurri|zaatar|culantro|cilantro/, '#5e7a3a'],
    [/masala|garam|chaat|adobo|sazon|mezcla|condimento/, '#8a5a2b']
  ];
  function jarColor(sp) {
    var t = norm(sp.title);
    for (var i = 0; i < PALETTE.length; i++) if (PALETTE[i][0].test(t)) return PALETTE[i][1];
    var h = 0; for (var k = 0; k < t.length; k++) h = (h * 31 + t.charCodeAt(k)) % 360;
    return 'hsl(' + h + ' 40% 42%)';
  }
  function jarHTML(sp, small) {
    if (sp.art) return '<img class="rb-jar__art" src="' + esc(sp.art) + '" alt="' + esc(sp.title) + '">';
    return '<span class="rb-jar__lid"></span><span class="rb-jar__glass" style="--fill:' + jarColor(sp) + '"><span class="rb-jar__label">' + esc(sp.title) + '</span></span>';
  }

  function init(root) {
    if (!root || root._rb) return;
    root._rb = true;
    var data;
    try { data = JSON.parse($('[data-rb-data]', root).textContent); } catch (e) { return; }
    var fmt = new Intl.NumberFormat('es-CR', { style: 'currency', currency: root.getAttribute('data-currency') || 'CRC', maximumFractionDigits: 0 });
    function money(c) { return fmt.format(c / 100); }

    var byId = {};
    data.spices.forEach(function (s) { byId[s.id] = s; });
    var st = { step: 1, model: null, slots: [], active: 0, tab: 'classic', q: '' };

    var bar = $('[data-rb-bar]', root), label = $('[data-rb-steplabel]', root), footer = $('[data-rb-footer]', root);
    var totalEl = $('[data-rb-total]', root), countEl = $('[data-rb-count]', root), next = $('[data-rb-next]', root);
    var slotsEl = $('[data-rb-slots]', root), picker = $('[data-rb-picker]', root), body = $('[data-rb-body]', root);
    var eng = $('[data-rb-eng]', root), engText = $('[data-rb-eng-text]', root);

    function filled() { return st.slots.filter(Boolean).length; }
    function extras() { return st.slots.filter(function (id) { return id && byId[id].group !== 'classic'; }).length; }
    function engraving() { return !!(eng && eng.checked && engText.value.trim() && data.engrave); }
    function total() {
      if (!st.model) return 0;
      return st.model.price + extras() * data.extra.price + (engraving() ? data.engrave.price : 0);
    }

    function progress() {
      var p = st.step === 1 ? 8 : st.step === 2 ? 34 + (st.model ? filled() / st.model.slots : 0) * 50 : 100;
      bar.style.width = p + '%';
      label.textContent = 'Paso ' + st.step + ' de 3 · ' + ['Elige tu modelo', 'Llena tus frascos', 'Revisa y agrega'][st.step - 1];
      $$('[data-rb-dot]', root).forEach(function (d) {
        var k = Number(d.getAttribute('data-rb-dot'));
        d.classList.toggle('is-on', k === st.step);
        d.classList.toggle('is-done', k < st.step);
      });
    }
    function updateFooter() {
      progress();
      if (st.step === 1 || !st.model) { footer.hidden = true; return; }
      footer.hidden = false;
      totalEl.textContent = money(total());
      var n = st.model.slots, f = filled(), x = extras();
      countEl.textContent = f + ' de ' + n + ' frascos' + (x ? ' · ' + x + ' especial' + (x > 1 ? 'es' : '') : '');
      if (st.step === 2) { next.disabled = f !== n; next.textContent = f === n ? 'Continuar' : 'Faltan ' + (n - f); }
      else { next.disabled = !!(eng && eng.checked && !engText.value.trim()); next.textContent = 'Agregar al carrito'; }
    }
    function go(n) {
      st.step = n;
      $$('[data-rb-step]', root).forEach(function (s) {
        var on = Number(s.getAttribute('data-rb-step')) === n;
        s.hidden = !on;
        if (on) { s.classList.remove('is-on'); void s.offsetWidth; s.classList.add('is-on'); }
      });
      if (n === 3) renderSummary();
      updateFooter();
      if (body && body.scrollTo) body.scrollTo({ top: 0, behavior: 'smooth' });
      if (!root.classList.contains('rb--modal')) {
        var top = root.getBoundingClientRect().top + window.scrollY - 80;
        if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }

    function cols(n) { return n <= 6 ? 3 : n <= 12 ? 4 : 6; }
    function renderSlots() {
      var n = st.model.slots, c = cols(n), rows = Math.ceil(n / c), html = '';
      slotsEl.style.setProperty('--cols', c);
      root.setAttribute('data-size', n);
      for (var r = 0; r < rows; r++) {
        html += '<div class="rb-rack__row">';
        for (var i = r * c; i < Math.min(n, (r + 1) * c); i++) {
          var sp = st.slots[i] ? byId[st.slots[i]] : null;
          if (sp) {
            html += '<button type="button" class="rb-jar is-full' + (sp.group !== 'classic' ? ' is-extra' : '') + '" data-rb-slot="' + i + '" aria-label="Frasco ' + (i + 1) + ': ' + esc(sp.title) + '">' + jarHTML(sp) +
              (sp.group !== 'classic' ? '<em class="rb-jar__tag">+</em>' : '') + '</button>';
          } else {
            html += '<button type="button" class="rb-jar is-empty' + (i === st.active ? ' is-next' : '') + '" data-rb-slot="' + i + '" aria-label="Frasco ' + (i + 1) + ' vacío"><span class="rb-jar__lid"></span><span class="rb-jar__glass"><span class="rb-jar__plus">+</span></span></button>';
          }
        }
        html += '</div>';
      }
      slotsEl.innerHTML = html;
      updateFooter();
    }

    function renderSummary() {
      var counts = {}, order = [];
      st.slots.forEach(function (id) { if (!id) return; if (!counts[id]) { counts[id] = 0; order.push(id); } counts[id]++; });
      var x = extras();
      var h = '<div class="rb-sum__model"><span class="rb-sum__rack" style="--cols:' + cols(st.model.slots) + '">' +
        st.slots.map(function (id) { var sp = byId[id]; return '<i style="--fill:' + (sp ? jarColor(sp) : '#ddd') + '"></i>'; }).join('') + '</span>' +
        '<div><b>' + esc(st.model.title) + '</b><small>' + st.model.slots + ' frascos incluidos</small></div><strong>' + money(st.model.price) + '</strong></div>';
      h += '<ul class="rb-sum__list">' + order.map(function (id) {
        var sp = byId[id];
        return '<li><span class="rb-sum__dot" style="--fill:' + jarColor(sp) + '"></span><span>' + esc(sp.title) + (counts[id] > 1 ? ' <small>×' + counts[id] + '</small>' : '') + '</span>' +
          (sp.group !== 'classic' ? '<em>+' + money(data.extra.price * counts[id]) + '</em>' : '<em class="is-inc">Incluida</em>') + '</li>';
      }).join('') + '</ul>';
      if (x) h += '<div class="rb-sum__row"><span>Frascos especiales (' + x + ' × ' + money(data.extra.price) + ')</span><b>' + money(x * data.extra.price) + '</b></div>';
      if (engraving()) h += '<div class="rb-sum__row"><span>Grabado: “' + esc(engText.value.trim()) + '”</span><b>' + money(data.engrave.price) + '</b></div>';
      h += '<div class="rb-sum__row rb-sum__row--total"><span>Total</span><b>' + money(total()) + '</b></div>';
      $('[data-rb-summary]', root).innerHTML = h;
    }

    function pickModel(id) {
      var m = data.models.filter(function (x) { return String(x.id) === String(id); })[0];
      if (!m) return;
      var prev = st.slots.slice(0, m.slots);
      st.model = m; st.slots = [];
      for (var i = 0; i < m.slots; i++) st.slots.push(prev[i] || null);
      st.active = Math.max(0, st.slots.indexOf(null));
      $$('[data-rb-model]', root).forEach(function (b) { b.classList.toggle('is-on', String(b.getAttribute('data-rb-model')) === String(id)); });
      renderSlots();
      setTimeout(function () { go(2); }, 180);
    }

    /* ----- selector ----- */
    function renderGrid() {
      var q = norm(st.q);
      var list = data.spices.filter(function (s) { return q ? norm(s.title).indexOf(q) > -1 : s.group === st.tab; });
      var grid = $('[data-rb-grid]', root);
      if (!list.length) { grid.innerHTML = '<p class="rb__empty">' + (q ? 'No encontramos esa especia.' : 'Pronto agregamos opciones aquí.') + '</p>'; return; }
      grid.innerHTML = list.map(function (s) {
        var cur = st.slots[st.active] === s.id;
        return '<button type="button" class="rb-opt' + (cur ? ' is-on' : '') + '" data-rb-pick="' + s.id + '"><span class="rb-opt__jar rb-jar is-full">' + jarHTML(s) + '</span><b>' + esc(s.title) + '</b>' +
          '<small>' + (s.group === 'classic' ? 'Incluida' : '+' + money(data.extra.price)) + (s.hot ? ' · 🌶' : '') + '</small></button>';
      }).join('');
    }
    function setTab(t) {
      st.tab = t;
      $$('[data-rb-tab]', root).forEach(function (b) { var on = b.getAttribute('data-rb-tab') === t; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
      renderGrid();
    }
    function openPicker(i) {
      st.active = i; st.q = '';
      $('[data-rb-search]', root).value = '';
      $('[data-rb-pick-title]', root).textContent = 'Frasco ' + (i + 1) + ' de ' + st.model.slots;
      var cur = st.slots[i] && byId[st.slots[i]];
      var rm = $('[data-rb-remove]', root); if (rm) rm.hidden = !cur;
      setTab(cur ? cur.group : st.tab);
      picker.hidden = false;
      requestAnimationFrame(function () { picker.classList.add('is-open'); });
    }
    function closePicker() {
      picker.classList.remove('is-open');
      setTimeout(function () { picker.hidden = true; }, 220);
    }
    function choose(id) {
      st.slots[st.active] = Number(id);
      var nx = st.slots.indexOf(null);
      st.active = nx > -1 ? nx : st.active;
      closePicker();
      renderSlots();
      var el = $('[data-rb-slot="' + st.slots.lastIndexOf(Number(id)) + '"]', root);
      if (el) { el.classList.add('is-pop'); }
    }

    function surprise() {
      var pool = data.spices.filter(function (s) { return s.group === 'classic'; });
      if (!pool.length) pool = data.spices.slice();
      pool = pool.sort(function () { return Math.random() - 0.5; });
      for (var k = 0, j = 0; k < st.slots.length; k++) if (!st.slots[k]) st.slots[k] = pool[j++ % pool.length].id;
      renderSlots();
    }

    function addToCart() {
      var bundle = 'esp-' + Date.now().toString(36);
      var names = st.slots.map(function (id, i) { return (i + 1) + '. ' + byId[id].title; }).join(' · ');
      // Código único del especiero + enlace a su etiqueta QR (visible en el pedido del admin)
      var AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', code = '';
      var rnd = new Uint8Array(8); (window.crypto || window.msCrypto).getRandomValues(rnd);
      for (var r = 0; r < 8; r++) code += AL[rnd[r] % 32];
      code = code.slice(0, 4) + '-' + code.slice(4);
      var payload = code + '~' + st.model.slots + '~' + st.slots.map(function (id) { return byId[id].handle; }).join('.');
      var props = { 'Código del especiero': code, 'Frascos': names, '_bundle': bundle,
        '_etiqueta_qr': location.origin + '/pages/etiqueta-especiero?d=' + encodeURIComponent(payload) };
      var items = [{ id: st.model.variant, quantity: 1, properties: props }];
      var x = extras();
      if (x && data.extra.variant) {
        items.push({ id: data.extra.variant, quantity: x, properties: { 'Especiero': st.model.title, '_bundle': bundle,
          'Frascos especiales': st.slots.filter(function (id) { return byId[id].group !== 'classic'; }).map(function (id) { return byId[id].title; }).join(', ') } });
      }
      if (engraving()) {
        props['Grabado'] = engText.value.trim();
        items.push({ id: data.engrave.variant, quantity: 1, properties: { 'Grabado para': st.model.title, '_bundle': bundle } });
      }
      next.disabled = true; next.textContent = 'Agregando…';
      fetch('/cart/add.js', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ items: items }) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.description || j.message || 'No se pudo agregar'); return j; }); })
        .then(function () {
          var m = root.closest('.rb-modal');
          if (m) closeModal(m);
          document.dispatchEvent(new CustomEvent('tramo:open-cart'));
          setTimeout(function () { resetBuilder(); }, 400);
        })
        .catch(function (e) { alert(e.message || 'No se pudo agregar al carrito'); updateFooter(); });
    }

    root.addEventListener('click', function (e) {
      var t = e.target;
      var m = t.closest('[data-rb-model]'); if (m) { pickModel(m.getAttribute('data-rb-model')); return; }
      var g = t.closest('[data-rb-go]'); if (g) { go(Number(g.getAttribute('data-rb-go'))); return; }
      var sl = t.closest('[data-rb-slot]'); if (sl) { openPicker(Number(sl.getAttribute('data-rb-slot'))); return; }
      if (t.closest('[data-rb-pick-close]')) { closePicker(); return; }
      var tb = t.closest('[data-rb-tab]'); if (tb) { st.q = ''; $('[data-rb-search]', root).value = ''; setTab(tb.getAttribute('data-rb-tab')); return; }
      var pk = t.closest('[data-rb-pick]'); if (pk) { choose(pk.getAttribute('data-rb-pick')); return; }
      if (t.closest('[data-rb-remove]')) { st.slots[st.active] = null; closePicker(); renderSlots(); return; }
      if (t.closest('[data-rb-surprise]')) { surprise(); return; }
      if (t.closest('[data-rb-clear]')) { st.slots = st.slots.map(function () { return null; }); st.active = 0; renderSlots(); return; }
      if (t.closest('[data-rb-next]')) { if (st.step === 2) go(3); else if (st.step === 3) addToCart(); }
    });
    $('[data-rb-search]', root).addEventListener('input', function (e) { st.q = e.target.value; renderGrid(); });
    if (eng) eng.addEventListener('change', function () { engText.hidden = !eng.checked; if (eng.checked) engText.focus(); renderSummary(); updateFooter(); });
    if (engText) engText.addEventListener('input', function () { renderSummary(); updateFooter(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !picker.hidden) closePicker(); });

    function resetBuilder() {
      st.model = null; st.slots = []; st.active = 0;
      if (eng) { eng.checked = false; engText.value = ''; engText.hidden = true; }
      $$('[data-rb-model]', root).forEach(function (b) { b.classList.remove('is-on'); });
      go(1);
    }
    root._rbPickSlots = function (n) { var m = data.models.filter(function (x) { return x.slots === Number(n); })[0]; if (m) pickModel(m.id); };
    var q = new URLSearchParams(location.search).get('modelo');
    if (q) pickModel(q);
    progress();
  }

  /* Ventana de la portada */
  function openModal(id, slots) {
    var m = document.getElementById(id || 'RackModal');
    if (!m) return false;
    m.hidden = false;
    document.body.classList.add('is-locked');
    requestAnimationFrame(function () { m.classList.add('is-open'); });
    var r = $('[data-rb]', m);
    init(r);
    if (slots && r && r._rbPickSlots) r._rbPickSlots(slots);
    return true;
  }
  function closeModal(m) {
    m.classList.remove('is-open');
    document.body.classList.remove('is-locked');
    setTimeout(function () { m.hidden = true; }, 300);
  }
  document.addEventListener('click', function (e) {
    var op = e.target.closest && e.target.closest('[data-rb-open]');
    if (op && openModal(op.getAttribute('data-rb-open'), op.getAttribute('data-rb-slots'))) { e.preventDefault(); return; }
    var cl = e.target.closest && e.target.closest('[data-rb-close], .rb-modal__bg');
    if (cl) { var m = cl.closest('.rb-modal'); if (m) closeModal(m); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var m = $('.rb-modal.is-open');
    if (m && !$('[data-rb-picker].is-open', m)) closeModal(m);
  });

  function boot() { $$('[data-rb]').forEach(function (r) { if (!r.closest('.rb-modal')) init(r); }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  document.addEventListener('shopify:section:load', boot);
})();
