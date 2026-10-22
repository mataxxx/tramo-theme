/* Tramo — cuenta de clientes propia (Customer Account API, OAuth PKCE en el navegador) */
(function () {
  var host = document.getElementById('tramo-account');
  if (!host) return;
  var root = host.querySelector('[data-acct-root]');
  var loading = host.querySelector('[data-acct-loading]');
  var CLIENT_ID = host.dataset.clientId;
  var SCOPE = 'openid email customer-account-api:full';
  var KEY = 'tramo.acct.tokens';
  var PKCE = 'tramo.acct.pkce';
  var API_VERSION = '2025-10';
  var cfg = null; // endpoints
  var state = { tab: 'resumen', customer: null, msg: null };
  try { var qt = new URLSearchParams(location.search).get('tab'); if (qt) state.tab = qt; } catch (e) {}

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function ses(k, v) { try { if (v === undefined) return JSON.parse(sessionStorage.getItem(k) || 'null'); sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }
  function money(m) { try { return new Intl.NumberFormat('es-CR', { style: 'currency', currency: m.currencyCode, maximumFractionDigits: 0 }).format(Number(m.amount)); } catch (e) { return m.amount + ' ' + m.currencyCode; } }
  function fdate(d) { try { return new Date(d).toLocaleDateString('es-CR', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return d; } }
  function redirectUri() { return location.origin + location.pathname; }

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
    return tokenRequest({ grant_type: 'authorization_code', client_id: CLIENT_ID, redirect_uri: redirectUri(), code: q.get('code'), code_verifier: p.v }).then(function () { return true; });
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
    var c = state.customer;
    var view = TABS.filter(function (t) { return t[0] === state.tab; })[0] || TABS[0];
    root.innerHTML = '<div class="acct__head"><div><h1>¡Hola' + (c.firstName ? ', ' + esc(c.firstName) : '') + '!</h1><p>' + esc(c.emailAddress && c.emailAddress.emailAddress || '') + '</p></div>' +
      '<a class="acct__btn acct__btn--ghost acct__btn--sm" href="' + esc(host.dataset.shopUrl) + '">Seguir comprando</a></div>' +
      (state.msg ? '<div class="acct__msg' + (state.msg.err ? ' acct__msg--err' : '') + '" style="margin-bottom:14px">' + esc(state.msg.t) + '</div>' : '') +
      '<div class="acct__layout"><nav class="acct__nav">' + TABS.map(function (t) { return '<button data-a="tab" data-t="' + t[0] + '" class="' + (t[0] === state.tab ? 'is-on' : '') + '">' + t[1] + '</button>'; }).join('') +
      '<hr><button data-a="logout">Cerrar sesión</button></nav><div class="acct__panel">' + view[2](c) + '</div></div>';
    state.msg = null; show();
  }

  /* ---------- Dirección (modal) ---------- */
  var ZONAS = [['SJ', 'San José'], ['A', 'Alajuela'], ['C', 'Cartago'], ['H', 'Heredia'], ['G', 'Guanacaste'], ['P', 'Puntarenas'], ['L', 'Limón']];
  function addrForm(a) {
    a = a || {};
    var m = document.createElement('div'); m.className = 'acct__modal';
    m.innerHTML = '<div><h3>' + (a.id ? 'Editar dirección' : 'Nueva dirección') + '</h3><form class="acct__form" data-form="addr" data-id="' + esc(a.id || '') + '">' +
      '<label>Nombre<input name="firstName" value="' + esc(a.firstName) + '" required></label><label>Apellido<input name="lastName" value="' + esc(a.lastName) + '"></label>' +
      '<label class="full">Dirección<input name="address1" value="' + esc(a.address1) + '" required></label>' +
      '<label class="full">Señas / apartamento<input name="address2" value="' + esc(a.address2) + '"></label>' +
      '<label>Ciudad / cantón<input name="city" value="' + esc(a.city) + '" required></label>' +
      '<label>Provincia<select name="zoneCode">' + ZONAS.map(function (z) { return '<option value="' + z[0] + '"' + (a.zoneCode === z[0] ? ' selected' : '') + '>' + z[1] + '</option>'; }).join('') + '</select></label>' +
      '<label>Código postal<input name="zip" value="' + esc(a.zip) + '"></label><label>Teléfono<input name="phoneNumber" value="' + esc(a.phoneNumber) + '"></label>' +
      '<label class="full acct__check"><input type="checkbox" name="def"> Usar como predeterminada</label>' +
      '<div class="full" style="display:flex;gap:10px"><button class="acct__btn" type="submit">Guardar</button><button class="acct__btn acct__btn--ghost" type="button" data-a="modal-close">Cancelar</button></div></form></div>';
    document.body.appendChild(m);
  }
  function closeModal() { var m = document.querySelector('.acct__modal'); if (m) m.remove(); }

  function mut(query, vars, okMsg) {
    return gql(query, vars).then(function (d) {
      var k = Object.keys(d)[0], errs = (d[k] && d[k].userErrors) || [];
      if (errs.length) { state.msg = { t: errs[0].message, err: true }; return; }
      state.msg = { t: okMsg };
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
    else if (a === 'modal-close') closeModal();
  });
  document.addEventListener('submit', function (e) {
    var f = e.target.closest('[data-form]'); if (!f) return; e.preventDefault();
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
  handleCallback().catch(function () { return false; }).then(function () { return accessToken(); }).then(function (tok) {
    if (!tok) {
      /* Ya inició sesión en la tienda: entra directo (Shopify reconoce la sesión y vuelve sin pedir código) */
      if (host.dataset.signedIn === '1' && !ses('tramo.acct.auto')) { ses('tramo.acct.auto', 1); return login(); }
      return loginView();
    }
    return load().then(render).catch(function (e) { del(KEY); loginView(e.message === 'auth' ? '' : 'No pudimos cargar tu cuenta. Intenta entrar de nuevo.'); });
  }).catch(function () { loginView('No pudimos conectar con tu cuenta. Intenta de nuevo.'); });
})();
