/* Blog de recetas y vlog: página, receta y ventana emergente */
(function () {
  'use strict';
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

  /* ---------- Página del blog (pestañas y filtros) ---------- */
  function initBlog(root, url) {
    if (!root || root._blg) return; root._blg = true;
    var inModal = !!root.closest('[data-bmodal]');
    function tab(name) {
      $$('[data-blog-tab]', root).forEach(function (b) { var on = b.getAttribute('data-blog-tab') === name; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
      $$('[data-blog-panel]', root).forEach(function (p) { var on = p.getAttribute('data-blog-panel') === name; p.hidden = !on; if (on) { p.classList.remove('is-on'); void p.offsetWidth; p.classList.add('is-on'); } });
      if (!inModal) { try { var u = new URL(location.href); u.searchParams.set('tab', name); history.replaceState({}, '', u); } catch (e) {} }
    }
    root.addEventListener('click', function (e) {
      var t = e.target.closest('[data-blog-tab]'); if (t) { tab(t.getAttribute('data-blog-tab')); return; }
      var c = e.target.closest('[data-blog-tag]');
      if (c) {
        var tag = c.getAttribute('data-blog-tag'), shown = 0;
        $$('[data-blog-tag]', root).forEach(function (b) { b.classList.toggle('is-on', b === c); });
        $$('[data-blog-item]', root).forEach(function (it) { var ok = !tag || (it.getAttribute('data-tags') || '').split('|').indexOf(tag) > -1; it.hidden = !ok; if (ok) shown++; });
        var none = $('[data-blog-none]', root); if (none) none.hidden = shown > 0;
      }
    });
    var q = null; try { q = new URL(url || location.href, location.origin).searchParams.get('tab'); } catch (e) {}
    tab(q && $('[data-blog-panel="' + q + '"]', root) ? q : ($('.blg-vids', root) ? 'videos' : 'recetas'));
  }

  /* ---------- Receta (pasos, porciones, ingredientes al carrito, compartir) ---------- */
  function parseQ(s) {
    var m = String(s).trim().match(/^(\d+)\s+(\d+)\/(\d+)|^(\d+)\/(\d+)|^(\d+(?:[.,]\d+)?)/);
    if (!m) return null;
    var n = m[1] ? +m[1] + m[2] / m[3] : m[4] ? m[4] / m[5] : parseFloat(m[6].replace(',', '.'));
    return { n: n, rest: String(s).trim().slice(m[0].length) };
  }
  function fmtQ(n) {
    if (n >= 10) return String(Math.round(n));
    var w = Math.floor(n), f = n - w;
    var fr = [[0, ''], [0.25, '1/4'], [1 / 3, '1/3'], [0.5, '1/2'], [2 / 3, '2/3'], [0.75, '3/4'], [1, '']];
    var best = fr.reduce(function (a, b) { return Math.abs(b[0] - f) < Math.abs(a[0] - f) ? b : a; });
    if (Math.abs(best[0] - f) > 0.12) return (Math.round(n * 10) / 10).toString().replace('.', ',');
    if (best[0] === 1) { w += 1; best = [0, '']; }
    return ((w ? String(w) : '') + (w && best[1] ? ' ' : '') + best[1]) || '0';
  }
  function initRecipe(root) {
    if (!root || root._rcp) return; root._rcp = true;
    var key = 'tramo_steps_' + root.getAttribute('data-recipe');
    var done = {}; try { done = JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) {}
    $$('[data-step]', root).forEach(function (c) {
      c.checked = !!done[c.getAttribute('data-step')];
      c.addEventListener('change', function () { done[c.getAttribute('data-step')] = c.checked; try { localStorage.setItem(key, JSON.stringify(done)); } catch (e) {} });
    });
    var base = parseInt(root.getAttribute('data-servings'), 10) || 0, cur = base;
    function scale() {
      $$('[data-qty]', root).forEach(function (el) {
        var q = parseQ(el.getAttribute('data-qty'));
        el.textContent = q && base ? fmtQ(q.n * cur / base) + q.rest : el.getAttribute('data-qty');
      });
      var n = $('[data-serv-n]', root); if (n) n.textContent = cur;
    }
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-serv]');
      if (b && base) { cur = Math.max(1, Math.min(base * 6, cur + Number(b.getAttribute('data-serv')))); scale(); }
      var sh = e.target.closest('[data-recipe-share]');
      if (sh) {
        var data = { title: sh.getAttribute('data-share-title'), url: sh.getAttribute('data-share-url') };
        if (navigator.share) navigator.share(data).catch(function () {});
        else if (navigator.clipboard) navigator.clipboard.writeText(data.url).then(function () { var s = $('span', sh); var t = s.textContent; s.textContent = '¡Enlace copiado!'; setTimeout(function () { s.textContent = t; }, 1600); });
      }
    });
    var shop = $('[data-recipe-shop]', root);
    if (!shop) return;
    var fmtM = new Intl.NumberFormat('es-CR', { style: 'currency', currency: root.getAttribute('data-currency') || 'CRC', maximumFractionDigits: 0 });
    var totalEl = $('[data-shop-total]', shop), btn = $('[data-shop-add]', shop);
    function total() {
      var t = 0, n = 0;
      $$('[data-shop-item]', shop).forEach(function (c) { if (c.checked) { t += +c.getAttribute('data-price'); n++; } });
      totalEl.textContent = fmtM.format(t / 100); btn.disabled = n === 0;
    }
    shop.addEventListener('change', total); total();
    btn.addEventListener('click', function () {
      var items = [];
      $$('[data-shop-item]', shop).forEach(function (c) { if (c.checked) items.push({ id: +c.value, quantity: 1, properties: { 'Receta': root.getAttribute('data-title') || '' } }); });
      if (!items.length) return;
      var t = btn.innerHTML; btn.disabled = true; btn.textContent = 'Agregando…';
      fetch('/cart/add.js', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ items: items }) })
        .then(function (r) { if (!r.ok) throw new Error(); var m = root.closest('[data-bmodal]'); if (m) closeModal(); document.dispatchEvent(new CustomEvent('tramo:open-cart')); })
        .catch(function () { alert('No se pudieron agregar. Intenta de nuevo.'); })
        .then(function () { btn.innerHTML = t; total(); });
    });
  }

  function initAll(scope, url) {
    $$('[data-blog]', scope).forEach(function (r) { initBlog(r, url); });
    $$('[data-recipe]', scope).forEach(initRecipe);
    /* corazones guardados al día */
    document.dispatchEvent(new CustomEvent('tramo:recipes-sync'));
  }

  /* ---------- Ventana emergente ---------- */
  var modal, body, backBtn, titleEl, stack = [], cache = {};
  function els() { modal = modal || $('[data-bmodal]'); if (modal) { body = $('[data-bmodal-body]', modal); backBtn = $('[data-bmodal-back]', modal); titleEl = $('[data-bmodal-title]', modal); } return modal; }
  function isBlogUrl(href) {
    try { var u = new URL(href, location.origin); return u.origin === location.origin && /^\/blogs\/recetas(\/|$|\?)/.test(u.pathname + (u.search ? '?' : '')); } catch (e) { return false; }
  }
  function openModal() {
    if (!els()) return false;
    if (modal.hidden) {
      modal.hidden = false;
      document.body.classList.add('is-locked', 'is-bmodal');
      requestAnimationFrame(function () { modal.classList.add('is-open'); });
    }
    return true;
  }
  function closeModal() {
    if (!els() || modal.hidden) return;
    modal.classList.remove('is-open');
    document.body.classList.remove('is-bmodal');
    if (!document.querySelector('.drawer.is-open')) document.body.classList.remove('is-locked');
    $$('video', body).forEach(function (v) { v.pause(); });
    setTimeout(function () { modal.hidden = true; body.innerHTML = ''; stack = []; }, 280);
  }
  function load(url, push) {
    if (!openModal()) { location.href = url; return; }
    if (push !== false) stack.push(url);
    backBtn.hidden = stack.length < 2;
    var isArticle = /^\/blogs\/recetas\/[^/?]+/.test(new URL(url, location.origin).pathname);
    titleEl.textContent = isArticle ? '' : 'Recetas y vlog';
    body.innerHTML = '<div class="bmodal__loading"><span></span><span></span><span></span></div>';
    body.scrollTop = 0;
    var p = cache[url] ? Promise.resolve(cache[url]) : fetch(url, { headers: { Accept: 'text/html' } }).then(function (r) { if (!r.ok) throw new Error(); return r.text(); }).then(function (h) { cache[url] = h; return h; });
    p.then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var node = $('[data-recipe]', doc) || $('[data-blog]', doc);
      if (!node) throw new Error('sin contenido');
      body.innerHTML = '';
      body.appendChild(document.importNode(node, true));
      if (isArticle) { var h = $('.rcp__title', body); titleEl.textContent = h ? h.textContent : ''; }
      initAll(body, url);
      body.scrollTop = 0;
    }).catch(function () { location.href = url; });
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[href]');
    if (a && !a.target && isBlogUrl(a.getAttribute('href')) && els()) {
      /* En la página del blog (sin ventana abierta) se navega normal */
      var onBlogPage = /^\/blogs\/recetas/.test(location.pathname) && !a.closest('[data-bmodal]');
      if (onBlogPage) return;
      e.preventDefault();
      var href = a.getAttribute('href');
      var dr = document.querySelector('.drawer.is-open');
      if (dr && !a.closest('[data-bmodal]')) { var cb = dr.querySelector('[data-drawer-close]'); if (cb) cb.click(); }
      load(href);
      return;
    }
    if (e.target.closest('[data-bmodal-close]')) { closeModal(); return; }
    if (e.target.closest('[data-bmodal-back]')) { stack.pop(); var prev = stack[stack.length - 1]; if (prev) load(prev, false); return; }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && els() && !modal.hidden && !document.querySelector('.drawer.is-open')) closeModal();
  });

  function boot() { initAll(document); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.TramoBlog = { open: load, close: closeModal };
})();
