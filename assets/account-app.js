/* Tramo — cuenta de clientes propia (Customer Account API, OAuth PKCE en el navegador) */
(function () {
  var host = document.getElementById('tramo-account') || document.getElementById('tramo-account-drawer');
  if (!host) return;
  var DRAWER = host.dataset.mode === 'drawer';
  var BACK = 'tramo.acct.back';
  var root = host.querySelector('[data-acct-root]');
  var loading = host.querySelector('[data-acct-loading]');
  var CLIENT_ID = host.dataset.clientId;
  var SCOPE = 'openid email customer-account-api:full';
  var KEY = 'tramo.acct.tokens';
  var PKCE = 'tramo.acct.pkce';
  var API_VERSION = '2025-10';
  var cfg = null; // endpoints
  var state = { tab: DRAWER ? '' : 'resumen', customer: null, msg: null, addr: null };
  try { var qt = new URLSearchParams(location.search).get('tab'); if (qt) state.tab = qt; } catch (e) {}

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function ses(k, v) { try { if (v === undefined) return JSON.parse(sessionStorage.getItem(k) || 'null'); sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }
  function money(m) { var n = Math.round(Number(m.amount) || 0); return (m.currencyCode === 'CRC' || !m.currencyCode ? '₡' : m.currencyCode + ' ') + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function fdate(d) { try { return new Date(d).toLocaleDateString('es-CR', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return d; } }
  function redirectUri() { return location.origin + (host.dataset.callback || location.pathname); }

  /* ---------- PKCE ---------- */
  function rand(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function b64url(buf) { var s = ''; new Uint8Array(buf).forEach(function (b) { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function sha256(str) { return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)); }

  function discover() {
    if (cfg) return Promise.resolve(cfg);
    return Promise.all([
      fetch('/.well-known/openid-configuration').then(function (r) { return r.json(); }),
      fetch('/.well-known/customer-account-api').then(function (r) { return r.json(); })
    ]).then(function (x) {
      cfg = {
        auth: x[0].authorization_endpoint,
        token: x[0].token_endpoint,
        logout: x[0].end_session_endpoint || x[0].logout_endpoint,
        api: x[1].graphql_api || x[1].graphqlApi || x[1].graphql_endpoint
      };
      return cfg;
    });
  }

  function login() {
    if (DRAWER) ses(BACK, location.pathname + location.search);
    return discover().then(function () {
      var verifier = rand(32), st = rand(16), nonce = rand(16);
      ses(PKCE, { v: verifier, s: st });
      return sha256(verifier).then(function (h) {
        var p = new URLSearchParams({
          client_id: CLIENT_ID, scope: SCOPE, redirect_uri: redirectUri(), response_type: 'code',
          state: st, nonce: nonce, code_challenge: b64url(h), code_challenge_method: 'S256'
        });
        location.href = cfg.auth + '?' + p.toString();
      });
    });
  }

  function tokenRequest(body) {
    return discover().then(function () {
      return fetch(cfg.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
    }).then(function (r) { if (!r.ok) throw new Error('token'); return r.json(); }).then(function (t) {
      var old = get(KEY) || {};
      var tk = { access: t.access_token, refresh: t.refresh_token || old.refresh, id: t.id_token || old.id, exp: Date.now() + (t.expires_in || 3600) * 1000 - 30000 };
      set(KEY, tk); return tk;
    });
  }

  function handleCallback() {
    var q = new URLSearchParams(location.search);
    if (!q.get('code') && !q.get('error')) return Promise.resolve(false);
    var p = ses(PKCE);
    history.replaceState({}, '', location.pathname);
    if (q.get('error') || !p || p.s !== q.get('state')) return Promise.resolve(false);
    return tokenRequest({ grant_type: 'authorization_code', client_id: CLIENT_ID, redirect_uri: redirectUri(), code: q.get('code'), code_verifier: p.v }).then(function () {
      var back = ses(BACK);
      if (back) { try { sessionStorage.removeItem(BACK); } catch (e) {} location.replace(back + '#mi-cuenta'); return new Promise(function () {}); }
      return true;
    });
  }

  function accessToken() {
    var t = get(KEY);
    if (!t) return Promise.resolve(null);
    if (Date.now() < t.exp) return Promise.resolve(t.access);
    if (!t.refresh) { del(KEY); return Promise.resolve(null); }
    return tokenRequest({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: t.refresh }).then(function (n) { return n.access; }).catch(function () { del(KEY); return null; });
  }

  function gql(query, variables) {
    return accessToken().then(function (tok) {
      if (!tok) throw new Error('auth');
      return discover().then(function () {
        return fetch(cfg.api, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: tok }, body: JSON.stringify({ query: query, variables: variables || {} }) });
      });
    }).then(function (r) { if (r.status === 401) { del(KEY); throw new Error('auth'); } return r.json(); })
      .then(function (j) { if (j.errors && j.errors.length) { throw new Error(j.errors[0].message); } return j.data; });
  }

  /* ---------- Datos ---------- */
  var ADDR = 'id firstName lastName address1 address2 city zoneCode territoryCode zip phoneNumber formatted';
  var Q = 'query { customer { id firstName lastName emailAddress { emailAddress } phoneNumber { phoneNumber } defaultAddress { id } ' +
    'addresses(first: 20) { nodes { ' + ADDR + ' } } ' +
    'orders(first: 30, sortKey: PROCESSED_AT, reverse: true) { nodes { id name processedAt financialStatus statusPageUrl totalPrice { amount currencyCode } ' +
    'lineItems(first: 10) { nodes { title quantity image { url } } } } } } }';

  function load() {
    return gql(Q).then(function (d) { state.customer = d.customer; return DRAWER ? loadRacks() : null; });
  }

  /* ---------- Mis especieros (guardados en la cuenta del cliente) ---------- */
  var PENDING = 'tramo.rack.pending';
  function loadRacks() {
    return gql('query { customer { id metafield(namespace: "tramo", key: "especieros") { value } } }').then(function (d) {
      var v = []; try { v = JSON.parse((d.customer.metafield && d.customer.metafield.value) || '[]'); } catch (e) { v = []; }
      state.racks = Array.isArray(v) ? v : [];
      state.custId = d.customer.id;
      return registerPending();
    }).catch(function () { state.racks = state.racks || []; });
  }
  function saveRacks(list) {
    return gql('mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { message } } }',
      { m: [{ ownerId: state.custId, namespace: 'tramo', key: 'especieros', type: 'json', value: JSON.stringify(list) }] })
      .then(function (d) { var e = d.metafieldsSet.userErrors; if (e && e.length) throw new Error(e[0].message); state.racks = list; });
  }
  function registerPending() {
    var p = get(PENDING); if (!p || !p.code) return Promise.resolve();
    del(PENDING);
    if (state.racks.some(function (r) { return r.code === p.code; })) {
      state.msg = { t: 'Este especiero ya está en tu cuenta.' }; pendingTab = 'especieros'; return Promise.resolve();
    }
    var list = state.racks.concat([{ code: p.code, slots: p.slots, jars: p.jars, date: new Date().toISOString() }]);
    return saveRacks(list).then(function () { state.msg = { t: '¡Listo! Tu especiero quedó registrado.' }; pendingTab = 'especieros'; })
      .catch(function () { set(PENDING, p); state.msg = { t: 'No pudimos registrar el especiero. Intenta de nuevo.', err: true }; });
  }

  /* Catálogo para repuestos: especias por grupo + precios del repuesto */
  var CAT = null;
  function loadCatalog() {
    if (CAT) return CAT.ready;
    CAT = { by: {}, list: [], refill: {}, extra: null };
    function coll(h, g) {
      return fetch('/collections/' + h + '/products.json?limit=250').then(function (r) { return r.ok ? r.json() : { products: [] }; }).then(function (j) {
        (j.products || []).forEach(function (p) { if (CAT.by[p.handle]) return; var x = { handle: p.handle, title: p.title, group: g }; CAT.by[p.handle] = x; CAT.list.push(x); });
      }).catch(function () {});
    }
    function prod(h) { return fetch('/products/' + h + '.js').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }
    CAT.ready = Promise.all([
      coll('frontpage', 'classic'), coll('condimentos-de-la-casa', 'house'), coll('condimentos-del-mundo', 'world'),
      prod('repuesto-especiero').then(function (p) { (p && p.variants || []).forEach(function (v) { CAT.refill[/frasco/i.test(v.title) ? 'jar' : 'bag'] = { id: v.id, price: v.price }; }); }).catch(function () {}),
      prod('frasco-especial').then(function (p) { var v = p && p.variants && p.variants[0]; if (v) CAT.extra = { id: v.id, price: v.price }; }).catch(function () {})
    ]).catch(function () {}).then(function () { CAT.loaded = true; if (state.customer && (state.tab === 'especieros' || state.tab === 'repuestos')) drawerRender(); });
    return CAT.ready;
  }
  var JARC = [[/paprika|pimenton|chile|chipotle|harissa|berbere|cayena|achiote/, '#b8432a'], [/curry|curcuma|azafran|ras el|mostaza/, '#d39a26'], [/ajo|cebolla|sal|jengibre|nuez|cardamomo/, '#e6d3ac'], [/pimienta|clavo|comino|anis|cafe|cacao|canela/, '#5a3a24'], [/oregano|albahaca|romero|tomillo|perejil|eneldo|laurel|mejorana|hierbas|chimichurri|zaatar|culantro|cilantro/, '#5e7a3a'], [/masala|garam|chaat|adobo|sazon|mezcla|condimento/, '#8a5a2b']];
  function jarC(t) { t = String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); for (var i = 0; i < JARC.length; i++) if (JARC[i][0].test(t)) return JARC[i][1]; return '#8a6a3a'; }
  function spTitle(h) { return (CAT && CAT.by[h] && CAT.by[h].title) || String(h).replace(/-/g, ' ').replace(/^./, function (x) { return x.toUpperCase(); }); }
  function spGroup(h) { return (CAT && CAT.by[h] && CAT.by[h].group) || 'classic'; }
  function cents(n) { return money({ amount: n / 100, currencyCode: host.dataset.currency || 'CRC' }); }

  function tabEspecieros() {
    loadCatalog();
    var rs = state.racks || [];
    if (!rs.length) return '<div class="acd__empty-rack"><span class="acd__ico">' + ic('especieros') + '</span><b>Aún no tienes especieros registrados</b><p class="acct__muted">Cuando recibas tu especiero, escanea el código QR que viene pegado. Se agrega aquí y desde aquí pides repuestos de cada frasco.</p></div>';
    return rs.map(function (r, ri) {
      var cols = r.slots <= 6 ? 3 : r.slots <= 12 ? 4 : 6;
      return '<div class="acd__rack"><div class="acd__rackhead"><div><b>Especiero ' + r.slots + ' frascos</b><small>Código ' + esc(r.code) + (r.date ? ' · desde ' + esc(fdate(r.date)) : '') + '</small></div></div>' +
        '<div class="acd__rackwood" style="--cols:' + cols + '">' + r.jars.map(function (h, i) {
          return '<button type="button" class="acd__rjar" data-a="refill-one" data-r="' + ri + '" data-h="' + esc(h) + '" aria-label="Pedir repuesto de ' + esc(spTitle(h)) + '"><i style="--fill:' + jarC(spTitle(h)) + '"></i><span>' + esc(spTitle(h)) + '</span></button>';
        }).join('') + '</div>' +
        '<button type="button" class="acct__btn acd__rackbtn" data-a="go" data-t="repuestos" data-r="' + ri + '">Pedir repuestos</button></div>';
    }).join('') + '<p class="acct__muted acd__rackhint">Toca un frasco para pedir su repuesto, o usa «Pedir repuestos» para elegir varios.</p>';
  }

  function refillRow(h, mine) {
    var sp = CAT.by[h] || { handle: h, title: spTitle(h), group: spGroup(h) };
    var kind = state.refillKind || 'bag', base = CAT.refill[kind], extra = sp.group !== 'classic' && CAT.extra ? CAT.extra.price : 0;
    var added = state.added && state.added[kind + ':' + h];
    return '<li><i class="acd__rdot" style="--fill:' + jarC(sp.title) + '"></i><span><b>' + esc(sp.title) + '</b><small>' + (base ? cents(base.price + extra) : '') + (extra ? ' · especial' : '') + '</small></span>' +
      '<button type="button" class="acd__add' + (added ? ' is-ok' : '') + '" data-a="refill-add" data-h="' + esc(h) + '" aria-label="Agregar ' + esc(sp.title) + '">' + (added ? '✓' : '+') + '</button></li>';
  }
  function tabRepuestos() {
    loadCatalog();
    if (!CAT.loaded) return '<p class="acct__muted">Cargando especias…</p>';
    var r = (state.racks || [])[state.rackIdx || 0];
    var kind = state.refillKind || 'bag';
    if (!CAT.refill.bag && !CAT.refill.jar) return '<p class="acct__muted">Los repuestos no están disponibles en este momento.</p>';
    var mine = r ? r.jars.filter(function (h, i, a) { return a.indexOf(h) === i; }) : [];
    var g = state.refillTab || 'classic', q = (state.refillQ || '').toLowerCase();
    var others = CAT.list.filter(function (x) { return mine.indexOf(x.handle) < 0 && (q ? x.title.toLowerCase().indexOf(q) > -1 : x.group === g); });
    return '<div class="acd__kind" role="tablist">' +
      ['bag', 'jar'].map(function (k) { var v = CAT.refill[k]; if (!v) return ''; return '<button type="button" data-a="kind" data-k="' + k + '" class="' + (k === kind ? 'is-on' : '') + '"><b>' + (k === 'bag' ? 'Sobrecito' : 'Frasco nuevo') + '</b><small>' + cents(v.price) + '</small></button>'; }).join('') + '</div>' +
      '<p class="acct__muted acd__kindhint">' + (kind === 'bag' ? 'Para rellenar tu frasco.' : 'Un frasco lleno con tapa, listo para poner en tu especiero.') + ' Mezclas de la casa y del mundo +' + cents(CAT.extra ? CAT.extra.price : 50000) + '.</p>' +
      (mine.length ? '<h4 class="acd__sub">En tu especiero</h4><ul class="acd__refills">' + mine.map(function (h) { return refillRow(h, true); }).join('') + '</ul>' : '') +
      '<h4 class="acd__sub">Otras especias</h4>' +
      '<div class="acd__rtabs">' + [['classic', 'Clásicas'], ['house', 'De la casa'], ['world', 'Del mundo']].map(function (x) { return '<button type="button" data-a="rtab" data-g="' + x[0] + '" class="' + (x[0] === g && !q ? 'is-on' : '') + '">' + x[1] + '</button>'; }).join('') + '</div>' +
      '<label class="acd__rsearch"><input type="search" data-refill-q placeholder="Buscar especia…" value="' + esc(state.refillQ || '') + '"></label>' +
      '<ul class="acd__refills">' + (others.length ? others.map(function (x) { return refillRow(x.handle); }).join('') : '<li class="acct__muted">No hay especias aquí.</li>') + '</ul>';
  }
  function addRefill(h, btn) {
    var kind = state.refillKind || 'bag', base = CAT.refill[kind]; if (!base) return;
    var r = (state.racks || [])[state.rackIdx || 0];
    var sp = CAT.by[h] || { title: spTitle(h), group: spGroup(h) };
    var props = { 'Especia': sp.title, 'Especiero': r ? r.code : '' };
    var items = [{ id: base.id, quantity: 1, properties: props }];
    if (sp.group !== 'classic' && CAT.extra) items.push({ id: CAT.extra.id, quantity: 1, properties: { 'Repuesto especial': sp.title } });
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    fetch('/cart/add.js', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ items: items }) })
      .then(function (res) { if (!res.ok) throw new Error('add'); state.added = state.added || {}; state.added[kind + ':' + h] = 1;
        document.dispatchEvent(new CustomEvent('tramo:cart-changed', { detail: { toast: (kind === 'bag' ? 'Sobrecito' : 'Frasco') + ' de ' + sp.title + ' agregado' } })); })
      .catch(function () { state.msg = { t: 'No se pudo agregar. Intenta de nuevo.', err: true }; })
      .then(function () { drawerRender(); });
  }

  /* ---------- Vistas ---------- */
  function loginView(t) {
    root.innerHTML = '<div class="acct__card acct__login"><h1>' + esc(host.dataset.loginTitle || 'Tu cuenta') + '</h1><p>' + esc(host.dataset.loginText || '') + '</p>' +
      (t ? '<p class="acct__msg acct__msg--err">' + esc(t) + '</p>' : '') +
      '<button class="acct__btn" data-a="login">' + esc(host.dataset.loginButton || 'Entrar') + '</button></div>';
    show();
  }
  function show() { if (loading) loading.hidden = true; root.hidden = false; }

  var FIN = { PAID: ['Pagado', ''], PENDING: ['Pendiente', 'warn'], AUTHORIZED: ['Autorizado', 'warn'], PARTIALLY_PAID: ['Pago parcial', 'warn'], REFUNDED: ['Reembolsado', 'bad'], PARTIALLY_REFUNDED: ['Reembolso parcial', 'warn'], VOIDED: ['Anulado', 'bad'] };
  function orderHtml(o) {
    var f = FIN[o.financialStatus] || [o.financialStatus || '', 'warn'];
    var th = o.lineItems.nodes.map(function (l) { return l.image ? '<img src="' + esc(l.image.url) + '" alt="' + esc(l.title) + '" loading="lazy">' : '<i></i>'; }).join('');
    var names = o.lineItems.nodes.map(function (l) { return l.quantity + '× ' + esc(l.title); }).join(', ');
    return '<div class="acct__order"><div class="acct__orow"><div><b>Pedido ' + esc(o.name) + '</b><div class="acct__muted">' + esc(fdate(o.processedAt)) + '</div></div>' +
      '<div><span class="acct__tag ' + (f[1] ? 'acct__tag--' + f[1] : '') + '">' + esc(f[0]) + '</span> &nbsp;<b>' + esc(money(o.totalPrice)) + '</b></div></div>' +
      '<div class="acct__thumbs">' + th + '</div><div class="acct__muted">' + names + '</div>' +
      (o.statusPageUrl ? '<div><a class="acct__btn acct__btn--ghost acct__btn--sm" href="' + esc(o.statusPageUrl) + '">Ver seguimiento</a></div>' : '') + '</div>';
  }

  function tabResumen(c) {
    var os = c.orders.nodes, last = os[0];
    var gasto = os.reduce(function (a, o) { return a + Number(o.totalPrice.amount); }, 0);
    var cur = last ? last.totalPrice.currencyCode : 'CRC';
    var unique = {}; os.forEach(function (o) { o.lineItems.nodes.forEach(function (l) { unique[l.title] = 1; }); });
    return '<div class="acct__stats"><div class="acct__stat"><b>' + os.length + '</b><span>Pedidos</span></div>' +
      '<div class="acct__stat"><b>' + Object.keys(unique).length + '</b><span>Especias distintas</span></div>' +
      '<div class="acct__stat"><b>' + esc(money({ amount: gasto, currencyCode: cur })) + '</b><span>Total comprado</span></div></div>' +
      '<div class="acct__card"><h2>Último pedido</h2>' + (last ? orderHtml(last) : '<p class="acct__muted">Aún no has hecho pedidos.</p><a class="acct__btn" href="' + esc(host.dataset.shopUrl) + '">Ver el catálogo</a>') + '</div>';
  }
  function tabPedidos(c) {
    var os = c.orders.nodes;
    return '<div class="acct__card"><h2>Mis pedidos</h2>' + (os.length ? os.map(orderHtml).join('') : '<p class="acct__muted">Aún no has hecho pedidos.</p>') + '</div>';
  }
  function tabEspecias(c) {
    var m = {};
    c.orders.nodes.forEach(function (o) { o.lineItems.nodes.forEach(function (l) { var x = m[l.title] || (m[l.title] = { t: l.title, n: 0, img: l.image && l.image.url }); x.n += l.quantity; }); });
    var arr = Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) { return b.n - a.n; });
    if (!arr.length) return '<div class="acct__card"><h2>Mis especias</h2><p class="acct__muted">Cuando hagas tu primer pedido, tus especias aparecen aquí para volver a pedirlas.</p></div>';
    return '<div class="acct__card"><h2>Mis especias</h2><div class="acct__spice">' + arr.map(function (x) {
      return '<a href="/search?q=' + encodeURIComponent(x.t) + '">' + (x.img ? '<img src="' + esc(x.img) + '" alt="" loading="lazy">' : '<img alt="">') + '<b>' + esc(x.t) + '</b><span class="acct__muted">Comprada ' + x.n + (x.n === 1 ? ' vez' : ' veces') + '</span><span class="acct__btn acct__btn--sm">Volver a pedir</span></a>';
    }).join('') + '</div></div>';
  }
  function tabDirecciones(c) {
    var def = c.defaultAddress && c.defaultAddress.id;
    var cards = c.addresses.nodes.map(function (a) {
      return '<div class="acct__addr">' + (a.id === def ? '<span class="acct__tag">Predeterminada</span>' : '') +
        '<div>' + (a.formatted || []).map(esc).join('<br>') + '</div>' +
        '<div class="acct__acts"><button class="acct__btn acct__btn--ghost acct__btn--sm" data-a="addr-edit" data-id="' + esc(a.id) + '">Editar</button>' +
        '<button class="acct__btn acct__btn--ghost acct__btn--sm" data-a="addr-del" data-id="' + esc(a.id) + '">Eliminar</button></div></div>';
    }).join('');
    return '<div class="acct__card"><h2>Mis direcciones</h2><div class="acct__grid">' + cards + '<div class="acct__addr acct__addr--add" data-a="addr-new">+ Agregar dirección</div></div></div>';
  }
  function tabPerfil(c) {
    return '<div class="acct__card"><h2>Mis datos</h2><form class="acct__form" data-form="profile">' +
      '<label>Nombre<input name="firstName" value="' + esc(c.firstName) + '"></label><label>Apellido<input name="lastName" value="' + esc(c.lastName) + '"></label>' +
      '<label class="full">Correo<input value="' + esc(c.emailAddress && c.emailAddress.emailAddress) + '" disabled></label>' +
      '<div class="full"><button class="acct__btn" type="submit">Guardar cambios</button></div></form>' +
      '<p class="acct__muted" style="margin-top:14px">El correo se cambia desde el inicio de sesión de Shopify.</p></div>';
  }

  var TABS = [['resumen', 'Resumen', tabResumen], ['pedidos', 'Pedidos', tabPedidos], ['especias', 'Mis especias', tabEspecias], ['direcciones', 'Direcciones', tabDirecciones], ['perfil', 'Perfil', tabPerfil]];

  function render() {
    if (DRAWER) return drawerRender();
    var c = state.customer;
    var view = TABS.filter(function (t) { return t[0] === state.tab; })[0] || TABS[0];
    root.innerHTML = '<div class="acct__head"><div><h1>¡Hola' + (c.firstName ? ', ' + esc(c.firstName) : '') + '!</h1><p>' + esc(c.emailAddress && c.emailAddress.emailAddress || '') + '</p></div>' +
      '<a class="acct__btn acct__btn--ghost acct__btn--sm" href="' + esc(host.dataset.shopUrl) + '">Seguir comprando</a></div>' +
      (state.msg ? '<div class="acct__msg' + (state.msg.err ? ' acct__msg--err' : '') + '" style="margin-bottom:14px">' + esc(state.msg.t) + '</div>' : '') +
      '<div class="acct__layout"><nav class="acct__nav">' + TABS.map(function (t) { return '<button data-a="tab" data-t="' + t[0] + '" class="' + (t[0] === state.tab ? 'is-on' : '') + '">' + t[1] + '</button>'; }).join('') +
      '<hr><button data-a="logout">Cerrar sesión</button></nav><div class="acct__panel">' + view[2](c) + '</div></div>';
    state.msg = null; show();
  }

  /* ---------- Panel lateral (cuenta dentro del slide) ---------- */
  var IC = {
    especieros: '<path d="M4 20V8l4-4h8l4 4v12M4 20h16M7 11h10M7 15h10M9 8v3M12 8v3M15 8v3M9 15v-4M12 15v-4M15 15v-4"/>',
    pedidos: '<path d="m21 8-9-5-9 5v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    perfil: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
    direcciones: '<path d="M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="9" r="2.5"/>',
    recetas: '<path d="M6 4h10a2 2 0 0 1 2 2v14l-4-2-4 2-4-2V6a2 2 0 0 1 2-2Z"/><path d="M9 9h6M9 13h4"/>',
    favoritos: '<path d="M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9Z"/>',
    puntos: '<circle cx="12" cy="12" r="8.5"/><path d="m12 7.5 1.4 2.9 3.1.4-2.3 2.2.6 3.1-2.8-1.5-2.8 1.5.6-3.1-2.3-2.2 3.1-.4Z"/>',
    chev: '<path d="m9 6 6 6-6 6"/>', back: '<path d="m15 6-6 6 6 6"/>',
    salir: '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M16 17l5-5-5-5M21 12H9"/>'
  };
  function ic(n) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + IC[n] + '</svg>'; }
  var DTITLE = { pedidos: 'Mis pedidos', perfil: 'Mis datos', direcciones: 'Mis direcciones', favoritos: 'Mis favoritos', puntos: 'Mi cash back', especieros: 'Mis especieros', recetas: 'Mis recetas', repuestos: 'Pedir repuestos', addr: 'Dirección' };
  /* Cash back: % de cada compra pagada (productos sin envío ni IVA). El servidor lleva el saldo y crea los códigos. */
  var PUNTOS_PCT = Number(host.dataset.pointsPct || 5) / 100;
  var CB_MIN = Number(host.dataset.pointsMin || 1000);
  function puntos(c) {
    if (state.cb && state.cb.balance != null) return { total: state.cb.balance, cur: state.cb.currency, rows: state.cb.earned.map(function (r) { return { name: r.name, date: r.date, p: r.amount }; }), live: true };
    var rows = c.orders.nodes.filter(function (o) { return o.financialStatus === 'PAID'; }).map(function (o) {
      return { name: o.name, date: o.processedAt, p: Math.floor(Number(o.totalPrice.amount) / 1.13 * PUNTOS_PCT) };
    });
    return { total: rows.reduce(function (a, r) { return a + r.p; }, 0), rows: rows, cur: (c.orders.nodes[0] && c.orders.nodes[0].totalPrice.currencyCode) || 'CRC', live: false };
  }
  function loadCashback(force) {
    if (state.cb && !force && (state.cb.balance != null || state.cb.off || state.cb.loading)) return;
    state.cb = { loading: true };
    fetch('/apps/tramo/cashback', { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (r) {
      var ct = r.headers.get('content-type') || '';
      if (!r.ok || ct.indexOf('json') < 0) throw new Error('off');
      return r.json();
    }).then(function (d) { state.cb = d; }).catch(function () { state.cb = { off: true }; }).then(function () { if (state.customer) drawerRender(); });
  }
  function copyCode(code, btn) {
    function done() { if (btn) { var t = btn.textContent; btn.textContent = '¡Copiado!'; btn.classList.add('is-ok'); setTimeout(function () { btn.textContent = t; btn.classList.remove('is-ok'); }, 1600); } }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, function () { fallback(); });
    else fallback();
    function fallback() { var i = document.createElement('input'); i.value = code; i.setAttribute('readonly', ''); i.style.position = 'fixed'; i.style.opacity = '0'; document.body.appendChild(i); i.select(); try { document.execCommand('copy'); done(); } catch (e) {} i.remove(); }
  }
  function tabPuntos(c) {
    loadCashback();
    var P = puntos(c), cb = state.cb || {}, cur = P.cur;
    var m = function (n) { return esc(money({ amount: n, currencyCode: cur })); };
    var pct = Math.min(100, Math.round(P.total / CB_MIN * 100));
    var falta = Math.max(0, CB_MIN - P.total);
    var h = '<div class="acd__pts"><small>Tu cash back</small><b>' + m(P.total) + '</b>' +
      '<span>' + (cb.loading ? 'Calculando…' : (falta > 0 ? 'Te faltan ' + m(falta) + ' para generar tu primer código' : (P.live ? 'Listo para convertir en código' : 'Ya alcanzas para un código'))) + '</span>' +
      (falta > 0 ? '<div class="acd__prog" role="progressbar" aria-valuemin="0" aria-valuemax="' + CB_MIN + '" aria-valuenow="' + P.total + '"><i style="width:' + Math.max(pct, 3) + '%"></i></div>' : '') + '</div>';
    if (state.newCode) {
      h += '<div class="acd__newcode"><small>Tu código está listo</small><code>' + esc(state.newCode.code) + '</code><button type="button" class="acct__btn" data-a="copy" data-code="' + esc(state.newCode.code) + '">Copiar código</button><p>Pégalo en el checkout, en "Código de descuento o tarjeta de regalo".</p></div>';
    }
    if (P.live) {
      var can = P.total >= CB_MIN;
      if (can) h += '<form class="acd__redeem" data-form="redeem"><label>Monto a convertir en código<div class="acd__amt"><span>₡</span><input name="amount" type="number" inputmode="numeric" min="' + CB_MIN + '" max="' + P.total + '" step="1" value="' + (can ? P.total : '') + '"' + (can ? '' : ' disabled') + '></div></label>' +
        '<button class="acct__btn" type="submit"' + (can ? '' : ' disabled') + '>Generar código</button>' +
        '</form>';
    } else if (cb.off) {
      h += '<div class="acd__note"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span>Muy pronto podrás convertir tu saldo en códigos para el checkout. Tu cash back ya se está sumando.</span></div>';
    }
    var codes = (cb.codes || []);
    if (codes.length) {
      h += '<h4 class="acd__sub">Mis códigos</h4><ul class="acd__codes">' + codes.map(function (k) {
        var used = k.balance <= 0 || !k.enabled;
        return '<li class="' + (used ? 'is-used' : '') + '"><div><code>' + esc(k.code || ('•••• ' + k.last)) + '</code><small>' + (used ? 'Usado' : 'Disponible ' + m(k.balance) + (k.balance !== k.amount ? ' de ' + m(k.amount) : '')) + '</small></div>' +
          (k.code && !used ? '<button type="button" class="acct__btn acct__btn--ghost acct__btn--sm" data-a="copy" data-code="' + esc(k.code) + '">Copiar</button>' : '') + '</li>';
      }).join('') + '</ul>';
    }
    h += '<p class="acct__muted acd__pts-how">Cada compra pagada suma el ' + Math.round(PUNTOS_PCT * 100) + '% de los productos (sin envío ni IVA). No vence. Con tu saldo generas un código y lo pegas en el checkout.</p>';
    h += P.rows.length ? '<h4 class="acd__sub">Cómo lo ganaste</h4><ul class="acd__ptslist">' + P.rows.map(function (r) {
      return '<li><span>Pedido ' + esc(r.name) + '<small>' + esc(fdate(r.date)) + '</small></span><b>+' + m(r.p) + '</b></li>';
    }).join('') + '</ul>' : '<p class="acct__muted">Haz tu primera compra y empieza a sumar.</p>';
    return h;
  }
  /* Mis recetas: las guardadas con ♥ en el Blog */
  function recipeList() { try { var v = JSON.parse(localStorage.getItem('tramo_recipes') || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function tabRecetas() {
    var rs = recipeList();
    if (!rs.length) return '<div class="acd__empty-rack"><span class="acd__ico">' + ic('recetas') + '</span><b>Aún no guardas recetas</b><p class="acct__muted">En el Blog toca el ♥ de una receta o video y aparece aquí para cocinarla cuando quieras.</p><a class="acct__btn acct__btn--sm" href="/blogs/recetas">Ir al Blog</a></div>';
    return '<ul class="acd__recipes" role="list">' + rs.map(function (r) {
      return '<li><a href="' + esc(r.url) + '"><span class="acd__rimg">' + (r.img ? '<img src="' + esc(r.img) + '" alt="" loading="lazy">' : ic('recetas')) + '</span><b>' + esc(r.title) + '</b></a>' +
        '<button type="button" class="acd__unrec" data-a="unrec" data-h="' + esc(r.handle) + '" aria-label="Quitar ' + esc(r.title) + '">' + ic('chev').replace('m9 6 6 6-6 6', 'M6 6l12 12M18 6 6 18') + '</button></li>';
    }).join('') + '</ul><a class="acct__btn acct__btn--ghost acct__btn--sm acd__rmore" href="/blogs/recetas">Ver más recetas</a>';
  }

  /* Favoritos: los mismos corazones de la tienda */
  function likeList() { try { var v = JSON.parse(localStorage.getItem('tramo_likes') || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  var favCache = {};
  function tabFavoritos() {
    var hs = likeList();
    if (!hs.length) return '<p class="acct__muted">Toca el ♥ en cualquier producto y aparece aquí.</p><a class="acct__btn acct__btn--sm" href="' + esc(host.dataset.shopUrl || '/collections/all') + '">Ver productos</a>';
    setTimeout(loadFavs, 0);
    return '<div class="acd__favs" data-favs>' + hs.map(function (h) { return favCard(h, favCache[h]); }).join('') + '</div>';
  }
  function favCard(h, p) {
    if (!p) return '<div class="acd__fav is-loading" data-fav="' + esc(h) + '"><i></i><span></span></div>';
    var img = p.featured_image ? p.featured_image + (p.featured_image.indexOf('?') > -1 ? '&' : '?') + 'width=300' : '';
    return '<div class="acd__fav" data-fav="' + esc(h) + '"><a href="/products/' + encodeURIComponent(h) + '">' + (img ? '<img src="' + esc(img) + '" alt="" loading="lazy">' : '<i></i>') +
      '<b>' + esc(p.title) + '</b><small>' + (p.price_varies ? 'Desde ' : '') + esc(money({ amount: p.price / 100, currencyCode: host.dataset.currency || 'CRC' })) + '</small></a>' +
      '<button type="button" class="acd__unfav" data-a="unfav" data-h="' + esc(h) + '" aria-label="Quitar de favoritos"><svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9Z"/></svg></button></div>';
  }
  function loadFavs() {
    likeList().forEach(function (h) {
      if (favCache[h]) return;
      fetch('/products/' + encodeURIComponent(h) + '.js').then(function (r) { return r.ok ? r.json() : null; }).then(function (p) {
        var el = root.querySelector('[data-fav="' + (window.CSS && CSS.escape ? CSS.escape(h) : h) + '"]');
        if (!p) { if (el) el.remove(); return; }
        favCache[h] = p; if (el) el.outerHTML = favCard(h, p);
      }).catch(function () {});
    });
  }
  function plural(n, a, b) { return n + ' ' + (n === 1 ? a : b); }
  function drawerShell() {
    if (root.querySelector('.acd')) return;
    root.innerHTML = '<div class="acd"><div class="acd__pane acd__pane--home is-on" data-pane="home"></div><div class="acd__pane acd__pane--sub" data-pane="sub"></div></div>';
  }
  function drawerRender() {
    var c = state.customer;
    drawerShell();
    var home = root.querySelector('[data-pane="home"]'), sub = root.querySelector('[data-pane="sub"]');
    var name = [c.firstName, c.lastName].filter(Boolean).join(' ');
    var email = (c.emailAddress && c.emailAddress.emailAddress) || host.dataset.email || '';
    var n = c.orders.nodes.length, na = c.addresses.nodes.length;
    var msg = state.msg ? '<div class="acct__msg' + (state.msg.err ? ' acct__msg--err' : '') + '">' + esc(state.msg.t) + '</div>' : '';
    var rows = [
      ['pedidos', 'Mis pedidos', n ? plural(n, 'pedido', 'pedidos') : 'Aún no tienes pedidos'],
      ['especieros', 'Mis especieros', (state.racks || []).length ? plural(state.racks.length, 'especiero registrado', 'especieros registrados') + ' · pedir repuestos' : 'Registra el tuyo con el código QR'],
      ['perfil', 'Mis datos', name || 'Agrega tu nombre'],
      ['direcciones', 'Mis direcciones', na ? plural(na, 'dirección guardada', 'direcciones guardadas') : 'Agrega una dirección de entrega'],
      ['recetas', 'Mis recetas', recipeList().length ? plural(recipeList().length, 'receta guardada', 'recetas guardadas') : 'Guarda recetas del Blog con ♥'],
      ['favoritos', 'Mis favoritos', likeList().length ? plural(likeList().length, 'producto guardado', 'productos guardados') : 'Guarda lo que te gusta con ♥'],
      ['puntos', 'Mi cash back', money({ amount: puntos(c).total, currencyCode: puntos(c).cur }) + ' acumulado']
    ];
    home.innerHTML = '<div class="acd__me"><span class="acd__avatar">' + esc((c.firstName || email || '?').charAt(0).toUpperCase()) + '</span><div><b>' + (c.firstName ? 'Hola, ' + esc(c.firstName) : 'Hola') + '</b><small>' + esc(email) + '</small></div></div>' +
      (state.tab ? '' : msg) +
      '<ul class="acd__rows" role="list">' + rows.map(function (r) {
        return '<li><button type="button" data-a="go" data-t="' + r[0] + '"><span class="acd__ico">' + ic(r[0]) + '</span><span class="acd__txt"><b>' + r[1] + '</b><small>' + esc(r[2]) + '</small></span><span class="acd__chev">' + ic('chev') + '</span></button></li>';
      }).join('') + '</ul>' +
      '<button type="button" class="acd__logout" data-a="logout">' + ic('salir') + 'Cerrar sesión</button>';
    var t = state.tab;
    if (t) {
      var body = '';
      if (t === 'addr') body = addrFormHtml(state.addr);
      else if (t === 'favoritos') body = tabFavoritos();
      else if (t === 'recetas') body = tabRecetas();
      else if (t === 'puntos') body = tabPuntos(c);
      else if (t === 'especieros') body = tabEspecieros();
      else if (t === 'repuestos') body = tabRepuestos();
      else { var v = TABS.filter(function (x) { return x[0] === t; })[0]; body = v ? v[2](c) : ''; }
      var bk = t === 'addr' ? ['direcciones', 'Mis direcciones'] : t === 'repuestos' ? ['especieros', 'Mis especieros'] : null;
      sub.innerHTML = '<button type="button" class="acd__back" data-a="' + (bk ? 'go' : 'home') + '" data-t="' + (bk ? bk[0] : '') + '">' + ic('back') + (bk ? bk[1] : 'Mi cuenta') + '</button>' +
        '<h3 class="acd__title">' + (t === 'addr' ? (state.addr && state.addr.id ? 'Editar dirección' : 'Nueva dirección') : DTITLE[t]) + '</h3>' + msg + '<div class="acd__body">' + body + '</div>';
    }
    home.classList.toggle('is-on', !t);
    sub.classList.toggle('is-on', !!t);
    home.setAttribute('aria-hidden', t ? 'true' : 'false');
    sub.setAttribute('aria-hidden', t ? 'false' : 'true');
    state.msg = null; show();
  }
  function drawerGo(t, addr) {
    state.tab = t; state.addr = addr || null;
    drawerRender();
    var sc = host.closest('.account-panel__body') || host.parentNode;
    if (sc && sc.scrollTo) sc.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------- Dirección (modal) ---------- */
  var ZONAS = [['SJ', 'San José'], ['A', 'Alajuela'], ['C', 'Cartago'], ['H', 'Heredia'], ['G', 'Guanacaste'], ['P', 'Puntarenas'], ['L', 'Limón']];
  function addrForm(a) {
    if (DRAWER) return drawerGo('addr', a);
    var m = document.createElement('div'); m.className = 'acct__modal';
    m.innerHTML = '<div><h3>' + (a && a.id ? 'Editar dirección' : 'Nueva dirección') + '</h3>' + addrFormHtml(a) + '</div>';
    document.body.appendChild(m);
  }
  function addrFormHtml(a) {
    a = a || {};
    return '<form class="acct__form" data-form="addr" data-id="' + esc(a.id || '') + '">' +
      '<label>Nombre<input name="firstName" value="' + esc(a.firstName) + '" required></label><label>Apellido<input name="lastName" value="' + esc(a.lastName) + '"></label>' +
      '<label class="full">Dirección<input name="address1" value="' + esc(a.address1) + '" required></label>' +
      '<label class="full">Señas / apartamento<input name="address2" value="' + esc(a.address2) + '"></label>' +
      '<label>Ciudad / cantón<input name="city" value="' + esc(a.city) + '" required></label>' +
      '<label>Provincia<select name="zoneCode">' + ZONAS.map(function (z) { return '<option value="' + z[0] + '"' + (a.zoneCode === z[0] ? ' selected' : '') + '>' + z[1] + '</option>'; }).join('') + '</select></label>' +
      '<label>Código postal<input name="zip" value="' + esc(a.zip) + '"></label><label>Teléfono<input name="phoneNumber" value="' + esc(a.phoneNumber) + '"></label>' +
      '<label class="full acct__check"><input type="checkbox" name="def"> Usar como predeterminada</label>' +
      '<div class="full" style="display:flex;gap:10px"><button class="acct__btn" type="submit">Guardar</button><button class="acct__btn acct__btn--ghost" type="button" data-a="modal-close">Cancelar</button></div></form>';
  }
  function closeModal() { var m = document.querySelector('.acct__modal'); if (m) m.remove(); }

  function mut(query, vars, okMsg) {
    return gql(query, vars).then(function (d) {
      var k = Object.keys(d)[0], errs = (d[k] && d[k].userErrors) || [];
      if (errs.length) { state.msg = { t: errs[0].message, err: true }; return; }
      state.msg = { t: okMsg };
      if (DRAWER && state.tab === 'addr') { state.tab = 'direcciones'; state.addr = null; }
      return load();
    }).catch(function (e) { state.msg = { t: e.message === 'auth' ? 'Tu sesión venció. Entra de nuevo.' : 'No se pudo guardar: ' + e.message, err: true }; })
      .then(function () { closeModal(); render(); });
  }

  /* ---------- Eventos ---------- */
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-a]'); if (!b || !host.contains(b) && !b.closest('.acct__modal')) return;
    var a = b.dataset.a;
    if (a === 'login') { b.disabled = true; login(); }
    else if (a === 'tab') { state.tab = b.dataset.t; render(); window.scrollTo({ top: host.offsetTop, behavior: 'smooth' }); }
    else if (a === 'go') { if (b.dataset.r != null) state.rackIdx = Number(b.dataset.r) || 0; if (b.dataset.t === 'repuestos') state.refillQ = ''; drawerGo(b.dataset.t); }
    else if (a === 'home') { state.newCode = null; drawerGo(''); }
    else if (a === 'copy') copyCode(b.dataset.code, b);
    else if (a === 'refill-one') { state.rackIdx = Number(b.dataset.r) || 0; state.refillQ = ''; drawerGo('repuestos'); }
    else if (a === 'refill-add') addRefill(b.dataset.h, b);
    else if (a === 'kind') { state.refillKind = b.dataset.k; drawerRender(); }
    else if (a === 'rtab') { state.refillTab = b.dataset.g; state.refillQ = ''; drawerRender(); }
    else if (a === 'unrec') {
      var rl = recipeList().filter(function (x) { return x.handle !== b.dataset.h; });
      try { localStorage.setItem('tramo_recipes', JSON.stringify(rl)); } catch (er) {}
      drawerRender();
    }
    else if (a === 'unfav') {
      var hs = likeList().filter(function (x) { return x !== b.dataset.h; });
      try { localStorage.setItem('tramo_likes', JSON.stringify(hs)); } catch (er) {}
      var card = b.closest('.acd__fav'); if (card) { card.classList.add('is-gone'); setTimeout(function () { drawerRender(); }, 260); }
      document.dispatchEvent(new CustomEvent('tramo:likes-changed'));
    }
    else if (a === 'logout' && DRAWER) { del(KEY); location.href = host.dataset.logoutUrl || '/account/logout'; }
    else if (a === 'logout') {
      var t = get(KEY); del(KEY);
      discover().then(function () {
        if (cfg.logout) location.href = cfg.logout + '?' + new URLSearchParams({ id_token_hint: (t && t.id) || '', post_logout_redirect_uri: location.origin + location.pathname }).toString();
        else location.reload();
      });
    }
    else if (a === 'addr-new') addrForm();
    else if (a === 'addr-edit') addrForm(state.customer.addresses.nodes.filter(function (x) { return x.id === b.dataset.id; })[0]);
    else if (a === 'addr-del') { if (confirm('¿Eliminar esta dirección?')) mut('mutation($id: ID!){ customerAddressDelete(addressId: $id){ deletedAddressId userErrors{ message } } }', { id: b.dataset.id }, 'Dirección eliminada.'); }
    else if (a === 'modal-close') { if (DRAWER) drawerGo('direcciones'); else closeModal(); }
  });
  document.addEventListener('submit', function (e) {
    var f = e.target.closest('[data-form]'); if (!f || !(host.contains(f) || f.closest('.acct__modal'))) return; e.preventDefault();
    var sb = f.querySelector('[type="submit"]'); if (sb) { sb.disabled = true; sb.textContent = f.dataset.form === 'redeem' ? 'Generando…' : 'Guardando…'; }
    if (f.dataset.form === 'redeem') {
      var amt = Math.floor(Number(new FormData(f).get('amount') || 0));
      fetch('/apps/tramo/cashback/redeem', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ amount: amt }) })
        .then(function (r) { return r.json().catch(function () { return { error: 'No se pudo generar el código.' }; }); })
        .then(function (d) {
          if (d && d.ok) { state.cb = d.state; state.newCode = { code: d.code }; state.msg = null; }
          else state.msg = { t: (d && d.error) || 'No se pudo generar el código.', err: true };
        }).catch(function () { state.msg = { t: 'No se pudo conectar. Intenta de nuevo.', err: true }; })
        .then(function () { drawerRender(); });
      return;
    }
    var d = {}; new FormData(f).forEach(function (v, k) { d[k] = v; });
    if (f.dataset.form === 'profile') {
      mut('mutation($i: CustomerUpdateInput!){ customerUpdate(input: $i){ customer{ id } userErrors{ message } } }', { i: { firstName: d.firstName, lastName: d.lastName } }, 'Datos actualizados.');
    } else {
      var addr = { firstName: d.firstName, lastName: d.lastName, address1: d.address1, address2: d.address2, city: d.city, zoneCode: d.zoneCode, zip: d.zip, phoneNumber: d.phoneNumber, territoryCode: 'CR' };
      var def = !!d.def;
      if (f.dataset.id) mut('mutation($id: ID!, $a: CustomerAddressInput!, $d: Boolean){ customerAddressUpdate(addressId: $id, address: $a, defaultAddress: $d){ customerAddress{ id } userErrors{ message } } }', { id: f.dataset.id, a: addr, d: def }, 'Dirección actualizada.');
      else mut('mutation($a: CustomerAddressInput!, $d: Boolean){ customerAddressCreate(address: $a, defaultAddress: $d){ customerAddress{ id } userErrors{ message } } }', { a: addr, d: def }, 'Dirección agregada.');
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
  var rqT;
  document.addEventListener('input', function (e) {
    if (!e.target.matches || !e.target.matches('[data-refill-q]') || !host.contains(e.target)) return;
    state.refillQ = e.target.value;
    clearTimeout(rqT); rqT = setTimeout(function () {
      var pos = e.target.selectionStart; drawerRender();
      var i = root.querySelector('[data-refill-q]'); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (er) {} }
    }, 220);
  });

  /* ---------- Arranque ---------- */
  function start() {
    return handleCallback().catch(function () { return false; }).then(function () { return accessToken(); }).then(function (tok) {
      if (!tok) {
        /* Ya inició sesión en la tienda: entra directo (Shopify reconoce la sesión y vuelve sin pedir código) */
        if (host.dataset.signedIn === '1' && !ses('tramo.acct.auto')) { ses('tramo.acct.auto', 1); if (loading) loading.textContent = 'Conectando tu cuenta…'; return login(); }
        return loginView();
      }
      return load().then(function () { if (DRAWER && typeof pendingTab === 'string' && pendingTab) { state.tab = pendingTab; pendingTab = ''; } render(); }).catch(function (e) { del(KEY); loginView(e.message === 'auth' ? '' : 'No pudimos cargar tu cuenta. Intenta entrar de nuevo.'); });
    }).catch(function () { loginView('No pudimos conectar con tu cuenta. Intenta de nuevo.'); });
  }
  if (!DRAWER) { start(); return; }
  var started = false;
  function startOnce() { if (started) return; started = true; start(); }
  var pendingTab = '';
  document.addEventListener('click', function (e) {
    var op = e.target.closest && e.target.closest('[data-open="account"]');
    if (!op) return;
    pendingTab = op.getAttribute('data-acct-tab') || '';
    startOnce();
    if (state.customer) {
      if (get(PENDING)) { registerPending().then(function () { drawerGo('especieros'); pendingTab = ''; }); return; }
      drawerGo(pendingTab); pendingTab = '';
    }
  });
  /* Volvió del inicio de sesión: abrir el panel de nuevo */
  if (location.hash === '#mi-cuenta') {
    history.replaceState({}, '', location.pathname + location.search);
    startOnce();
    var tries = 0;
    (function openIt() {
      var op = document.querySelector('[data-open="account"]');
      if (op && document.readyState !== 'loading') { op.click(); return; }
      if (++tries < 40) setTimeout(openIt, 50);
    })();
  }
})();
