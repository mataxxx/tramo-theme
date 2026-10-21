/* ==========================================================================
   Tramo — JavaScript del tema (sin dependencias)
   - Paneles (menú, carrito, búsqueda, videos, vista rápida)
   - Carrito AJAX con soporte de venta a granel (gramos)
   - Selector de variantes y cantidad
   - Búsqueda global y por categoría
   - Videos tipo reel
   ========================================================================== */
(function () {
  'use strict';

  var T = window.TRAMO || {};
  var BULK = T.bulk || { name: 'A granel', unit: 10, min: 250, step: 50 };
  var ROOT = (T.routes && T.routes.root) || '/';

  /* ---------- Utilidades ------------------------------------------------ */
  function $(selector, scope) { return (scope || document).querySelector(selector); }
  function $$(selector, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(selector)); }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function debounce(fn, wait) {
    var timer;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }

  function formatMoney(cents, format) {
    var formatString = format || T.moneyFormat || '{{amount}}';
    var placeholder = /\{\{\s*(\w+)\s*\}\}/;
    var match = formatString.match(placeholder);
    if (!match) return String(cents);

    function withDelimiters(number, precision, thousands, decimal) {
      precision = typeof precision === 'undefined' ? 2 : precision;
      thousands = typeof thousands === 'undefined' ? ',' : thousands;
      decimal = typeof decimal === 'undefined' ? '.' : decimal;
      if (isNaN(number) || number == null) return '0';
      var fixed = (number / 100).toFixed(precision).split('.');
      var whole = fixed[0].replace(/(\d)(?=(\d\d\d)+(?!\d))/g, '$1' + thousands);
      return whole + (fixed[1] ? decimal + fixed[1] : '');
    }

    var value;
    switch (match[1]) {
      case 'amount_no_decimals': value = withDelimiters(cents, 0); break;
      case 'amount_with_comma_separator': value = withDelimiters(cents, 2, '.', ','); break;
      case 'amount_no_decimals_with_comma_separator': value = withDelimiters(cents, 0, '.', ','); break;
      case 'amount_no_decimals_with_space_separator': value = withDelimiters(cents, 0, ' '); break;
      case 'amount_with_space_separator': value = withDelimiters(cents, 2, ' ', ','); break;
      case 'amount_with_apostrophe_separator': value = withDelimiters(cents, 2, "'", '.'); break;
      default: value = withDelimiters(cents, 2);
    }
    return formatString.replace(placeholder, value);
  }

  function parseJSON(response) {
    return response.json().then(function (data) {
      if (!response.ok) {
        var error = new Error(data.description || data.message || 'Error');
        error.data = data;
        throw error;
      }
      return data;
    });
  }

  function showToast(message) {
    var toast = $('[data-toast]');
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { toast.hidden = true; }, 3200);
  }

  /* ---------- Paneles --------------------------------------------------- */
  var lastFocus = null;

  function openDrawers() {
    return $$('.drawer.is-open');
  }

  function pauseProductVideos() {
    $$('.pvideo__video').forEach(function (v) { v.pause(); var box = v.closest('[data-pvideo]'); if (box) box.classList.remove('is-playing'); });
  }

  function closeDrawer(drawer, keepFocus) {
    if (!drawer || drawer.hidden) return;
    drawer.classList.remove('is-open');
    setTimeout(function () {
      if (!drawer.classList.contains('is-open')) drawer.hidden = true;
    }, 280);
    if (drawer.getAttribute('data-drawer') === 'reels') pauseAllReels();
    if (drawer.getAttribute('data-drawer') === 'quick-view') pauseProductVideos();
    if (!openDrawers().filter(function (d) { return d !== drawer; }).length) {
      document.body.classList.remove('is-locked');
    }
    if (!keepFocus && lastFocus && document.contains(lastFocus)) {
      try { lastFocus.focus(); } catch (e) { /* noop */ }
    }
  }

  function closeAllDrawers(keepFocus) {
    openDrawers().forEach(function (d) { closeDrawer(d, keepFocus); });
  }

  function openDrawer(name, opts) {
    var drawer = $('[data-drawer="' + name + '"]');
    if (!drawer) return null;
    if (!drawer.classList.contains('is-open')) {
      lastFocus = document.activeElement;
      openDrawers().forEach(function (d) { if (d !== drawer) closeDrawer(d, true); });
      drawer.hidden = false;
      document.body.classList.add('is-locked');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { drawer.classList.add('is-open'); });
      });
      setTimeout(function () {
        var target = $('[data-search-input]', drawer) || $('.close-button, [data-drawer-close]:not(.drawer__backdrop)', drawer);
        if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
      }, 60);
      if (name === 'reels') { setReelsView(opts && opts.view); startReels(); }
    }
    return drawer;
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && event.target.matches && event.target.matches('[data-line-qty], [data-line-grams]')) {
      event.preventDefault();
      event.target.blur();
      return;
    }
    var open = openDrawers();
    if (!open.length) return;
    if (event.key === 'Escape') {
      closeDrawer(open[open.length - 1]);
      return;
    }
    if (event.key === 'Tab') {
      var drawer = open[open.length - 1];
      var focusable = $$('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])', drawer)
        .filter(function (el) { return el.offsetParent !== null; });
      if (!focusable.length) return;
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });

  /* ---------- Carrito --------------------------------------------------- */
  function updateCount(count) {
    $$('[data-cart-count]').forEach(function (el) {
      el.textContent = count;
      el.hidden = !count;
    });
  }

  function refreshCart() {
    return Promise.all([
      fetch(T.routes.cartJson, { headers: { Accept: 'application/json' } }).then(parseJSON),
      fetch(ROOT + '?sections=cart-drawer').then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
    ]).then(function (results) {
      var cart = results[0];
      var sections = results[1] || {};
      updateCount(cart.item_count);
      if (sections['cart-drawer']) {
        var doc = new DOMParser().parseFromString(sections['cart-drawer'], 'text/html');
        var fresh = $('[data-cart-drawer-body]', doc);
        var current = $('[data-cart-drawer-body]');
        if (fresh && current) current.innerHTML = fresh.innerHTML;
      }
      return cart;
    });
  }

  function addToCart(variantId, quantity) {
    return fetch(T.routes.cartAdd, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ id: variantId, quantity: quantity })
    }).then(parseJSON);
  }

  function openCartView() {
    var drawer = $('[data-drawer="cart"]');
    if (T.cartDrawer === 'drawer' && drawer) {
      openDrawer('cart');
    } else {
      window.location.href = T.routes.cart;
    }
  }

  function showAddedPopup(item) {
    var box = $('[data-added-item]');
    if (!box) return false;
    var isBulk = item.variant_options && item.variant_options.indexOf(BULK.name) > -1;
    var detail = isBulk ? BULK.name + ' · ' + (item.quantity * BULK.unit) + ' g'
      : (item.variant_title ? item.variant_title + (item.quantity > 1 ? ' · x' + item.quantity : '') : (item.quantity > 1 ? 'x' + item.quantity : ''));
    var img = item.image ? sizedImage(item.image, 160) : '';
    box.innerHTML =
      '<span class="added-popup__img">' + (img ? '<img src="' + esc(img) + '" alt="" width="80" height="80">' : '') + '</span>' +
      '<span class="added-popup__info"><strong>' + esc(item.product_title || item.title) + '</strong>' +
      (detail ? '<small>' + esc(detail) + '</small>' : '') +
      '<span class="added-popup__price">' + formatMoney(item.final_line_price != null ? item.final_line_price : item.line_price) + '</span></span>';
    openDrawer('added');
    return true;
  }

  function afterAdd(item) {
    return refreshCart().then(function () {
      if (T.cartPopup && item && showAddedPopup(item)) return;
      openCartView();
    });
  }

  function changeLine(lineEl, quantity) {
    var key = lineEl.getAttribute('data-cart-line');
    lineEl.classList.add('is-updating');
    var onCartPage = !!$('[data-cart-page]');
    fetch(T.routes.cartChange, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ id: key, quantity: quantity })
    })
      .then(parseJSON)
      .then(function () { return onCartPage ? window.location.reload() : refreshCart(); })
      .catch(function (error) {
        showToast(error.message || 'No se pudo actualizar el carrito');
        if (onCartPage) window.location.reload(); else refreshCart();
      });
  }

  function roundToUnit(grams) {
    var unit = BULK.unit || 10;
    var value = Math.round((parseInt(grams, 10) || BULK.min) / unit) * unit;
    return Math.max(BULK.min, value);
  }

  function handleLineEvent(event) {
    var lineEl = event.target.closest && event.target.closest('[data-cart-line]');
    if (!lineEl) return false;
    var target = event.target;
    var isBulk = lineEl.hasAttribute('data-bulk');
    var qtyInput = $('[data-line-qty]', lineEl);
    var gramsInput = $('[data-line-grams]', lineEl);

    if (event.type === 'click') {
      var btn = target.closest('button');
      if (!btn) return false;
      if (btn.hasAttribute('data-line-remove')) { changeLine(lineEl, 0); return true; }
      if (btn.hasAttribute('data-line-minus')) { changeLine(lineEl, Math.max(0, (parseInt(qtyInput.value, 10) || 1) - 1)); return true; }
      if (btn.hasAttribute('data-line-plus')) { changeLine(lineEl, (parseInt(qtyInput.value, 10) || 0) + 1); return true; }
      if (btn.hasAttribute('data-line-bulk-minus') || btn.hasAttribute('data-line-bulk-plus')) {
        var current = parseInt(gramsInput.value, 10) || BULK.min;
        var next = btn.hasAttribute('data-line-bulk-plus') ? current + BULK.step : current - BULK.step;
        changeLine(lineEl, roundToUnit(next) / BULK.unit);
        return true;
      }
    } else if (event.type === 'change') {
      if (isBulk && target === gramsInput) { changeLine(lineEl, roundToUnit(gramsInput.value) / BULK.unit); return true; }
      if (!isBulk && target === qtyInput) { changeLine(lineEl, Math.max(0, parseInt(qtyInput.value, 10) || 0)); return true; }
    }
    return false;
  }

  /* ---------- Vista rápida --------------------------------------------- */
  var quickCache = {};

  function openQuickView(url) {
    var drawer = openDrawer('quick-view');
    var body = $('[data-quick-view-body]');
    if (!drawer || !body) { window.location.href = url; return; }

    function render(html) {
      body.innerHTML = html;
      var panel = body.parentElement;
      if (panel) panel.scrollTop = 0;
      initProducts(body);
    }

    if (quickCache[url]) { render(quickCache[url]); return; }

    body.innerHTML = '<p class="quick-view__loading">Cargando…</p>';
    var join = url.indexOf('?') > -1 ? '&' : '?';
    fetch(url + join + 'view=quick')
      .then(function (r) { if (!r.ok) throw new Error('quick view'); return r.text(); })
      .then(function (html) {
        if (html.indexOf('data-product-root') === -1) throw new Error('quick view');
        quickCache[url] = html;
        render(html);
      })
      .catch(function () { window.location.href = url; });
  }

  /* ---------- Producto: variantes, granel y compra -------------------- */
  function initProducts(scope) {
    $$('[data-product-root]', scope || document).forEach(initProduct);
  }

  function initProduct(root) {
    if (!root || root._tramoInit) return;
    var jsonEl = $('[data-product-json]', root);
    var form = $('form[data-product-form]', root);
    if (!jsonEl || !form) return;
    root._tramoInit = true;

    var data = JSON.parse(jsonEl.textContent);
    var variants = data.variants;
    var idInput = $('[data-variant-id]', form);
    var qtyField = $('[data-quantity-field]', form);
    var addButton = $('[data-add-button]', form);
    var addLabel = $('[data-add-label]', form);
    var addPrice = $('[data-add-price]', form);
    var errorEl = $('[data-form-error]', form);
    var normalWrap = $('[data-qty-normal]', root);
    var bulkWrap = $('[data-qty-bulk]', root);
    var qtyInput = $('[data-qty-input]', root);
    var bulkInput = $('[data-bulk-input]', root);
    var bulkKg = $('[data-bulk-kg]', root);
    var priceEl = $('[data-price]', root);
    var groups = $$('.variant-picker__group', root);
    var inQuickView = !!root.closest('#QuickView');
    var defaultLabel = addLabel ? addLabel.textContent.trim() : 'Agregar al carrito';
    if (!/\S/.test(defaultLabel) || defaultLabel === 'Agotado') defaultLabel = 'Agregar al carrito';

    function selectedOptions() {
      return groups.map(function (group) {
        var checked = $('input:checked', group);
        return checked ? checked.value : null;
      });
    }

    function findVariant(options) {
      if (!groups.length) return variants[0];
      for (var i = 0; i < variants.length; i++) {
        var match = true;
        for (var j = 0; j < options.length; j++) {
          if (variants[i].options[j] !== options[j]) { match = false; break; }
        }
        if (match) return variants[i];
      }
      return null;
    }

    function markAvailability(options) {
      groups.forEach(function (group, index) {
        $$('input', group).forEach(function (input) {
          var candidate = options.slice();
          candidate[index] = input.value;
          var variant = findVariant(candidate);
          input.classList.toggle('is-unavailable', !variant || !variant.available);
        });
      });
    }

    function currentQuantity(variant) {
      if (variant && variant.bulk) {
        var grams = roundToUnit(bulkInput ? bulkInput.value : BULK.min);
        return grams / BULK.unit;
      }
      return Math.max(1, parseInt(qtyInput ? qtyInput.value : 1, 10) || 1);
    }

    function renderPrice(variant) {
      if (!priceEl || !variant) return;
      var html = '';
      if (variant.compare_at_price > variant.price) {
        html += '<s class="price__compare" data-price-compare>' + formatMoney(variant.compare_at_price) + '</s>';
      }
      html += '<strong class="price__current" data-price-current>' + formatMoney(variant.price) + '</strong>';
      if (variant.bulk) html += '<span class="price__unit">/ ' + BULK.unit + ' g</span>';
      priceEl.innerHTML = html;
      priceEl.classList.toggle('price--sale', variant.compare_at_price > variant.price);
    }

    function scrollToMedia(variant) {
      if (!variant || !variant.media_id) return;
      var strip = $('[data-gallery-strip]', root);
      var slide = strip && $('[data-media-id="' + variant.media_id + '"]', strip);
      if (strip && slide) strip.scrollTo({ left: slide.offsetLeft - strip.offsetLeft, behavior: 'smooth' });
    }

    function update(fromUser) {
      var options = selectedOptions();
      var variant = findVariant(options);
      if (errorEl) errorEl.hidden = true;
      markAvailability(options);

      var isBulk = !!(variant && variant.bulk);
      if (normalWrap) normalWrap.hidden = isBulk;
      if (bulkWrap) bulkWrap.hidden = !isBulk;

      if (!variant || !variant.available) {
        if (idInput) { idInput.disabled = true; if (variant) idInput.value = variant.id; }
        if (addButton) addButton.disabled = true;
        if (addLabel) addLabel.textContent = variant ? 'Agotado' : 'No disponible';
        if (addPrice) addPrice.textContent = '';
        if (variant) renderPrice(variant);
        return;
      }

      var quantity = currentQuantity(variant);
      if (idInput) { idInput.disabled = false; idInput.value = variant.id; }
      if (qtyField) qtyField.value = quantity;
      if (addButton) addButton.disabled = false;
      if (addLabel) addLabel.textContent = defaultLabel;
      if (addPrice) addPrice.textContent = '· ' + formatMoney(variant.price * quantity);
      if (bulkKg) bulkKg.textContent = isBulk ? ' · precio por kilo ' + formatMoney(variant.price * (1000 / BULK.unit)) : '';
      renderPrice(variant);

      if (fromUser) {
        scrollToMedia(variant);
        if (!inQuickView && window.history && window.history.replaceState) {
          var url = new URL(window.location.href);
          url.searchParams.set('variant', variant.id);
          window.history.replaceState({}, '', url.toString());
        }
      }
    }

    root.addEventListener('change', function (event) {
      if (event.target.matches('[data-option-value]')) update(true);
      else if (event.target === qtyInput) {
        qtyInput.value = Math.max(1, parseInt(qtyInput.value, 10) || 1);
        update(false);
      } else if (event.target === bulkInput) {
        bulkInput.value = roundToUnit(bulkInput.value);
        update(false);
      }
    });

    root.addEventListener('click', function (event) {
      var btn = event.target.closest('button');
      if (!btn || !root.contains(btn)) return;
      if (btn.hasAttribute('data-qty-minus')) {
        qtyInput.value = Math.max(1, (parseInt(qtyInput.value, 10) || 1) - 1); update(false);
      } else if (btn.hasAttribute('data-qty-plus')) {
        qtyInput.value = (parseInt(qtyInput.value, 10) || 1) + 1; update(false);
      } else if (btn.hasAttribute('data-bulk-minus')) {
        bulkInput.value = roundToUnit((parseInt(bulkInput.value, 10) || BULK.min) - BULK.step); update(false);
      } else if (btn.hasAttribute('data-bulk-plus')) {
        bulkInput.value = roundToUnit((parseInt(bulkInput.value, 10) || BULK.min) + BULK.step); update(false);
      } else if (btn.hasAttribute('data-thumb')) {
        var strip = $('[data-gallery-strip]', root);
        var slide = strip && $('[data-media-id="' + btn.getAttribute('data-thumb') + '"]', strip);
        if (strip && slide) strip.scrollTo({ left: slide.offsetLeft - strip.offsetLeft, behavior: 'smooth' });
        $$('[data-thumb]', root).forEach(function (t) { t.classList.toggle('is-active', t === btn); });
      }
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (!addButton || addButton.disabled || !idInput) return;
      var variant = findVariant(selectedOptions());
      var quantity = currentQuantity(variant);
      addButton.disabled = true;
      addButton.setAttribute('aria-busy', 'true');
      addToCart(parseInt(idInput.value, 10), quantity)
        .then(function (item) {
          if (inQuickView) closeDrawer($('[data-drawer="quick-view"]'), true);
          return afterAdd(item);
        })
        .catch(function (error) {
          if (errorEl) { errorEl.textContent = error.message || 'No se pudo agregar al carrito'; errorEl.hidden = false; }
        })
        .then(function () {
          addButton.disabled = false;
          addButton.removeAttribute('aria-busy');
        });
    });

    update(false);
  }

  /* ---------- Búsqueda -------------------------------------------------- */
  var search = { scope: null, items: [], sort: 'default', lastQuery: '' };

  function searchEls() {
    var panel = $('[data-search-panel]');
    if (!panel) return null;
    return {
      panel: panel,
      title: $('[data-search-heading]', panel),
      input: $('[data-search-input]', panel),
      global: $('[data-search-global]', panel),
      sort: $('[data-search-sort]', panel),
      results: $('[data-search-results]', panel)
    };
  }

  function toCents(value) {
    var n = parseFloat(value);
    return isNaN(n) ? 0 : Math.round(n * 100);
  }

  function resultHTML(item) {
    return '<a class="search-result" href="' + esc(item.url) + '" data-quick-view="' + esc(item.url) + '">' +
      '<span class="search-result__img">' + (item.image ? '<img src="' + esc(item.image) + '" alt="" loading="lazy" width="64" height="56">' : '') + '</span>' +
      '<span class="search-result__body"><strong>' + esc(item.title) + '</strong><small>' + esc(item.sub) + '</small></span>' +
      '</a>';
  }

  function sizedImage(src, width) {
    if (!src) return '';
    return src + (src.indexOf('?') > -1 ? '&' : '?') + 'width=' + width;
  }

  function renderScopedResults() {
    var els = searchEls();
    if (!els) return;
    var query = (els.input.value || '').trim().toLowerCase();
    var list = search.items.filter(function (item) { return !query || item.title.toLowerCase().indexOf(query) > -1; });
    if (search.sort === 'title') list = list.slice().sort(function (a, b) { return a.title.localeCompare(b.title, 'es'); });
    if (search.sort === 'price') list = list.slice().sort(function (a, b) { return a.price - b.price; });
    els.results.innerHTML = list.length ? list.map(resultHTML).join('') : '<p class="search-empty">No encontramos productos con ese nombre.</p>';
  }

  function openSearch(scope) {
    var els = searchEls();
    if (!els) { window.location.href = T.routes.search; return; }
    search.scope = scope || null;
    search.items = [];
    search.sort = 'default';
    els.input.value = '';
    els.results.innerHTML = '';
    $$('[data-sort]', els.sort).forEach(function (b) { b.classList.toggle('is-active', b.getAttribute('data-sort') === 'default'); });

    if (scope) {
      els.title.textContent = scope.question || ('Buscar en ' + scope.title);
      els.input.placeholder = 'Escribe el nombre...';
      els.global.hidden = true;
      els.sort.hidden = false;
      els.results.innerHTML = '<p class="search-empty">Cargando…</p>';
      var base = ROOT.replace(/\/$/, '');
      fetch(base + '/collections/' + encodeURIComponent(scope.handle) + '/products.json?limit=250')
        .then(parseJSON)
        .then(function (data) {
          search.items = (data.products || []).map(function (p) {
            var normal = (p.variants || []).filter(function (v) { return [v.option1, v.option2, v.option3].indexOf(BULK.name) === -1; });
            var list = normal.length ? normal : (p.variants || []);
            var prices = list.map(function (v) { return toCents(v.price); });
            var min = prices.length ? Math.min.apply(null, prices) : 0;
            var max = prices.length ? Math.max.apply(null, prices) : 0;
            return {
              title: p.title,
              url: base + '/products/' + p.handle,
              image: sizedImage(p.images && p.images[0] && p.images[0].src, 160),
              price: min,
              sub: prices.length ? (min < max ? 'Desde ' : '') + formatMoney(min) : ''
            };
          });
          renderScopedResults();
        })
        .catch(function () { els.results.innerHTML = '<p class="search-empty">No se pudo cargar la categoría.</p>'; });
    } else {
      els.title.textContent = els.title.getAttribute('data-default-title') || els.title.textContent;
      els.global.hidden = false;
      els.sort.hidden = true;
    }
    openDrawer('search');
  }

  var runPredictive = debounce(function (query) {
    var els = searchEls();
    if (!els) return;
    if (query.length < 2) { els.results.innerHTML = ''; els.global.hidden = false; return; }
    els.global.hidden = true;
    fetch(T.routes.predictiveSearch + '?q=' + encodeURIComponent(query) + '&resources[type]=product&resources[limit]=8')
      .then(parseJSON)
      .then(function (data) {
        if (els.input.value.trim() !== query) return;
        var products = (data.resources && data.resources.results && data.resources.results.products) || [];
        var items = products.map(function (p) {
          var img = p.featured_image && p.featured_image.url || p.image || '';
          return {
            title: p.title,
            url: p.url,
            image: sizedImage(img, 160),
            sub: [p.type, p.vendor].filter(Boolean).join(' · ')
          };
        });
        els.results.innerHTML = items.length ? items.map(resultHTML).join('') : '<p class="search-empty">No encontramos resultados.</p>';
      })
      .catch(function () { els.results.innerHTML = '<p class="search-empty">No se pudo buscar. Intenta de nuevo.</p>'; });
  }, 250);

  document.addEventListener('input', function (event) {
    var els = searchEls();
    if (!els || event.target !== els.input) return;
    if (search.scope) renderScopedResults();
    else runPredictive(els.input.value.trim());
  });

  document.addEventListener('submit', function (event) {
    var form = event.target.closest && event.target.closest('[data-search-form]');
    if (form && search.scope) event.preventDefault();
  });

  /* ---------- Videos (reels) ------------------------------------------- */
  var reelObserver = null;

  function reelVideo(reel) { return $('video', reel); }

  function syncReelToggle(reel) {
    var video = reelVideo(reel);
    var pauseIcon = $('[data-icon-pause]', reel);
    var playIcon = $('[data-icon-play]', reel);
    if (!video || !pauseIcon || !playIcon) return;
    pauseIcon.hidden = video.paused;
    playIcon.hidden = !video.paused;
  }

  function pauseAllReels() {
    $$('[data-reel] video').forEach(function (v) { v.pause(); });
  }

  function reelsWrap() { return $('[data-reels-wrap]'); }

  function setReelsView(view, index) {
    var wrap = reelsWrap();
    if (!wrap) return;
    view = view === 'grid' || view === 'feed' ? view : (wrap.getAttribute('data-default-view') || 'feed');
    wrap.setAttribute('data-view', view);
    var grid = $('[data-reels-grid]', wrap);
    if (grid) grid.hidden = view !== 'grid';
    var feed = $('[data-reels]', wrap);
    if (view === 'grid') {
      pauseAllReels();
      if (grid) grid.scrollTop = 0;
    } else if (feed) {
      var reels = $$('[data-reel]', feed);
      var target = reels[index || 0];
      requestAnimationFrame(function () {
        if (target) feed.scrollTop = target.offsetTop;
        startReels();
      });
    }
  }

  function startReels() {
    var container = $('[data-reels]');
    if (!container) return;
    if (reelObserver) reelObserver.disconnect();
    if (!('IntersectionObserver' in window)) return;
    reelObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var video = reelVideo(entry.target);
        if (!video) return;
        if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
          var p = video.play();
          if (p && p.catch) p.catch(function () { /* autoplay bloqueado */ });
        } else {
          video.pause();
        }
        syncReelToggle(entry.target);
      });
    }, { root: container, threshold: [0, 0.6, 1] });
    $$('[data-reel]', container).forEach(function (reel) { reelObserver.observe(reel); });
  }

  /* ---------- Preguntas del producto (IA / WhatsApp) -------------------- */
  function waLink(box, question) {
    var text = 'Hola, quiero preguntar sobre ' + box.getAttribute('data-product-title') + (question ? ': ' + question : '');
    return 'https://wa.me/' + box.getAttribute('data-wa') + '?text=' + encodeURIComponent(text);
  }

  function askQuestion(box, question) {
    var answer = $('[data-ask-answer]', box);
    var endpoint = box.getAttribute('data-endpoint');
    var wa = box.getAttribute('data-wa');
    var link = $('[data-ask-wa]', box);
    if (link) link.href = waLink(box, question);
    if (!endpoint) {
      if (wa) { window.open(waLink(box, question), '_blank', 'noopener'); }
      else showToast('Pregunta no disponible por ahora');
      return;
    }
    answer.hidden = false;
    answer.className = 'ask__answer is-loading';
    answer.textContent = 'Pensando…';
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: question,
        product: {
          title: box.getAttribute('data-product-title'),
          handle: box.getAttribute('data-product-handle'),
          url: box.getAttribute('data-product-url'),
          description: box.getAttribute('data-product-desc')
        }
      })
    })
      .then(function (r) { if (!r.ok) throw new Error('x'); return r.json(); })
      .then(function (data) {
        answer.className = 'ask__answer';
        answer.textContent = data.answer || 'No pude encontrar una respuesta. Escríbenos por WhatsApp.';
      })
      .catch(function () {
        answer.className = 'ask__answer is-error';
        answer.textContent = 'No pude responder ahora. Puedes preguntarnos por WhatsApp.';
      });
  }

  document.addEventListener('submit', function (event) {
    var form = event.target.closest && event.target.closest('[data-ask-form]');
    if (!form) return;
    event.preventDefault();
    var q = form.elements.q.value.trim();
    if (q) askQuestion(form.closest('[data-ask]'), q);
  });

  /* ---------- Video del producto (vertical, tipo TikTok) ------------- */
  document.addEventListener('timeupdate', function (event) {
    var v = event.target;
    if (!v || !v.classList || !v.classList.contains('pvideo__video') || !v.duration) return;
    var bar = $('[data-pvideo-progress]', v.closest('[data-pvideo]'));
    if (bar) bar.style.width = (v.currentTime / v.duration * 100) + '%';
  }, true);

  function toggleProductVideo(box) {
    var v = $('.pvideo__video', box);
    if (!v) return;
    if (v.paused) {
      pauseProductVideos();
      var pr = v.play();
      if (pr && pr.catch) pr.catch(function () { /* el navegador lo bloqueó */ });
      box.classList.add('is-playing');
    } else {
      v.pause();
      box.classList.remove('is-playing');
    }
  }

  /* ---------- Combo ---------------------------------------------------- */
  function addCombo(box) {
    var btn = $('[data-combo-add]', box);
    var items = JSON.parse(box.getAttribute('data-combo-items'));
    var code = box.getAttribute('data-combo-code');
    btn.disabled = true;
    fetch(T.routes.cartAdd, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items: items })
    })
      .then(parseJSON)
      .then(function () { return code ? fetch('/discount/' + encodeURIComponent(code), { credentials: 'same-origin' }).catch(function () {}) : null; })
      .then(function () {
        return afterAdd({
          product_title: box.getAttribute('data-combo-title'),
          variant_title: box.getAttribute('data-combo-count') + ' productos',
          quantity: 1,
          final_line_price: parseInt(box.getAttribute('data-combo-final'), 10)
        });
      })
      .catch(function (error) { showToast(error.message || 'No se pudo agregar el combo'); })
      .then(function () { btn.disabled = false; });
  }

  /* ---------- Ver toda la colección (expandir en el inicio) --------------- */
  var expandedFrom = null;

  function expandCollection(section) {
    var grid = $('[data-collection-grid]', section);
    var tpl = $('[data-collection-template]', section);
    if (!grid || !tpl) return;
    if (!grid.firstChild) grid.appendChild(tpl.content.cloneNode(true));
    var wrap = section.closest('.shopify-section');
    expandedFrom = window.scrollY;
    section.classList.add('is-expanded');
    if (wrap) wrap.classList.add('is-expanded-section');
    document.body.classList.add('has-expanded');
    grid.hidden = false;
    $('[data-collection-back]', section).hidden = false;
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function collapseCollection(section) {
    var wrap = section.closest('.shopify-section');
    section.classList.remove('is-expanded');
    if (wrap) wrap.classList.remove('is-expanded-section');
    document.body.classList.remove('has-expanded');
    $('[data-collection-grid]', section).hidden = true;
    $('[data-collection-back]', section).hidden = true;
    window.scrollTo({ top: expandedFrom || 0, behavior: 'instant' });
  }

  /* ---------- Cuenta dentro del menú (copia la ficha de cuenta) ---------- */
  function fillAccountSlots() {
    var source = $('#AccountPanel .account-panel__body');
    $$('[data-account-slot]').forEach(function (slot) {
      if (source && !slot.firstChild) slot.innerHTML = '<div class="account-panel__body">' + source.innerHTML + '</div>';
    });
  }
  /* Pedidos reales desde el servicio propio (App Proxy). Si falla, se queda lo que dibujó Liquid. */
  function orderCardHTML(order, steps) {
    var tags = (order.tags || []).map(function (x) { return String(x).toLowerCase(); });
    var current = 0;
    steps.forEach(function (st, i) { if (st.tag && tags.indexOf(st.tag) > -1) current = i; });
    if (!order.cancelled && current === 0 && order.fulfillment === 'FULFILLED') current = steps.length - 1;
    var thumbs = (order.items || []).map(function (it) {
      return '<span class="order-card__thumb">' + (it.image ? '<img src="' + esc(it.image) + '" alt="" loading="lazy" width="42" height="42">' : '') + '</span>';
    }).join('');
    var date = order.date ? new Date(order.date).toLocaleDateString('es-CR') : '';
    var status;
    if (order.cancelled) {
      status = '<span class="order-chip order-chip--cancelled">Cancelado</span>';
    } else if (steps.length) {
      var st = steps[current];
      status = '<div class="order-card__state"><span class="order-chip">' + esc(st.label) + '</span>' + (st.description ? '<small>' + esc(st.description) + '</small>' : '') + '</div>' +
        '<ol class="order-steps" style="--steps: ' + steps.length + ';">' + steps.map(function (s2, i) {
          return '<li class="' + (i <= current ? 'is-done' : '') + (i === current ? ' is-current' : '') + '"><span class="order-steps__dot"></span><span class="order-steps__label">' + esc(s2.label) + '</span></li>';
        }).join('') + '</ol>';
    } else { status = ''; }
    return '<article class="order-card' + (order.cancelled ? ' order-card--cancelled' : '') + '">' +
      '<header class="order-card__head"><div><strong class="order-card__number">' + esc(order.name) + '</strong><small class="order-card__date">' + esc(date) + '</small></div>' +
      '<span class="order-card__total">' + formatMoney(order.totalCents) + '</span></header>' +
      '<div class="order-card__items">' + thumbs + '<span class="order-card__count">' + order.itemCount + (order.itemCount === 1 ? ' artículo' : ' artículos') + '</span></div>' +
      '<div class="order-card__status">' + status + '</div></article>';
  }

  function loadOrders() {
    var region = $('#AccountPanel [data-orders-region]');
    if (!region) return Promise.resolve();
    var endpoint = region.getAttribute('data-orders-endpoint');
    if (!endpoint) return Promise.resolve();
    var steps = [];
    try { steps = JSON.parse($('[data-order-steps]', region).textContent); } catch (e) { /* sin etapas */ }
    var limit = parseInt(region.getAttribute('data-orders-limit'), 10) || 5;
    return fetch(endpoint, { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('x'); return r.json(); })
      .then(function (data) {
        if (!data || !data.loggedIn) return;
        var list = $('.order-list, .account-empty', region);
        var html = data.orders.length
          ? '<div class="order-list">' + data.orders.slice(0, limit).map(function (o) { return orderCardHTML(o, steps); }).join('') + '</div>'
          : '<p class="muted account-empty">' + esc(region.getAttribute('data-empty-text')) + '</p>';
        if (list) list.outerHTML = html;
        $$('[data-account-slot]').forEach(function (slot) { slot.innerHTML = ''; });
        fillAccountSlots();
      })
      .catch(function () { /* se mantiene lo que ya se ve */ });
  }

  fillAccountSlots();
  loadOrders();
  document.addEventListener('shopify:section:load', fillAccountSlots);

  /* ---------- Eventos globales ----------------------------------------- */
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target.closest) return;

    if (handleLineEvent(event)) return;

    var opener = target.closest('[data-open]');
    if (opener) {
      var name = opener.getAttribute('data-open');
      event.preventDefault();
      if (name === 'search') openSearch(null);
      else if (name === 'reels') openDrawer(name, { view: opener.getAttribute('data-reels-view') });
      else openDrawer(name);
      return;
    }

    var pvToggle = target.closest('[data-pvideo-toggle]');
    if (pvToggle) { toggleProductVideo(pvToggle.closest('[data-pvideo]')); return; }
    var pvMute = target.closest('[data-pvideo-mute]');
    if (pvMute) {
      var pbox = pvMute.closest('[data-pvideo]');
      var pv = $('.pvideo__video', pbox);
      pv.muted = !pv.muted;
      pvMute.setAttribute('aria-pressed', pv.muted ? 'true' : 'false');
      $('[data-icon-sound]', pvMute).hidden = pv.muted;
      $('[data-icon-muted]', pvMute).hidden = !pv.muted;
      return;
    }

    var waBtn = target.closest('[data-ask-wa]');
    if (waBtn) {
      var waBox = waBtn.closest('[data-ask]');
      var typed = waBox.querySelector('input[name="q"]').value.trim();
      waBtn.href = waLink(waBox, typed);
      return;
    }

    var chip = target.closest('[data-ask-chip]');
    if (chip) {
      var askBox = chip.closest('[data-ask]');
      askBox.querySelector('input[name="q"]').value = chip.textContent.trim();
      askQuestion(askBox, chip.textContent.trim());
      return;
    }
    var comboBtn = target.closest('[data-combo-add]');
    if (comboBtn) { addCombo(comboBtn.closest('[data-combo]')); return; }

    var expandBtn = target.closest('[data-collection-expand]');
    if (expandBtn) { expandCollection(expandBtn.closest('[data-category-section]')); return; }
    var collapseBtn = target.closest('[data-collection-collapse]');
    if (collapseBtn) { collapseCollection(collapseBtn.closest('[data-category-section]')); return; }

    var showGrid = target.closest('[data-reels-show-grid]');
    if (showGrid) { setReelsView('grid'); return; }

    var tile = target.closest('[data-reel-tile]');
    if (tile) { setReelsView('feed', parseInt(tile.getAttribute('data-reel-tile'), 10) || 0); return; }

    var viewCart = target.closest('[data-added-view-cart]');
    if (viewCart) {
      event.preventDefault();
      closeDrawer($('[data-drawer="added"]'), true);
      openCartView();
      return;
    }

    var cartLink = target.closest('[data-open-cart]');
    if (cartLink && T.cartDrawer === 'drawer' && $('[data-drawer="cart"]')) {
      event.preventDefault();
      openDrawer('cart');
      return;
    }

    var closer = target.closest('[data-drawer-close]');
    if (closer) {
      closeDrawer(closer.closest('.drawer'));
      return;
    }

    var scopeBtn = target.closest('[data-search-collection]');
    if (scopeBtn) {
      event.preventDefault();
      openSearch({ handle: scopeBtn.getAttribute('data-search-collection'), title: scopeBtn.getAttribute('data-search-title') || '', question: scopeBtn.getAttribute('data-search-question') || '' });
      return;
    }

    var sortBtn = target.closest('[data-sort]');
    if (sortBtn && sortBtn.closest('[data-search-sort]')) {
      search.sort = sortBtn.getAttribute('data-sort');
      $$('[data-sort]', sortBtn.parentNode).forEach(function (b) { b.classList.toggle('is-active', b === sortBtn); });
      renderScopedResults();
      return;
    }

    var quickAdd = target.closest('[data-quick-add]');
    if (quickAdd) {
      event.preventDefault();
      quickAdd.classList.add('is-loading');
      addToCart(parseInt(quickAdd.getAttribute('data-quick-add'), 10), 1)
        .then(afterAdd)
        .catch(function (error) { showToast(error.message || 'No se pudo agregar al carrito'); })
        .then(function () { quickAdd.classList.remove('is-loading'); });
      return;
    }

    var quick = target.closest('[data-quick-view]');
    if (quick) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
      event.preventDefault();
      openQuickView(quick.getAttribute('data-quick-view'));
      return;
    }

    var like = target.closest('[data-reel-like]');
    if (like) {
      like.setAttribute('aria-pressed', like.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      return;
    }

    var share = target.closest('[data-reel-share]');
    if (share) {
      var shareData = { title: share.getAttribute('data-share-title') || document.title, url: share.getAttribute('data-share-url') || window.location.href };
      if (navigator.share) {
        navigator.share(shareData).catch(function () { /* cancelado */ });
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(shareData.url).then(function () { showToast('Enlace copiado'); });
      }
      return;
    }

    var toggle = target.closest('[data-reel-toggle]');
    if (toggle) {
      var reel = toggle.closest('[data-reel]');
      var video = reel && reelVideo(reel);
      if (video) {
        if (video.paused) { var pr = video.play(); if (pr && pr.catch) pr.catch(function () {}); } else { video.pause(); }
        syncReelToggle(reel);
      }
    }
  });

  document.addEventListener('change', function (event) {
    if (handleLineEvent(event)) return;
    if (event.target.matches && event.target.matches('[data-sort-select]')) {
      var url = new URL(window.location.href);
      url.searchParams.set('sort_by', event.target.value);
      url.searchParams.delete('page');
      window.location.href = url.toString();
    }
  });

  // Cerrar los videos antes de abrir la vista rápida desde un reel.
  document.addEventListener('click', function (event) {
    var el = event.target.closest && event.target.closest('[data-close-reels]');
    if (el) closeDrawer($('[data-drawer="reels"]'), true);
  }, true);

  /* ---------- Inicio ---------------------------------------------------- */
  function init() { initProducts(document); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  // Editor de temas de Shopify: volver a iniciar al recargar una sección.
  document.addEventListener('shopify:section:load', function (event) { initProducts(event.target); });
})();
