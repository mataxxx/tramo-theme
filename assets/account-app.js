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
  function money(m) { try { return new Intl.NumberFormat('es-CR', { style: 'currency', currency: m.currencyCode, maximumFractionDigits: 0 }).format(Number(m.amount)); } catch (e) { return m.amount + ' ' + m.currencyCode; } }
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
    return gql(Q).then(function (d) { state.customer = d.customer; });
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
    pedidos: '<path d="m21 8-9-5-9 5v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    perfil: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
    direcciones: '<path d="M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="9" r="2.5"/>',
    especias: '<path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14Z"/><path d="M5 19 13 11"/>',
    chev: '<path d="m9 6 6 6-6 6"/>', back: '<path d="m15 6-6 6 6 6"/>',
    salir: '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M16 17l5-5-5-5M21 12H9"/>'
  };
  function ic(n) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + IC[n] + '</svg>'; }
  var DTITLE = { pedidos: 'Mis pedidos', perfil: 'Mis datos', direcciones: 'Mis direcciones', especias: 'Mis especias', addr: 'Dirección' };
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
      ['perfil', 'Mis datos', name || 'Agrega tu nombre'],
      ['direcciones', 'Mis direcciones', na ? plural(na, 'dirección guardada', 'direcciones guardadas') : 'Agrega una dirección de entrega'],
      ['especias', 'Mis especias', 'Vuelve a pedir lo de siempre']
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
      else { var v = TABS.filter(function (x) { return x[0] === t; })[0]; body = v ? v[2](c) : ''; }
      sub.innerHTML = '<button type="button" class="acd__back" data-a="' + (t === 'addr' ? 'go' : 'home') + '" data-t="direcciones">' + ic('back') + (t === 'addr' ? 'Mis direcciones' : 'Mi cuenta') + '</button>' +
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
    else if (a === 'go') drawerGo(b.dataset.t);
    else if (a === 'home') drawerGo('');
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
    var sb = f.querySelector('[type="submit"]'); if (sb) { sb.disabled = true; sb.textContent = 'Guardando…'; }
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

  /* ---------- Arranque ---------- */
  function start() {
    return handleCallback().catch(function () { return false; }).then(function () { return accessToken(); }).then(function (tok) {
      if (!tok) {
        /* Ya inició sesión en la tienda: entra directo (Shopify reconoce la sesión y vuelve sin pedir código) */
        if (host.dataset.signedIn === '1' && !ses('tramo.acct.auto')) { ses('tramo.acct.auto', 1); if (loading) loading.textContent = 'Conectando tu cuenta…'; return login(); }
        return loginView();
      }
      return load().then(render).catch(function (e) { del(KEY); loginView(e.message === 'auth' ? '' : 'No pudimos cargar tu cuenta. Intenta entrar de nuevo.'); });
    }).catch(function () { loginView('No pudimos conectar con tu cuenta. Intenta de nuevo.'); });
  }
  if (!DRAWER) { start(); return; }
  var started = false;
  function startOnce() { if (started) return; started = true; start(); }
  document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('[data-open="account"]')) { startOnce(); if (state.customer && state.tab) drawerGo(''); } });
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
