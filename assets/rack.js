/* Arma tu especiero */
(function () {
  'use strict';
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

  function init(root) {
    if (!root || root._rack) return;
    root._rack = true;
    var dataEl = $('[data-rack-data]', root);
    if (!dataEl) return;
    var data;
    try { data = JSON.parse(dataEl.textContent); } catch (e) { return; }
    var fmt = new Intl.NumberFormat('es-CR', { style: 'currency', currency: root.getAttribute('data-currency') || 'CRC', maximumFractionDigits: 0 });
    function money(cents) { return fmt.format(cents / 100); }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

    var state = { model: null, slots: [], active: 0, step: 1, filter: '', query: '' };
    var spiceById = {}, spiceByHandle = {};
    data.spices.forEach(function (s) { spiceById[s.id] = s; spiceByHandle[s.handle] = s; });

    var bar = $('[data-rack-bar]', root);
    var barTotal = $('[data-rack-total]', root);
    var barProg = $('[data-rack-progress]', root);
    var nextBtn = $('[data-rack-next]', root);
    var slotsEl = $('[data-rack-slots]', root);
    var picker = $('[data-rack-picker]', root);
    var engToggle = $('[data-engrave-toggle]', root);
    var engText = $('[data-engrave-text]', root);

    function hue(str) { var h = 0; for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360; return h; }
    function filled() { return state.slots.filter(Boolean).length; }
    function engraving() { return !!(engToggle && engToggle.checked && engText && engText.value.trim() && data.engrave); }
    function total() {
      if (!state.model) return 0;
      var t = state.model.price;
      state.slots.forEach(function (id) { if (id && spiceById[id]) t += spiceById[id].price; });
      if (engraving()) t += data.engrave.price;
      return t;
    }

    function setStep(n) {
      state.step = n;
      $$('[data-step]', root).forEach(function (el) { el.hidden = Number(el.getAttribute('data-step')) !== n; });
      $$('[data-step-dot]', root).forEach(function (el) {
        var k = Number(el.getAttribute('data-step-dot'));
        el.classList.toggle('is-active', k === n);
        el.classList.toggle('is-done', k < n);
      });
      updateBar();
      var top = root.getBoundingClientRect().top + window.scrollY - 70;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }

    function updateBar() {
      if (!state.model || state.step === 1) { bar.hidden = true; return; }
      bar.hidden = false;
      barTotal.textContent = money(total());
      var n = state.model.slots, f = filled();
      barProg.textContent = f + ' de ' + n + ' frascos';
      if (state.step === 2) {
        nextBtn.textContent = f === n ? 'Continuar' : 'Faltan ' + (n - f);
        nextBtn.disabled = f !== n;
      } else {
        nextBtn.textContent = 'Agregar al carrito';
        nextBtn.disabled = f !== n || (engToggle && engToggle.checked && !engText.value.trim());
      }
    }

    function renderSlots() {
      var n = state.model.slots;
      var cols = n <= 6 ? 3 : (n <= 9 ? 3 : 4);
      slotsEl.style.setProperty('--cols', cols);
      slotsEl.innerHTML = '';
      for (var i = 0; i < n; i++) {
        var sp = state.slots[i] ? spiceById[state.slots[i]] : null;
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'rack-jar' + (sp ? ' is-filled' : '') + (i === state.active && !sp ? ' is-next' : '');
        b.setAttribute('data-slot', i);
        if (sp) {
          b.style.setProperty('--h', hue(sp.handle));
          b.innerHTML = '<span class="rack-jar__lid"></span><span class="rack-jar__glass"><span class="rack-jar__label">' + esc(sp.title) + '</span></span>' +
            (sp.premium ? '<em class="rack-jar__star" title="Especial">★</em>' : '') +
            '<span class="rack-jar__x" data-slot-clear="' + i + '" aria-label="Quitar">×</span>';
        } else {
          b.innerHTML = '<span class="rack-jar__lid"></span><span class="rack-jar__glass rack-jar__glass--empty"><span class="rack-jar__plus">+</span></span>';
        }
        slotsEl.appendChild(b);
      }
      updateBar();
    }

    function renderSummary() {
      var box = $('[data-rack-summary]', root);
      var counts = {};
      state.slots.forEach(function (id) { if (id) counts[id] = (counts[id] || 0) + 1; });
      var html = '<div class="rack-summary__row rack-summary__row--model"><span>' + esc(state.model.title) + '</span><b>' + money(state.model.price) + '</b></div>';
      Object.keys(counts).forEach(function (id) {
        var s = spiceById[id];
        html += '<div class="rack-summary__row"><span>' + esc(s.title) + (counts[id] > 1 ? ' × ' + counts[id] : '') + (s.premium ? ' <em>★ especial</em>' : '') + '</span><b>' + money(s.price * counts[id]) + '</b></div>';
      });
      if (engraving()) html += '<div class="rack-summary__row"><span>Grabado: “' + esc(engText.value.trim()) + '”</span><b>' + money(data.engrave.price) + '</b></div>';
      html += '<div class="rack-summary__row rack-summary__row--total"><span>Total</span><b>' + money(total()) + '</b></div>';
      box.innerHTML = html;
    }

    function selectModel(id) {
      var m = data.models.filter(function (x) { return String(x.id) === String(id); })[0];
      if (!m) return;
      var prev = state.slots.slice(0, m.slots);
      state.model = m;
      state.slots = [];
      for (var i = 0; i < m.slots; i++) state.slots.push(prev[i] || null);
      state.active = state.slots.indexOf(null);
      if (state.active < 0) state.active = 0;
      renderSlots();
      setStep(2);
    }

    /* ----- selector de especias ----- */
    function chipsList() {
      var chips = [{ k: '', t: 'Todas' }, { k: '__hot', t: 'Picantes' }, { k: '__premium', t: 'Especiales' }];
      var seen = {};
      ['África', 'Asia', 'Europa', 'América', 'Medio Oriente'].forEach(function (r) {
        var has = data.spices.some(function (s) { return s.tags.indexOf(r) > -1; });
        if (has && !seen[r]) { seen[r] = 1; chips.push({ k: r, t: r }); }
      });
      return chips;
    }
    function renderChips() {
      var el = $('[data-picker-chips]', root);
      el.innerHTML = chipsList().map(function (c) {
        return '<button type="button" class="category-chip' + (state.filter === c.k ? ' is-active' : '') + '" data-chip="' + esc(c.k) + '">' + esc(c.t) + '</button>';
      }).join('');
    }
    function renderGrid() {
      var q = state.query.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      var list = data.spices.filter(function (s) {
        var t = s.title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        if (q && t.indexOf(q) === -1) return false;
        if (state.filter === '__hot') return s.hot;
        if (state.filter === '__premium') return s.premium;
        if (state.filter) return s.tags.indexOf(state.filter) > -1;
        return true;
      });
      var grid = $('[data-picker-grid]', root);
      if (!list.length) { grid.innerHTML = '<p class="rack-empty">No encontramos esa especia.</p>'; return; }
      grid.innerHTML = list.map(function (s) {
        var thumb = s.image ? '<img src="' + esc(s.image) + '" alt="" loading="lazy">' : '<span style="--h:' + hue(s.handle) + '">' + esc(s.title.charAt(0)) + '</span>';
        return '<button type="button" class="rack-spice" data-pick="' + s.id + '"><i class="rack-spice__thumb">' + thumb + '</i><b>' + esc(s.title) + '</b><small>' + money(s.price) + (s.premium ? ' · ★ especial' : '') + (s.hot ? ' · 🌶' : '') + '</small></button>';
      }).join('');
    }
    function openPicker(slot) {
      state.active = slot;
      state.filter = ''; state.query = '';
      $('[data-picker-search]', root).value = '';
      $('[data-picker-title]', root).textContent = 'Frasco ' + (slot + 1) + ' de ' + state.model.slots;
      renderChips(); renderGrid();
      picker.hidden = false;
      document.body.classList.add('is-locked');
    }
    function closePicker() { picker.hidden = true; document.body.classList.remove('is-locked'); }

    function pick(id) {
      state.slots[state.active] = Number(id);
      var nx = state.slots.indexOf(null);
      state.active = nx > -1 ? nx : state.active;
      closePicker();
      renderSlots();
    }

    function surprise() {
      var pool = data.spices.slice();
      for (var i = pool.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
      for (var k = 0; k < state.slots.length; k++) if (!state.slots[k]) state.slots[k] = (pool.shift() || data.spices[0]).id;
      renderSlots();
    }
    function applyKit(list) {
      var handles = list.split(',').map(function (h) { return h.trim(); }).filter(Boolean);
      var found = handles.map(function (h) { return spiceByHandle[h]; }).filter(Boolean);
      if (!found.length) return;
      for (var i = 0; i < state.slots.length; i++) state.slots[i] = found[i % found.length].id;
      renderSlots();
    }

    function addToCart() {
      var bundle = 'esp-' + Date.now().toString(36);
      var counts = {};
      state.slots.forEach(function (id) { if (id) counts[id] = (counts[id] || 0) + 1; });
      var names = Object.keys(counts).map(function (id) { return spiceById[id].title + (counts[id] > 1 ? ' ×' + counts[id] : ''); }).join(', ');
      var modelProps = { '_bundle': bundle, 'Frascos': names };
      var items = [{ id: state.model.variant, quantity: 1, properties: modelProps }];
      if (engraving()) {
        modelProps['Grabado'] = engText.value.trim();
        items.push({ id: data.engrave.variant, quantity: 1, properties: { '_bundle': bundle, 'Grabado para': state.model.title } });
      }
      Object.keys(counts).forEach(function (id) {
        items.push({ id: spiceById[id].variant, quantity: counts[id], properties: { '_bundle': bundle, 'En': state.model.title } });
      });
      nextBtn.disabled = true; nextBtn.textContent = 'Agregando…';
      fetch('/cart/add.js', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ items: items }) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.description || j.message || 'No se pudo agregar'); return j; }); })
        .then(function () { window.location.href = root.getAttribute('data-cart-url') || '/cart'; })
        .catch(function (e) { alert(e.message || 'No se pudo agregar al carrito'); updateBar(); });
    }

    root.addEventListener('click', function (e) {
      var t = e.target;
      var m = t.closest('[data-model]'); if (m) { selectModel(m.getAttribute('data-model')); return; }
      var go = t.closest('[data-go]'); if (go) { setStep(Number(go.getAttribute('data-go'))); return; }
      var clr = t.closest('[data-slot-clear]');
      if (clr) { e.stopPropagation(); var ci = Number(clr.getAttribute('data-slot-clear')); state.slots[ci] = null; state.active = ci; renderSlots(); return; }
      var slot = t.closest('[data-slot]'); if (slot) { openPicker(Number(slot.getAttribute('data-slot'))); return; }
      if (t.closest('[data-picker-close]')) { closePicker(); return; }
      var chip = t.closest('[data-chip]'); if (chip) { state.filter = chip.getAttribute('data-chip'); renderChips(); renderGrid(); return; }
      var pk = t.closest('[data-pick]'); if (pk) { pick(pk.getAttribute('data-pick')); return; }
      if (t.closest('[data-surprise]')) { surprise(); return; }
      var kit = t.closest('[data-kit]'); if (kit) { applyKit(kit.getAttribute('data-kit')); return; }
      if (t.closest('[data-rack-next]')) {
        if (state.step === 2) { renderSummary(); setStep(3); }
        else if (state.step === 3) addToCart();
      }
    });
    $('[data-picker-search]', root).addEventListener('input', function (e) { state.query = e.target.value; renderGrid(); });
    if (engToggle) engToggle.addEventListener('change', function () { engText.hidden = !engToggle.checked; renderSummary(); updateBar(); });
    if (engText) engText.addEventListener('input', function () { renderSummary(); updateBar(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !picker.hidden) closePicker(); });
  }

  function boot() { $$('[data-rack]').forEach(init); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  document.addEventListener('shopify:section:load', boot);
})();
