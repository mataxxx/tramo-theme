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
    if (drawer.getAttribute('data-drawer') === 'quick-view') { closeProductVideo($('.pvideo.is-open')); pauseProductVideos(); }
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

  function showHelpTopic(index) {
    var root = $('[data-help]');
    if (!root) return;
    var home = $('[data-help-home]', root);
    if (home) home.hidden = index !== null;
    $$('[data-help-detail]', root).forEach(function (d) { d.hidden = String(index) !== d.getAttribute('data-help-detail'); });
    root.scrollTop = 0;
  }

  function openDrawer(name, opts) {
    var drawer = $('[data-drawer="' + name + '"]');
    if (!drawer) return null;
    if (!drawer.classList.contains('is-open')) {
      lastFocus = document.activeElement;
      if (!(opts && opts.stack)) openDrawers().forEach(function (d) { if (d !== drawer) closeDrawer(d, true); });
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
      if (name === 'help') showHelpTopic(null);
      if (name === 'likes') renderLikes();
    }
    return drawer;
  }

  (function headerScroll() {
    var header = $('[data-site-header]');
    if (!header) return;
    var wrap = header.closest('.shopify-section') || header;
    function setH() { document.documentElement.style.setProperty('--header-h', wrap.offsetHeight + 'px'); }
    var ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        var y = window.scrollY || 0;
        if (y > 60) header.classList.add('is-scrolled');
        else if (y < 10) header.classList.remove('is-scrolled');
        setH();
        ticking = false;
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', setH);
    setH(); onScroll();
  })();

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
      var shown = 0;
      (cart.items || []).forEach(function (it) {
        var bulk = (it.variant_options || []).indexOf(BULK.name) > -1 || (it.options_with_values || []).some(function (o) { return o.value === BULK.name; });
        shown += bulk ? 1 : it.quantity;
      });
      updateCount(shown);
      if (sections['cart-drawer']) {
        var doc = new DOMParser().parseFromString(sections['cart-drawer'], 'text/html');
        var fresh = $('[data-cart-drawer-body]', doc);
        var current = $('[data-cart-drawer-body]');
        if (fresh && current) { current.innerHTML = fresh.innerHTML; if (typeof syncPaySteps === 'function') syncPaySteps(); }
      }
      return cart;
    });
  }

  function formProps(form) {
    var props = {};
    if (!form) return props;
    $$('input[name^="properties["]', form).forEach(function (input) {
      if ((input.type === 'radio' || input.type === 'checkbox') && !input.checked) return;
      var m = input.name.match(/^properties\[(.+)\]$/);
      if (m && input.value) props[m[1]] = input.value;
    });
    return props;
  }

  function addToCart(variantId, quantity, props) {
    var body = { id: variantId, quantity: quantity };
    if (props && Object.keys(props).length) body.properties = props;
    return fetch(T.routes.cartAdd, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
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
    openDrawer('added', { stack: true });
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
    var catOpen = $('[data-drawer="category"].is-open');
    var drawer = openDrawer('quick-view', { stack: !!catOpen });
    var backBtn = $('[data-quickview-back]');
    if (backBtn) {
      backBtn.hidden = !catOpen;
      var bl = $('[data-quickview-back-label]', backBtn);
      var ct = $('[data-category-modal-title]');
      if (bl) bl.textContent = catOpen && ct ? 'Volver a ' + ct.textContent : 'Volver';
    }
    var body = $('[data-quick-view-body]');
    if (!drawer || !body) { window.location.href = url; return; }

    function render(html) {
      body.innerHTML = html;
      var panel = body.parentElement;
      if (panel) panel.scrollTop = 0;
      initProducts(body);
      initRails(body);
      initPVideos(body);
      syncLikes();
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

    /* Botón de agregar flotante al pie: aparece cuando el original sale de la pantalla */
    (function () {
      if (!addButton) return;
      var host = $('.product-info', root) || root;
      var bar = document.createElement('div');
      bar.className = 'sticky-add'; bar.hidden = true;
      var sb = document.createElement('button');
      sb.type = 'button'; sb.className = 'button button--full';
      var pay = $('[data-sticky-pay]', root);
      if (pay) { pay.hidden = false; bar.appendChild(pay); }
      var oldPay = $('.pay-sentence', root); if (oldPay) oldPay.hidden = true;
      bar.appendChild(sb);
      var trust = $('[data-sticky-trust]', root);
      if (trust) { trust.hidden = false; bar.appendChild(trust); }
      host.appendChild(bar);
      function sync() { sb.textContent = (addButton.textContent || '').replace(/\s+/g, ' ').trim(); sb.disabled = addButton.disabled; }
      sync();
      new MutationObserver(sync).observe(addButton, { childList: true, subtree: true, characterData: true, attributes: true });
      sb.addEventListener('click', function () { addButton.click(); });
      bar.hidden = false;
    })();
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
      addToCart(parseInt(idInput.value, 10), quantity, formProps(form))
        .then(function (item) {
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

    var buyNow = $('[data-buy-now]', form);
    if (buyNow) {
      buyNow.addEventListener('click', function () {
        if (!addButton || addButton.disabled || !idInput || buyNow.disabled) return;
        var variant = findVariant(selectedOptions());
        var quantity = currentQuantity(variant);
        buyNow.disabled = true;
        addToCart(parseInt(idInput.value, 10), quantity, formProps(form))
          .then(function () { window.location.href = '/checkout'; })
          .catch(function (error) {
            buyNow.disabled = false;
            if (errorEl) { errorEl.textContent = error.message || 'No se pudo agregar al carrito'; errorEl.hidden = false; }
          });
      });
    }

    update(false);
  }

  /* ---------- Flechas de carruseles ------------------------------------- */
  var ARROW_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
  var activeRail = null;
  function initRails(scope) {
    $$('.product-rail, .cat-circles__row', scope || document).forEach(function (rail) {
      if (rail.parentNode.classList.contains('rail-wrap')) return;
      var wrap = document.createElement('div');
      wrap.className = 'rail-wrap';
      rail.parentNode.insertBefore(wrap, rail);
      wrap.appendChild(rail);
      var next = document.createElement('button');
      next.type = 'button'; next.className = 'rail-arrow rail-arrow--next'; next.setAttribute('aria-label', 'Ver más'); next.innerHTML = ARROW_SVG;
      var prev = document.createElement('button');
      prev.type = 'button'; prev.className = 'rail-arrow rail-arrow--prev'; prev.setAttribute('aria-label', 'Anterior'); prev.innerHTML = ARROW_SVG;
      wrap.appendChild(prev); wrap.appendChild(next);
      function update() {
        var max = rail.scrollWidth - rail.clientWidth;
        next.classList.toggle('is-visible', max > 6 && rail.scrollLeft < max - 6);
        prev.classList.toggle('is-visible', rail.scrollLeft > 6);
      }
      function activate() {
        if (activeRail && activeRail !== rail && activeRail.scrollLeft > 4) activeRail.scrollTo({ left: 0, behavior: 'smooth' });
        activeRail = rail;
      }
      wrap.addEventListener('pointerdown', activate, { passive: true });
      wrap.addEventListener('touchstart', activate, { passive: true });
      wrap.addEventListener('mouseenter', activate);
      next.addEventListener('click', function () { rail.scrollBy({ left: rail.clientWidth * 0.8, behavior: 'smooth' }); });
      prev.addEventListener('click', function () { rail.scrollBy({ left: -rail.clientWidth * 0.8, behavior: 'smooth' }); });
      rail.addEventListener('scroll', update, { passive: true });
      window.addEventListener('resize', update);
      setTimeout(update, 50); setTimeout(update, 600);
    });
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

  // Buscador del header (escritorio): se escribe ahí mismo y se despliega un panel unido a la barra
  (function () {
    var timer = null, token = 0;
    function wrapOf(el) { return el.closest('.header__searchwrap'); }
    function ensureDrop(wrap) {
      var drop = wrap.querySelector('.search-drop');
      if (drop) return drop;
      drop = document.createElement('div');
      drop.className = 'search-drop';
      var tiles = $$('[data-search-global] [data-search-collection]');
      var chips = tiles.map(function (t) {
        var title = t.getAttribute('data-search-title') || t.textContent.trim();
        var h = t.getAttribute('data-search-collection');
        var im = t.querySelector('img') || document.querySelector('.cats-tile[data-search-collection="' + h + '"] img');
        var src = im ? (im.currentSrc || im.src) : '';
        return '<button type="button" class="hsd__chip" data-search-collection="' + esc(h) + '" data-search-title="' + esc(title) + '" data-search-question="' + esc(t.getAttribute('data-search-question') || '') + '">' +
          '<span class="hsd__cimg">' + (src ? '<img src="' + esc(src) + '" alt="" loading="lazy">' : '<b>' + esc(title.charAt(0)) + '</b>') + '</span><span class="hsd__cname">' + esc(title) + '</span></button>';
      }).join('');
      drop.innerHTML = '<div class="search-drop__inner">' +
        '<div class="hsd__sugg" hidden><p class="hsd__title">Sugerencias</p><div class="hsd__list" data-hsd-list></div></div>' +
        '<div class="hsd__cats"><p class="hsd__title">Categorías</p><div class="hsd__chips">' + chips + '</div></div>' +
        '<a class="hsd__foot" href="#" data-hsd-foot hidden><span></span>' + '<svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>' +
        '</div>';
      wrap.appendChild(drop);
      return drop;
    }
    function setOpen(wrap, open) {
      if (!wrap) return;
      var drop = ensureDrop(wrap);
      drop.classList.toggle('is-open', open);
      wrap.classList.toggle('is-open', open);
    }
    function closeAll() { $$('.header__searchwrap.is-open').forEach(function (w) { setOpen(w, false); }); }
    function mode(wrap, q) {
      var drop = ensureDrop(wrap);
      drop.querySelector('.hsd__sugg').hidden = !q;
      drop.querySelector('[data-hsd-foot]').hidden = !q;
      if (q) {
        var base = ROOT.replace(/\/$/, '');
        var f = drop.querySelector('[data-hsd-foot]');
        f.href = base + '/search?q=' + encodeURIComponent(q);
        f.querySelector('span').innerHTML = 'Ver resultados para “<strong>' + esc(q) + '</strong>”';
      }
    }
    function run(wrap, q) {
      var mine = ++token;
      var box = ensureDrop(wrap).querySelector('[data-hsd-list]');
      mode(wrap, q);
      if (!box.children.length) box.innerHTML = '<p class="hsd__empty">Buscando…</p>';
      var base = ROOT.replace(/\/$/, '');
      fetch(base + '/search/suggest.json?q=' + encodeURIComponent(q) + '&resources[type]=product&resources[limit]=5')
        .then(parseJSON)
        .then(function (data) {
          if (mine !== token) return;
          var list = (data.resources && data.resources.results && data.resources.results.products) || [];
          if (!list.length) { box.innerHTML = '<p class="hsd__empty">No encontramos “' + esc(q) + '”. Prueba con otra palabra o elige una categoría.</p>'; return; }
          box.innerHTML = list.map(function (p) {
            var lo = parseFloat(p.price_min || p.price), hi = parseFloat(p.price_max || p.price);
            var price = isNaN(lo) ? '' : ((hi > lo ? 'Desde ' : '') + formatMoney(toCents(lo)));
            var sub = [p.type, price].filter(Boolean).map(esc).join('<i>•</i>');
            return '<a class="hsd__item" href="' + esc(p.url) + '" data-quick-view="' + esc(p.url) + '">' +
              '<span class="hsd__img">' + (p.image ? '<img src="' + esc(p.image) + '" alt="" loading="lazy">' : '') + '</span>' +
              '<span class="hsd__body"><strong>' + esc(p.title) + '</strong><small>' + sub + '</small></span>' +
              '<svg class="icon hsd__go" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></a>';
          }).join('');
        })
        .catch(function () { if (mine === token) box.innerHTML = '<p class="hsd__empty">No pude buscar ahora.</p>'; });
    }
    document.addEventListener('focusin', function (e) {
      var inp = e.target.closest && e.target.closest('[data-header-search]');
      if (!inp) return;
      var w = wrapOf(inp); setOpen(w, true);
      var q = inp.value.trim(); if (q.length >= 2) run(w, q); else mode(w, '');
    });
    document.addEventListener('input', function (e) {
      var inp = e.target.closest && e.target.closest('[data-header-search]');
      if (!inp) return;
      var w = wrapOf(inp), q = inp.value.trim();
      var clr = $('[data-search-clear]', w); if (clr) clr.hidden = !inp.value;
      clearTimeout(timer);
      if (q.length < 2) { token++; mode(w, ''); return; }
      timer = setTimeout(function () { run(w, q); }, 200);
    });
    document.addEventListener('click', function (e) {
      var t = e.target; if (!t.closest) return;
      var clr = t.closest('[data-search-clear]');
      if (clr) { var w0 = wrapOf(clr), i0 = $('[data-header-search]', w0); i0.value = ''; clr.hidden = true; token++; mode(w0, ''); i0.focus(); return; }
      if (t.closest('.hsd__chip') || t.closest('.hsd__item') || t.closest('[data-hsd-foot]')) { closeAll(); return; }
      if (!t.closest('.header__searchwrap')) closeAll();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeAll(); var i = $('[data-header-search]'); if (i) i.blur(); }
    });
  })();

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

  var reelsMuted = false;

  function syncReelToggle(reel) {
    var video = reelVideo(reel);
    if (!video) return;
    reel.classList.toggle('is-paused', video.paused);
  }

  function syncReelSound() {
    $$('[data-reel-mute]').forEach(function (btn) {
      btn.setAttribute('aria-pressed', reelsMuted ? 'true' : 'false');
      var snd = $('[data-icon-sound]', btn);
      var mut = $('[data-icon-muted]', btn);
      if (snd) snd.hidden = reelsMuted;
      if (mut) mut.hidden = !reelsMuted;
    });
  }

  function playReel(video) {
    video.muted = reelsMuted;
    var p = video.play();
    if (p && p.catch) {
      p.catch(function (err) {
        /* pause() aborta play(): no reanudar. Solo si bloquea el sonido, se reproduce sin sonido */
        if (!err || err.name !== 'NotAllowedError' || video.hasAttribute('data-user-paused')) return;
        reelsMuted = true;
        video.muted = true;
        syncReelSound();
        var q = video.play();
        if (q && q.catch) q.catch(function () { /* sin autoplay */ });
      });
    }
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
          if (!video.hasAttribute('data-user-paused')) playReel(video);
        } else {
          video.pause();
          video.removeAttribute('data-user-paused');
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
    var rv = event.target;
    if (rv && rv.closest && rv.closest('[data-reel]') && rv.duration) {
      var rbar = $('[data-reel-progress]', rv.closest('[data-reel]'));
      if (rbar) rbar.style.width = (rv.currentTime / rv.duration * 100) + '%';
    }
    var v = event.target;
    if (!v || !v.classList || !v.classList.contains('pvideo__video') || !v.duration) return;
    var bar = $('[data-pvideo-progress]', v.closest('[data-pvideo]'));
    if (bar) bar.style.width = (v.currentTime / v.duration * 100) + '%';
  }, true);

  function closeProductVideo(box) {
    if (!box || !box.classList.contains('is-open')) return;
    var v = $('.pvideo__video', box);
    box.classList.remove('is-open', 'is-paused');
    if (box._pvHome && box._pvHome.parentNode) {
      box._pvHome.parentNode.insertBefore(box, box._pvHome);
      box._pvHome.parentNode.removeChild(box._pvHome);
      box._pvHome = null;
    }
    if (v) {
      v.muted = true;
      var pr = v.play();
      if (pr && pr.catch) pr.catch(function () { /* sin autoplay */ });
    }
    var m = $('[data-pvideo-mute]', box);
    if (m) { m.setAttribute('aria-pressed', 'false'); $('[data-icon-sound]', m).hidden = true; $('[data-icon-muted]', m).hidden = false; }
  }

  function toggleProductVideo(box) {
    var v = $('.pvideo__video', box);
    if (!v) return;
    if (!box.classList.contains('is-open')) {
      /* miniatura -> grande, con sonido. Se mueve al <body> para que nada la recorte ni la tape */
      if (!box._pvHome && box.parentNode) {
        box._pvHome = document.createComment('pvideo');
        box.parentNode.insertBefore(box._pvHome, box);
        document.body.appendChild(box);
      }
      box.classList.add('is-open');
      v.muted = false;
      v.currentTime = 0;
      var pr = v.play();
      if (pr && pr.catch) pr.catch(function () { v.muted = true; v.play(); });
      var m = $('[data-pvideo-mute]', box);
      if (m) { m.setAttribute('aria-pressed', 'true'); $('[data-icon-sound]', m).hidden = false; $('[data-icon-muted]', m).hidden = true; }
      return;
    }
    if (v.paused) { v.play(); box.classList.remove('is-paused'); }
    else { v.pause(); box.classList.add('is-paused'); }
  }

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    var open = $('.pvideo.is-open');
    if (open) { closeProductVideo(open); event.stopImmediatePropagation(); }
  }, true);

  document.addEventListener('timeupdate', function (event) {
    var pv = event.target;
    if (pv && pv.classList && pv.classList.contains('pvideo__video') && pv.duration) {
      var bar = $('[data-pvideo-progress]', pv.closest('[data-pvideo]'));
      if (bar) bar.style.width = (pv.currentTime / pv.duration * 100) + '%';
    }
  }, true);

  ['play', 'pause'].forEach(function (name) {
    document.addEventListener(name, function (event) {
      var r = event.target && event.target.closest && event.target.closest('[data-reel]');
      if (r) syncReelToggle(r);
    }, true);
  });

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
    syncLikes();
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
    var mini = $('#AccountPanel [data-account-mini]');
    var source = $('#AccountPanel .account-panel__body');
    $$('[data-account-slot]').forEach(function (slot) {
      if (slot.firstChild) return;
      if (mini) slot.innerHTML = '<div class="account-panel__body">' + mini.innerHTML + '</div>';
      else if (source) slot.innerHTML = '<div class="account-panel__body">' + source.innerHTML + '</div>';
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

    var helpOpen = target.closest('[data-help-open]');
    if (helpOpen) { showHelpTopic(helpOpen.getAttribute('data-help-open')); return; }
    if (target.closest('[data-help-back]')) { showHelpTopic(null); return; }

    var opener = target.closest('[data-open]');
    if (opener) {
      var name = opener.getAttribute('data-open');
      event.preventDefault();
      if (name === 'search') {
        if (opener.classList.contains('header__searchbar') && window.matchMedia('(min-width: 750px)').matches) toggleSearchDrop(opener);
        else openSearch(null);
      }
      else if (name === 'reels') openDrawer(name, { view: opener.getAttribute('data-reels-view') });
      else openDrawer(name);
      return;
    }

    var pvClose = target.closest('[data-pvideo-close]');
    if (pvClose) { closeProductVideo(pvClose.closest('[data-pvideo]')); return; }
    var askOpen = target.closest('[data-ask-open]');
    if (askOpen) {
      var askRoot = askOpen.closest('[data-ask]');
      var askBody = $('[data-ask-body]', askRoot);
      var willOpen = askBody.hidden;
      askBody.hidden = !willOpen;
      askOpen.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      askRoot.classList.toggle('is-open', willOpen);
      if (willOpen) { var qi = $('input[name="q"]', askRoot); if (qi) qi.focus({ preventScroll: false }); }
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

    var catOpener = target.closest('[data-category-open]');
    if (catOpener) { event.preventDefault(); openCategory(catOpener); return; }
    var qvBack = target.closest('[data-quickview-back]');
    if (qvBack) { closeDrawer($('[data-drawer="quick-view"]'), true); return; }
    var expandBtn = target.closest('[data-collection-expand]');
    if (expandBtn) { event.preventDefault(); expandCollection(expandBtn.closest('[data-category-section]')); return; }
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
      openCategoryByHandle(scopeBtn.getAttribute('data-search-collection'), scopeBtn.getAttribute('data-search-title') || '', scopeBtn.getAttribute('data-search-question') || '');
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
      openChoice(quickAdd);
      return;
    }

    var choiceBuy = target.closest('[data-choice-buy]');
    if (choiceBuy) {
      if (!choice.id) return;
      choiceBuy.disabled = true;
      addToCart(choice.id, 1)
        .then(function () { window.location.href = '/checkout'; })
        .catch(function (error) { choiceBuy.disabled = false; showToast(error.message || 'No se pudo agregar al carrito'); });
      return;
    }
    var choiceAdd = target.closest('[data-choice-add]');
    if (choiceAdd) {
      if (!choice.id) return;
      choiceAdd.disabled = true;
      addToCart(choice.id, 1)
        .then(function () { return refreshCart(); })
        .then(function () { closeDrawer($('[data-drawer="choice"]'), true); showToast('Agregado al carrito ✓'); })
        .catch(function (error) { showToast(error.message || 'No se pudo agregar al carrito'); })
        .then(function () { choiceAdd.disabled = false; });
      return;
    }

    var likeBtn = target.closest('[data-like]');
    if (likeBtn) { event.preventDefault(); toggleLike(likeBtn.getAttribute('data-like')); return; }

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

    var muteBtn = target.closest('[data-reel-mute]');
    if (muteBtn) {
      reelsMuted = !reelsMuted;
      $$('[data-reel] video').forEach(function (v) { v.muted = reelsMuted; });
      syncReelSound();
      return;
    }

    /* Tocar el video lo pausa o lo reanuda */
    var tappedReel = target.closest('[data-reel]');
    if (tappedReel && !target.closest('a, button')) {
      var tvideo = reelVideo(tappedReel);
      if (tvideo) {
        if (tvideo.paused) { tvideo.removeAttribute('data-user-paused'); playReel(tvideo); } else { tvideo.setAttribute('data-user-paused', '1'); tvideo.pause(); }
        syncReelToggle(tappedReel);
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
  /* ---------- Ventana de categoría (Ver todo) ------------------------------ */
  var cat = { sort: 'default', desc: false, tag: '' };
  function normText(t) {
    return (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  function catEls() {
    return {
      grid: $('[data-category-grid]'),
      title: $('[data-category-modal-title]'),
      input: $('[data-category-filter]'),
      empty: $('[data-category-empty]'),
      chips: $('[data-category-chips]'),
      wrap: $('[data-category-searchwrap]'),
      toggle: $('[data-category-search-toggle]'),
      sort: $('[data-category-sort]'),
      body: $('.category-modal__body')
    };
  }
  function catSetup(opts) {
    var e = catEls();
    cat.sort = 'default'; cat.desc = false; cat.tag = '';
    e.sort.hidden = true;
    var ft = $('[data-category-filter-toggle]'); if (ft) ft.setAttribute('aria-expanded', 'false');
    e.title.textContent = opts.title || '';
    var sub = $('.cm-hero__sub'); if (sub) { if (sub._def === undefined) sub._def = sub.textContent; sub.textContent = opts.subtitle || sub._def; }
    var mt = $('[data-category-mini-title]'); if (mt) mt.textContent = opts.title || '';
    var cm0 = $('.category-modal'); if (cm0) { cm0.classList.remove('is-compact'); cm0.scrollTop = 0; }
    $$('[data-category-art]').forEach(function (art) { if (art._def === undefined) art._def = art.innerHTML; art.innerHTML = opts.banner ? '<img src="' + esc(opts.banner) + '" alt="">' : art._def; });
    e.input.value = '';
    e.input.placeholder = opts.question || 'Buscar...';
    var bar = opts.search !== 'icon';
    e.wrap.hidden = false;
    var gz = $('[data-cat-granel]'), fv = $('[data-cat-favs]'); if (gz) gz.checked = false; if (fv) fv.checked = false;
    var fl = $('[data-category-filters]'); if (fl) fl.hidden = false;
    e.empty.hidden = true;
    $$('[data-csort]', e.sort).forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-csort') === 'default');
      if (b.hasAttribute('data-label-asc')) b.textContent = b.getAttribute('data-label-asc');
    });
    var tags = (opts.filters || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
    e.chips.innerHTML = '';
    e.chips.hidden = tags.length === 0;
    if (tags.length) {
      ['Todas'].concat(tags).forEach(function (t, i) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'category-chip' + (i === 0 ? ' is-active' : '');
        b.setAttribute('data-ctag', i === 0 ? '' : t);
        var rk = i === 0 ? 'todas' : normText(t).replace(/\s+/g, '-');
        b.setAttribute('data-region', rk);
        b.innerHTML = (REGION_ICONS[rk] || '') + '<span>' + esc(t) + '</span>';
        e.chips.appendChild(b);
      });
    }
    if (e.body) e.body.scrollTop = 0;
  }
  var REGION_ICONS = (function () {
    function svg(d) { return '<svg class="ccicon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; }
    return {
      'todas': svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>'),
      'africa': svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>'),
      'asia': svg('<path d="m12 2 2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4Z"/>'),
      'europa': svg('<path d="m3 19 6-11 4 7 3-4 5 8Z"/>'),
      'america': svg('<path d="M16 4c1 1 1.5 2 1.5 3.5M6 9c3-3 10-3 12 3-3 6-9 8-14 7 0-4 0-7 2-10Z"/>'),
      'medio-oriente': svg('<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/>')
    };
  })();
  function catApply() {
    var e = catEls();
    var q = normText(e.input.value.trim());
    var tag = normText(cat.tag);
    var items = $$('.category-modal__item', e.grid);
    var shown = 0;
    items.forEach(function (el) {
      var okText = !q || normText(el.getAttribute('data-title') || el.textContent).indexOf(q) > -1;
      var gOn = $('[data-cat-granel]') && $('[data-cat-granel]').checked, fOn = $('[data-cat-favs]') && $('[data-cat-favs]').checked;
      var okExtra = (!gOn || el.getAttribute('data-bulk') === '1') && (!fOn || getLikes().indexOf(el.getAttribute('data-handle')) > -1);
      var okTag = !tag || (el.getAttribute('data-tags') || '').split('|').some(function (t) { return normText(t).indexOf(tag) > -1; });
      el.hidden = !(okText && okTag && okExtra);
      if (!el.hidden) shown++;
    });
    var visible = items.slice();
    if (cat.sort === 'title') visible.sort(function (a, b) { return (a.getAttribute('data-title') || '').localeCompare(b.getAttribute('data-title') || '', 'es'); });
    else if (cat.sort === 'price') visible.sort(function (a, b) { return (parseInt(a.getAttribute('data-price'), 10) - parseInt(b.getAttribute('data-price'), 10)) * (cat.desc ? -1 : 1); });
    if (cat.sort !== 'default') visible.forEach(function (el) { e.grid.appendChild(el); });
    e.empty.hidden = shown > 0 || items.length === 0;
    var cnt = $('[data-category-count]'); if (cnt) cnt.textContent = shown + (shown === 1 ? ' producto' : ' productos');
  }
  document.addEventListener('change', function (ev) {
    if (ev.target.closest && ev.target.closest('[data-cat-granel], [data-cat-favs]')) catApply();
  });
  function catRestoreOrder() {
    var e = catEls();
    var items = $$('.category-modal__item', e.grid);
    items.sort(function (a, b) { return (parseInt(a.style.getPropertyValue('--i'), 10) || 0) - (parseInt(b.style.getPropertyValue('--i'), 10) || 0); });
    items.forEach(function (el) { e.grid.appendChild(el); });
  }
  function catFill(html) {
    var e = catEls();
    e.grid.innerHTML = html;
    $$('.category-modal__item', e.grid).forEach(function (el, i) { el.style.setProperty('--i', i); });
    syncLikes();
    catApply();
  }
  function openCategory(opener) {
    var scope = opener.closest('[data-category-scope]');
    var tpl = scope && $('[data-category-template]', scope);
    if (!tpl) { var href = opener.getAttribute('href'); if (href) window.location.href = href; return; }
    catSetup({ title: opener.getAttribute('data-category-title'), question: opener.getAttribute('data-category-question'), filters: scope.getAttribute('data-category-filters'), search: scope.getAttribute('data-category-search'), banner: scope.getAttribute('data-category-banner'), subtitle: scope.getAttribute('data-category-subtitle') });
    var tmp = document.createElement('div');
    tmp.appendChild(tpl.content.cloneNode(true));
    catFill(tmp.innerHTML);
    openDrawer('category');
  }
  function openCategoryByHandle(handle, title, question) {
    var scope = document.querySelector('[data-category-scope][data-category-handle="' + handle + '"]');
    var tpl = scope && $('[data-category-template]', scope);
    var filters = scope ? scope.getAttribute('data-category-filters') : '';
    catSetup({ title: title, question: question, filters: filters, search: scope ? scope.getAttribute('data-category-search') : 'bar', banner: scope ? scope.getAttribute('data-category-banner') : '', subtitle: scope ? scope.getAttribute('data-category-subtitle') : '' });
    if (tpl) {
      var tmp = document.createElement('div');
      tmp.appendChild(tpl.content.cloneNode(true));
      catFill(tmp.innerHTML);
      openDrawer('category');
      return;
    }
    catEls().grid.innerHTML = '<p class="category-modal__empty">Cargando…</p>';
    openDrawer('category');
    fetch(ROOT + 'collections/' + encodeURIComponent(handle) + '?view=popup')
      .then(function (r) { if (!r.ok) throw new Error('x'); return r.text(); })
      .then(function (html) { catFill(html); })
      .catch(function () { catEls().grid.innerHTML = '<p class="category-modal__empty">No se pudo cargar la categoría.</p>'; });
  }
  document.addEventListener('input', function (event) {
    if (event.target.closest && event.target.closest('[data-category-filter]')) catApply();
  });
  document.addEventListener('click', function (event) {
    var t = event.target;
    if (!t.closest) return;
    var ftog = t.closest('[data-category-filter-toggle]');
    if (ftog) {
      var fe = catEls();
      var fopen = fe.sort.hidden;
      fe.sort.hidden = !fopen;
      ftog.setAttribute('aria-expanded', fopen ? 'true' : 'false');
      return;
    }
    var fgt = t.closest('[data-category-filters-toggle]');
    if (fgt) { var fl2 = $('[data-category-filters]'); fl2.hidden = !fl2.hidden; fgt.setAttribute('aria-expanded', fl2.hidden ? 'false' : 'true'); return; }
    var tog = t.closest('[data-category-search-toggle]');
    if (tog) {
      var e = catEls();
      var open = e.wrap.hidden;
      e.wrap.hidden = !open;
      tog.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) e.input.focus();
      return;
    }
    var sb = t.closest('[data-csort]');
    if (sb) {
      var kind = sb.getAttribute('data-csort');
      if (kind === 'price' && cat.sort === 'price') cat.desc = !cat.desc; else cat.desc = false;
      cat.sort = kind;
      $$('[data-csort]', sb.parentNode).forEach(function (b) { b.classList.toggle('is-active', b === sb); });
      if (kind === 'price') sb.textContent = sb.getAttribute(cat.desc ? 'data-label-desc' : 'data-label-asc');
      else { var pb = $('[data-csort="price"]', sb.parentNode); if (pb) pb.textContent = pb.getAttribute('data-label-asc'); }
      if (kind === 'default') catRestoreOrder();
      catApply();
      return;
    }
    var chip = t.closest('[data-ctag]');
    if (chip) {
      cat.tag = chip.getAttribute('data-ctag');
      $$('[data-ctag]', chip.parentNode).forEach(function (b) { b.classList.toggle('is-active', b === chip); });
      catApply();
    }
  });

  /* ---------- Video del producto: reproducción automática siempre ---------- */
  function keepPlaying(v) {
    if (!v || v.__keep) return;
    v.__keep = true;
    v.muted = true;
    v.defaultMuted = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    function go() {
      if (!v.isConnected || v.paused === false) return;
      if (v.closest('.pvideo.is-paused')) return;
      if (v.closest('.drawer') && !v.closest('.drawer.is-open')) return;
      var p = v.play();
      if (p && p.catch) p.catch(function () { /* se reintenta */ });
    }
    ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'stalled', 'suspend', 'pause', 'waiting'].forEach(function (ev) { v.addEventListener(ev, function () { setTimeout(go, 30); }); });
    go();
    var tries = 0;
    var iv = setInterval(function () {
      if (!v.isConnected || ++tries > 40) { clearInterval(iv); return; }
      go();
    }, 500);
    var once = function () { go(); document.removeEventListener('touchstart', once, true); document.removeEventListener('click', once, true); };
    document.addEventListener('touchstart', once, true);
    document.addEventListener('click', once, true);
  }
  function initPVideos(scope) {
    $$('.pvideo__video', scope || document).forEach(keepPlaying);
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) $$('.pvideo__video').forEach(function (v) { if (v.paused && !v.closest('.pvideo.is-paused')) v.play().catch(function () {}); });
  });

  /* ---------- Elección al tocar + ---------------------------------------- */
  var choice = { id: null };
  function openChoice(btn) {
    var card = btn.closest('[data-product-card]');
    choice.id = parseInt(btn.getAttribute('data-quick-add'), 10);
    var box = $('[data-choice-item]');
    if (box && card) {
      var img = $('img', card);
      var title = $('.product-card__title', card);
      var price = $('.price', card);
      box.innerHTML =
        '<span class="added-popup__img">' + (img ? '<img src="' + esc(img.currentSrc || img.src) + '" alt="" width="80" height="80">' : '') + '</span>' +
        '<span class="added-popup__info"><strong>' + esc(title ? title.textContent.trim() : '') + '</strong>' +
        '<span class="added-popup__price">' + (price ? esc(price.textContent.replace(/\s+/g, ' ').trim()) : '') + '</span></span>';
    }
    openDrawer('choice');
  }

  /* ---------- Favoritos (corazón) ----------------------------------------- */
  var LIKES_KEY = 'tramo_likes';
  function getLikes() {
    try { var v = JSON.parse(localStorage.getItem(LIKES_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function setLikes(list) { try { localStorage.setItem(LIKES_KEY, JSON.stringify(list)); } catch (e) { /* sin almacenamiento */ } }
  function syncLikes() {
    var list = getLikes();
    $$('[data-like]').forEach(function (b) {
      var on = list.indexOf(b.getAttribute('data-like')) > -1;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    $$('[data-likes-count]').forEach(function (c) { c.textContent = list.length; c.hidden = list.length === 0; });
  }
  function askLogin(reason) {
    var box = $('[data-login-ask]');
    if (!box) { window.location.href = T.loginUrl || '/account/login'; return; }
    var t = $('[data-login-title]', box), x = $('[data-login-text]', box);
    var R = {
      likes: ['Guarda tus favoritos', 'Para guardar en favoritos debes iniciar sesión.']
    }[reason] || null;
    if (t) { if (t._def === undefined) t._def = t.textContent; t.textContent = R ? R[0] : t._def; }
    if (x) { if (x._def === undefined) x._def = x.textContent; x.textContent = R ? R[1] : x._def; }
    var perks = $('.login-ask__perks', box); if (perks) perks.hidden = !!R;
    box.hidden = false;
  }
  document.addEventListener('click', function (e) {
    var t = e.target; if (!t.closest) return;
    var go = t.closest('[data-login-go], [data-login-open]');
    if (go) {
      try {
        var u = new URL(go.getAttribute('href'), location.origin);
        var back = location.pathname.indexOf('/account') === 0 ? '/' : location.pathname + location.search;
        u.searchParams.set('return_to', back);
        go.setAttribute('href', u.pathname + u.search);
      } catch (er) {}
    }
    if (t.closest('[data-login-ask-close]')) { var b = $('[data-login-ask]'); if (b) b.hidden = true; }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { var b = $('[data-login-ask]'); if (b) b.hidden = true; } });
  document.addEventListener('tramo:likes-changed', function () { syncLikes(); });

  /* Footer: en celular las columnas se pliegan (Tienda, Información); en computadora siempre abiertas */
  (function () {
    var mq = window.matchMedia('(max-width: 749px)');
    function set() { $$('[data-footer-acc]').forEach(function (d) { d.open = !mq.matches; }); }
    document.addEventListener('click', function (e) {
      var sm = e.target.closest && e.target.closest('[data-footer-acc] > summary');
      if (sm && !mq.matches) e.preventDefault();
    });
    if (mq.addEventListener) mq.addEventListener('change', set); else if (mq.addListener) mq.addListener(set);
    set();
    document.addEventListener('shopify:section:load', set);
  })();
  function toggleLike(handle) {
    if (!T.loggedIn) { askLogin('likes'); return; }
    var list = getLikes();
    var i = list.indexOf(handle);
    if (i > -1) list.splice(i, 1); else list.unshift(handle);
    setLikes(list);
    syncLikes();
    if ($('[data-drawer="likes"].is-open')) renderLikes();
    else if (i === -1) showToast('Guardado en favoritos ♥');
  }
  function renderLikes() {
    var listEl = $('[data-likes-list]');
    var empty = $('[data-likes-empty]');
    if (!listEl) return;
    var handles = getLikes();
    empty.hidden = handles.length > 0;
    listEl.innerHTML = '';
    handles.forEach(function (h) {
      fetch(ROOT + 'products/' + encodeURIComponent(h) + '.js')
        .then(function (r) { if (!r.ok) throw new Error('x'); return r.json(); })
        .then(function (p) {
          var prices = (p.variants || []).filter(function (v) { return !(v.options && v.options.indexOf(BULK.name) > -1); }).map(function (v) { return v.price; });
          var min = prices.length ? Math.min.apply(null, prices) : p.price;
          var max = prices.length ? Math.max.apply(null, prices) : p.price;
          var li = document.createElement('li');
          li.className = 'like-row';
          li.innerHTML =
            '<a class="like-row__main" href="' + esc(p.url) + '" data-quick-view="' + esc(p.url) + '">' +
            '<span class="like-row__img">' + (p.featured_image ? '<img src="' + esc(sizedImage(p.featured_image, 160)) + '" alt="" width="64" height="64">' : '') + '</span>' +
            '<span class="like-row__info"><strong>' + esc(p.title) + '</strong><span>' + (min < max ? 'Desde ' : '') + formatMoney(min) + '</span></span></a>' +
            '<button type="button" class="like-btn like-btn--row" data-like="' + esc(h) + '" aria-pressed="true" aria-label="Quitar de favoritos"><svg class="icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg></button>';
          listEl.appendChild(li);
        })
        .catch(function () { /* producto ya no existe */ });
    });
  }

  /* ---------- Paso 1: método de pago -------------------------------------- */
  var PAY_KEY = 'tramo_pay';
  function savePayAttr(value) {
    return fetch(T.routes.cartUpdate || (ROOT + 'cart/update.js'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ attributes: { 'Método de pago': value } })
    }).catch(function () { /* se guarda al enviar el formulario */ });
  }
  function gatePay(step) {
    var form = step.closest('form');
    var checked = $('[data-pay-option]:checked', step);
    var btn = form && $('[data-checkout-button]', form);
    if (btn) btn.disabled = !checked;
    var hint = $('[data-pay-hint]', step);
    if (hint) hint.hidden = !!checked;
  }
  function syncPaySteps() {
    $$('[data-pay-step]').forEach(function (step) {
      if (!$('[data-pay-option]:checked', step)) {
        var saved = null;
        try { saved = localStorage.getItem(PAY_KEY); } catch (e) { /* noop */ }
        if (saved) {
          var match = $$('[data-pay-option]', step).filter(function (i) { return i.value === saved; })[0];
          if (match) { match.checked = true; savePayAttr(saved); }
        }
      }
      gatePay(step);
    });
  }
  document.addEventListener('change', function (event) {
    var opt = event.target.closest && event.target.closest('[data-pay-option]');
    if (!opt) return;
    try { localStorage.setItem(PAY_KEY, opt.value); } catch (e) { /* noop */ }
    gatePay(opt.closest('[data-pay-step]'));
    savePayAttr(opt.value);
  });

  function init() { initProducts(document); initRails(document); initPVideos(document); syncLikes(); syncPaySteps(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  // Editor de temas de Shopify: volver a iniciar al recargar una sección.
  document.addEventListener('shopify:section:load', function (event) { initProducts(event.target); });

  /* ---------- Portada con diapositivas --------------------------------- */
  function initHeroSlider() {
    $$('[data-hero-slider]').forEach(function (box) {
      if (box.getAttribute('data-ready')) return;
      box.setAttribute('data-ready', '1');
      var track = $('[data-hero-track]', box);
      var dots = $$('[data-hero-dot]', box);
      var slides = track.children;
      if (!dots.length || slides.length < 2) return;
      var n = slides.length; /* slides reales */
      var secs = parseInt(box.getAttribute('data-autoplay'), 10);
      var paused = false, timer = null, settle = null;
      /* clon del primero al final: de la última pasa a la primera siguiendo hacia la izquierda, sin devolverse */
      var clone = slides[0].cloneNode(true);
      clone.setAttribute('aria-hidden', 'true'); clone.setAttribute('data-clone', '1');
      $$('a, button', clone).forEach(function (el) { el.setAttribute('tabindex', '-1'); });
      track.appendChild(clone);
      function w() { return track.clientWidth || 1; }
      function current() { return Math.round(track.scrollLeft / w()); }
      function mark() { var c = current() % n; dots.forEach(function (d, i) { d.classList.toggle('is-active', i === c); }); }
      function jump(i) { track.style.scrollSnapType = 'none'; track.style.scrollBehavior = 'auto'; track.scrollLeft = i * w(); void track.offsetWidth; track.style.scrollSnapType = ''; track.style.scrollBehavior = ''; }
      function go(i) { track.scrollTo({ left: i * w(), behavior: 'smooth' }); }
      function fix() { if (current() >= n) jump(current() - n); mark(); }
      function next() { go(current() + 1); }
      function prev() { var c = current(); if (c <= 0) { jump(n); c = n; } go(c - 1); }
      ['prev', 'next'].forEach(function (dir) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'hero-arrow hero-arrow--' + dir; b.setAttribute('aria-label', dir === 'prev' ? 'Anterior' : 'Siguiente');
        b.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + (dir === 'prev' ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6') + '"/></svg>';
        b.addEventListener('click', dir === 'prev' ? prev : next);
        box.appendChild(b);
      });
      track.addEventListener('scroll', function () {
        window.requestAnimationFrame(mark);
        clearTimeout(settle); settle = setTimeout(fix, 90);
      }, { passive: true });
      if ('onscrollend' in window) track.addEventListener('scrollend', fix);
      dots.forEach(function (d, i) { d.addEventListener('click', function () { go(i); }); });
      ['touchstart', 'pointerdown', 'mouseenter'].forEach(function (ev) { box.addEventListener(ev, function () { paused = true; }, { passive: true }); });
      ['mouseleave', 'touchend'].forEach(function (ev) { box.addEventListener(ev, function () { paused = false; }, { passive: true }); });
      if (secs > 0) {
        timer = setInterval(function () {
          if (paused || document.hidden) return;
          next();
        }, secs * 1000);
      }
    });
  }
  initHeroSlider();
  document.addEventListener('shopify:section:load', initHeroSlider);

  /* Me gusta del video (separado de favoritos; se guarda en este navegador) */
  (function () {
    var KEY = 'tramo.videoLikes';
    function list() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } }
    function save(a) { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) {} }
    function paint() { var l = list(); $$('[data-pvideo-like]').forEach(function (b) { b.setAttribute('aria-pressed', l.indexOf(b.getAttribute('data-pvideo-like')) > -1 ? 'true' : 'false'); }); }
    document.addEventListener('click', function (event) {
      var b = event.target.closest && event.target.closest('[data-pvideo-like]');
      if (!b) return;
      event.preventDefault(); event.stopPropagation();
      var h = b.getAttribute('data-pvideo-like'), l = list(), i = l.indexOf(h);
      if (i > -1) l.splice(i, 1); else l.push(h);
      save(l); paint();
    }, true);
    paint();
    document.addEventListener('shopify:section:load', paint);
  })();

  /* Compartir el video del producto */
  document.addEventListener('click', function (event) {
    var b = event.target.closest && event.target.closest('[data-pvideo-share]');
    if (!b) return;
    event.preventDefault(); event.stopPropagation();
    var url = b.getAttribute('data-share-url'), title = b.getAttribute('data-share-title') || document.title;
    if (navigator.share) { navigator.share({ title: title, text: 'Mira este video: ' + title, url: url }).catch(function () {}); return; }
    var done = function () { showToast('Enlace del video copiado'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { window.prompt('Copia este enlace', url); });
    else window.prompt('Copia este enlace', url);
  }, true);
  /* Enlace compartido (?video=1): abre el video en grande */
  (function () {
    if (!/[?&]video=1/.test(location.search)) return;
    window.addEventListener('load', function () { setTimeout(function () { var bx = $('[data-pvideo]'); if (bx && !bx.classList.contains('is-open')) toggleProductVideo(bx); }, 500); });
  })();


  /* Celular: ventana de categoría — el banner sube con el scroll y queda fija la barra con título + buscador */
  (function () {
    var cm = null;
    document.addEventListener('scroll', function (e) {
      var t = e.target;
      if (!t || !t.classList || !t.classList.contains('category-modal')) return;
      var compact = t.scrollTop > 90;
      if (compact !== t.classList.contains('is-compact')) t.classList.toggle('is-compact', compact);
    }, true);
  })();
})();
