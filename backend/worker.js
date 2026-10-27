// Servidor de Tramo (Cloudflare Worker).
// Atiende dos rutas que Shopify reenvía desde la tienda (App Proxy):
//   GET  /apps/tramo/orders  -> pedidos del cliente que inició sesión (con etiquetas de estado)
//   POST /apps/tramo/ai      -> respuestas de IA sobre un producto (Claude)
//   GET  /apps/tramo/cashback         -> saldo de cash back y códigos del cliente
//   POST /apps/tramo/cashback/redeem  -> convierte saldo en un código (tarjeta de regalo) para el checkout
//   POST /apps/tramo/order   -> guarda el pedido de WhatsApp en el panel propio (Cloudflare KV) y avisa al dueño por WhatsApp
//   GET  /panel               -> panel de pedidos (PIN). Necesita: KV con binding ORDERS y el secreto PANEL_PIN
// Aviso por WhatsApp (opcional): OWNER_PHONE (ej. 50670170518) y CALLMEBOT_KEY
// Cash back (opcionales): CASHBACK_PCT (5), CASHBACK_TAX (0.13), CASHBACK_MIN (1000)
// Variables (secretas) que necesita: SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_SHOP, ANTHROPIC_API_KEY
// IA: por defecto usa Workers AI de Cloudflare (gratis, sin clave). Si no hay AI, usa Claude con ANTHROPIC_API_KEY.
// Opcionales: AI_MODEL, CLAUDE_MODEL, STORE_INFO

const enc = new TextEncoder();

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Verifica que la petición venga realmente de Shopify (firma del App Proxy).
async function verifyProxy(url, secret) {
  const params = new URLSearchParams(url.search);
  const signature = params.get('signature');
  if (!signature) return false;
  params.delete('signature');
  const grouped = {};
  for (const [k, v] of params.entries()) (grouped[k] = grouped[k] || []).push(v);
  const message = Object.keys(grouped).map((k) => `${k}=${grouped[k].join(',')}`).sort().join('');
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const calc = hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  if (calc.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < calc.length; i++) diff |= calc.charCodeAt(i) ^ signature.charCodeAt(i);
  const ts = parseInt(params.get('timestamp') || '0', 10);
  const fresh = Math.abs(Date.now() / 1000 - ts) < 600;
  return diff === 0 && fresh;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

// Token de la API de Shopify (dura 24 h; se guarda en memoria y se renueva).
let tokenCache = { value: null, exp: 0 };
async function adminToken(env) {
  if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  const res = await fetch(`https://${env.SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET, grant_type: 'client_credentials' })
  });
  if (!res.ok) throw new Error('No se pudo obtener el token de Shopify (' + res.status + ')');
  const data = await res.json();
  tokenCache = { value: data.access_token, exp: Date.now() + (data.expires_in - 300) * 1000 };
  return tokenCache.value;
}

async function adminGraphql(env, query, variables) {
  const token = await adminToken(env);
  const res = await fetch(`https://${env.SHOPIFY_SHOP}.myshopify.com/admin/api/2025-10/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query, variables })
  });
  const data = await res.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

const ORDERS_QUERY = `
query ($id: ID!) {
  customer(id: $id) {
    firstName
    email
    orders(first: 10, sortKey: PROCESSED_AT, reverse: true) {
      nodes {
        name
        processedAt
        tags
        cancelledAt
        displayFulfillmentStatus
        displayFinancialStatus
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        lineItems(first: 4) { nodes { title quantity image { url(transform: { maxWidth: 160 }) } } }
        subtotalLineItemsQuantity
      }
    }
  }
}`;

async function handleOrders(url, env) {
  const customerId = url.searchParams.get('logged_in_customer_id');
  if (!customerId) return json({ loggedIn: false, orders: [] });
  const data = await adminGraphql(env, ORDERS_QUERY, { id: `gid://shopify/Customer/${customerId}` });
  const c = data.customer;
  if (!c) return json({ loggedIn: true, orders: [] });
  return json({
    loggedIn: true,
    customer: { firstName: c.firstName, email: c.email },
    orders: c.orders.nodes.map((o) => ({
      name: o.name,
      date: o.processedAt,
      totalCents: Math.round(parseFloat(o.currentTotalPriceSet.shopMoney.amount) * 100),
      currency: o.currentTotalPriceSet.shopMoney.currencyCode,
      itemCount: o.subtotalLineItemsQuantity,
      cancelled: !!o.cancelledAt,
      fulfillment: o.displayFulfillmentStatus,
      payment: o.displayFinancialStatus,
      tags: o.tags,
      items: o.lineItems.nodes.map((i) => ({ title: i.title, quantity: i.quantity, image: i.image && i.image.url }))
    }))
  });
}

// ---------- Cash back ----------
// Gana: CASHBACK_PCT % de cada pedido pagado, sobre los productos sin envío y sin impuesto.
// Gasta: cada canje crea una tarjeta de regalo de Shopify a nombre del cliente (nota "Cash back Tramo").
// Saldo = ganado − suma de esas tarjetas. Los códigos se guardan en el cliente (metafield) para poder copiarlos otra vez.
const CB_NOTE = 'Cash back Tramo';
const CB_NS = 'tramo', CB_KEY = 'cashback_codes';
const CB_QUERY = `
query ($id: ID!, $q: String!, $after: String) {
  customer(id: $id) {
    metafield(namespace: "tramo", key: "cashback_codes") { value }
    orders(first: 100, after: $after, query: "financial_status:paid OR financial_status:partially_refunded") {
      pageInfo { hasNextPage endCursor }
      nodes { id name processedAt cancelledAt taxesIncluded currentSubtotalPriceSet { shopMoney { amount currencyCode } } }
    }
  }
  giftCards(first: 100, query: $q) { nodes { id note enabled balance { amount } initialValue { amount } lastCharacters createdAt } }
}`;

function cbCfg(env) {
  return { pct: Number(env.CASHBACK_PCT || 5) / 100, tax: Number(env.CASHBACK_TAX ?? 0.13), min: Number(env.CASHBACK_MIN || 1000) };
}

async function cashbackState(env, customerId) {
  const cfg = cbCfg(env);
  const gid = `gid://shopify/Customer/${customerId}`;
  let after = null, orders = [], c = null, cards = [];
  do {
    const d = await adminGraphql(env, CB_QUERY, { id: gid, q: `customer_id:${customerId}`, after });
    c = d.customer;
    if (!c) return null;
    if (!after) cards = d.giftCards.nodes.filter((g) => (g.note || '').startsWith(CB_NOTE));
    orders = orders.concat(c.orders.nodes);
    after = c.orders.pageInfo.hasNextPage ? c.orders.pageInfo.endCursor : null;
  } while (after);
  let currency = 'CRC';
  const earned = orders.filter((o) => !o.cancelledAt).map((o) => {
    const sub = parseFloat(o.currentSubtotalPriceSet.shopMoney.amount);
    currency = o.currentSubtotalPriceSet.shopMoney.currencyCode;
    const base = o.taxesIncluded ? sub / (1 + cfg.tax) : sub;
    return { name: o.name, date: o.processedAt, amount: Math.floor(base * cfg.pct) };
  });
  const totalEarned = earned.reduce((a, r) => a + r.amount, 0);
  const redeemed = cards.reduce((a, g) => a + Math.round(parseFloat(g.initialValue.amount)), 0);
  let saved = [];
  try { saved = JSON.parse((c.metafield && c.metafield.value) || '[]'); } catch (e) { saved = []; }
  const codes = cards.map((g) => {
    const s = saved.find((x) => x.id === g.id);
    return { id: g.id, code: s ? s.code : null, last: g.lastCharacters, amount: Math.round(parseFloat(g.initialValue.amount)), balance: Math.round(parseFloat(g.balance.amount)), enabled: g.enabled, date: g.createdAt };
  }).sort((a, b) => (a.date < b.date ? 1 : -1));
  return { gid, cfg, currency, earned, totalEarned, redeemed, balance: Math.max(0, totalEarned - redeemed), codes, saved };
}

function cbPublic(st) {
  return { pct: Math.round(st.cfg.pct * 100), min: st.cfg.min, currency: st.currency, earned: st.earned, totalEarned: st.totalEarned, redeemed: st.redeemed, balance: st.balance, codes: st.codes };
}

async function handleCashback(url, env) {
  const customerId = url.searchParams.get('logged_in_customer_id');
  if (!customerId) return json({ loggedIn: false }, 401);
  const st = await cashbackState(env, customerId);
  if (!st) return json({ loggedIn: false }, 401);
  return json(cbPublic(st));
}

const redeeming = new Set();
async function handleRedeem(request, url, env) {
  const customerId = url.searchParams.get('logged_in_customer_id');
  if (!customerId) return json({ error: 'Inicia sesión para canjear.' }, 401);
  if (redeeming.has(customerId)) return json({ error: 'Ya estamos generando tu código, espera un momento.' }, 429);
  redeeming.add(customerId);
  try {
    const body = await request.json().catch(() => ({}));
    const st = await cashbackState(env, customerId);
    if (!st) return json({ error: 'No encontramos tu cuenta.' }, 401);
    const amount = Math.floor(Number(body.amount || st.balance));
    if (!(amount >= st.cfg.min)) return json({ error: `El mínimo para generar un código es ${st.cfg.min}.` }, 400);
    if (amount > st.balance) return json({ error: 'El monto es mayor a tu saldo.' }, 400);
    const code = 'TRAMO' + [...crypto.getRandomValues(new Uint8Array(6))].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('') + [...crypto.getRandomValues(new Uint8Array(5))].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
    const made = await adminGraphql(env, `mutation ($i: GiftCardCreateInput!) { giftCardCreate(input: $i) { giftCard { id createdAt } giftCardCode userErrors { message } } }`,
      { i: { initialValue: String(amount), customerId: st.gid, note: `${CB_NOTE} (${new Date().toISOString().slice(0, 10)})`, code } });
    const r = made.giftCardCreate;
    if (r.userErrors.length || !r.giftCard) return json({ error: 'No se pudo generar el código: ' + (r.userErrors[0] && r.userErrors[0].message) }, 400);
    // Revisión de seguridad: si por un canje simultáneo el saldo quedó negativo, se anula este código.
    const after = await cashbackState(env, customerId);
    if (after && after.totalEarned - after.redeemed < 0) {
      await adminGraphql(env, `mutation ($id: ID!) { giftCardDeactivate(id: $id) { userErrors { message } } }`, { id: r.giftCard.id });
      return json({ error: 'Tu saldo cambió. Intenta de nuevo.' }, 409);
    }
    const saved = (after ? after.saved : st.saved).concat([{ id: r.giftCard.id, code: r.giftCardCode || code }]);
    await adminGraphql(env, `mutation ($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { message } } }`,
      { m: [{ ownerId: st.gid, namespace: CB_NS, key: CB_KEY, type: 'json', value: JSON.stringify(saved) }] });
    const fresh = await cashbackState(env, customerId);
    return json({ ok: true, code: r.giftCardCode || code, amount, state: cbPublic(fresh) });
  } finally {
    redeeming.delete(customerId);
  }
}

// Límite simple por visitante (se reinicia cuando el Worker se reinicia).
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 8;
}

const PRODUCT_QUERY = `
query ($handle: String!) {
  productByHandle(handle: $handle) {
    title description productType tags
    variants(first: 10) { nodes { title price } }
  }
}`;

async function handleAI(request, url, env) {
  const ip = request.headers.get('x-forwarded-for') || 'x';
  if (limited(ip)) return json({ answer: 'Estás preguntando muy rápido. Intenta de nuevo en un minuto o escríbenos por WhatsApp.' }, 429);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
  const question = String(body.question || '').slice(0, 300).trim();
  if (!question) return json({ error: 'empty' }, 400);
  const p = body.product || {};

  let info = `Producto: ${String(p.title || '').slice(0, 120)}\nDescripción: ${String(p.description || '').slice(0, 1200)}`;
  if (p.handle) {
    try {
      const d = await adminGraphql(env, PRODUCT_QUERY, { handle: String(p.handle).slice(0, 120) });
      const pr = d.productByHandle;
      if (pr) {
        info = `Producto: ${pr.title}\nTipo: ${pr.productType}\nEtiquetas: ${pr.tags.join(', ')}\nDescripción: ${(pr.description || '').slice(0, 1500)}\nPresentaciones y precios (colones): ${pr.variants.nodes.map((v) => `${v.title} ₡${Math.round(parseFloat(v.price))}`).join('; ')}`;
      }
    } catch (e) { /* si falla, se usa lo que mandó la página */ }
  }

  const system = [
    'Eres el asistente de Tramo San Rafael #1, una tienda costarricense de especias, semillas, frutas deshidratadas e insumos de repostería, con tradición desde 1946.',
    'Responde en español, cálido y directo, en máximo 4 oraciones o 90 palabras.',
    'Usa la información del producto de abajo. Puedes dar ideas de uso en cocina y conservación generales.',
    'Si no sabes algo concreto (disponibilidad, envíos, descuentos, ingredientes exactos, alergias), no inventes: invita a escribir por WhatsApp.',
    'No hagas afirmaciones médicas ni prometas efectos en la salud.',
    env.STORE_INFO ? 'Información de la tienda: ' + env.STORE_INFO : '',
    '--- INFORMACIÓN DEL PRODUCTO ---\n' + info
  ].filter(Boolean).join('\n');

  let text = '';
  if (env.AI) {
    // Cloudflare Workers AI (gratis dentro del límite diario)
    try {
      const out = await env.AI.run(env.AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
        max_tokens: 300
      });
      text = String((out && (out.response || (out.result && out.result.response))) || '').trim();
    } catch (e) { text = ''; }
  } else if (env.ANTHROPIC_API_KEY) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: env.CLAUDE_MODEL || 'claude-haiku-5-5', max_tokens: 350, system, messages: [{ role: 'user', content: question }] })
    });
    if (res.ok) {
      const data = await res.json();
      text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    }
  }
  if (!text) return json({ answer: 'No pude responder ahora. Escríbenos por WhatsApp y te ayudamos.' }, 502);
  return json({ answer: text });
}

// ---------- Pedidos de la tienda (WhatsApp + SINPE) y panel propio ----------
// Los pedidos se guardan en Cloudflare KV (binding ORDERS). Shopify NO crea pedidos ni cobra nada.
// Panel: https://<tu-worker>.workers.dev/panel  (PIN en la variable secreta PANEL_PIN)

const MODE_LABEL = { pickup: 'Retiro en el Mercado Central', delivery: 'Uber Flash', courier: 'Encomienda' };
const STATUSES = ['pago-pendiente', 'pagado', 'preparando', 'listo', 'entregado', 'cancelado'];

function clean(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, max || 200); }

async function notifyOwner(env, text) {
  if (!env.OWNER_PHONE || !env.CALLMEBOT_KEY) return false;
  const u = 'https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent(env.OWNER_PHONE) +
    '&text=' + encodeURIComponent(text.slice(0, 3500)) + '&apikey=' + encodeURIComponent(env.CALLMEBOT_KEY);
  try { const r = await fetch(u); return r.ok; } catch (e) { return false; }
}

async function handleNewOrder(request, env) {
  if (!env.ORDERS) return json({ error: 'falta configurar ORDERS' }, 500);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: 'datos inválidos' }, 400); }
  const raw = Array.isArray(b.items) ? b.items.slice(0, 60) : [];
  const name = clean(b.name, 80), phone = clean(b.phone, 30), code = clean(b.code, 20);
  const mode = MODE_LABEL[b.mode] ? b.mode : 'pickup';
  if (!raw.length || name.length < 2 || phone.replace(/\D/g, '').length < 8) return json({ error: 'pedido incompleto' }, 400);

  // Precio real de cada presentación desde Shopify (no se confía en el navegador)
  const ids = raw.map((it) => 'gid://shopify/ProductVariant/' + parseInt(it.variant_id, 10));
  let info = {};
  try {
    const pv = await adminGraphql(env, `query ($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id price title product { title } } } }`, { ids });
    (pv.nodes || []).forEach((n) => { if (n && n.id) info[n.id] = n; });
  } catch (e) { info = {}; }
  let total = 0;
  const items = raw.map((it, i) => {
    const n = info[ids[i]] || {};
    const qty = Math.min(10000, Math.max(1, parseInt(it.quantity, 10) || 1));
    const unit = parseFloat(n.price || it.unit || 0) || 0;
    const line = Math.round(unit * qty * 100) / 100;
    total += line;
    return { title: clean(n.product ? n.product.title : it.title, 120), variant: clean(it.label || n.title || '', 80), qty, line };
  });

  const now = Date.now();
  const order = {
    id: code || String(now), code, created: now, status: 'pago-pendiente',
    name, phone, mode, eta: clean(b.eta, 120),
    payer: clean(b.payer, 80), location: clean(b.location, 200), address: clean(b.address, 300), area: clean(b.area, 120),
    fe: clean(b.fe, 300), items, total: Math.round(total * 100) / 100,
    variable: (Array.isArray(b.variable) ? b.variable : []).slice(0, 20).map((x) => clean(x, 80)).filter(Boolean), message: clean(b.message, 4000), history: [{ s: 'pago-pendiente', t: now }]
  };
  const key = 'o:' + String(9999999999999 - now).padStart(13, '0') + ':' + order.id;
  order.key = key;
  await env.ORDERS.put(key, JSON.stringify(order));
  const head = '🛒 Pedido nuevo ' + (code || '') + ' · ' + (order.variable.length ? '≈ ' : '') + '₡' + Math.round(order.total).toLocaleString('es-CR') + ' · ' + MODE_LABEL[mode] + (order.eta ? ' · ' + order.eta : '') + (order.variable.length ? ' · ⚖️ pesar: ' + order.variable.join(', ') : '');
  const sent = await notifyOwner(env, head + '\n\n' + order.message);
  return json({ ok: true, notified: sent });
}

// ---------- Panel ----------
async function sign(env, val) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.PANEL_PIN + '|tramo'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(val)));
}
async function panelAuthed(request, env) {
  if (!env.PANEL_PIN) return false;
  const m = (request.headers.get('cookie') || '').match(/tp=([a-f0-9]+)\.(\d+)/);
  if (!m) return false;
  if (Date.now() - parseInt(m[2], 10) > 1000 * 60 * 60 * 24 * 60) return false;
  return (await sign(env, m[2])) === m[1];
}
const html = (body, status = 200, headers = {}) => new Response(body, { status, headers: Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, headers) });

async function handlePanel(request, url, env) {
  const p = url.pathname.replace(/\/+$/, '');
  if (p === '/panel/login' && request.method === 'POST') {
    const form = await request.formData();
    if (!env.PANEL_PIN || String(form.get('pin') || '') !== String(env.PANEL_PIN)) return html(loginPage('PIN incorrecto'), 401);
    const t = String(Date.now());
    return new Response(null, { status: 303, headers: { location: '/panel', 'set-cookie': `tp=${await sign(env, t)}.${t}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${60 * 60 * 24 * 60}` } });
  }
  if (!(await panelAuthed(request, env))) return p.startsWith('/panel/api') ? json({ error: 'login' }, 401) : html(loginPage(''));
  if (p === '/panel/api/orders' && request.method === 'GET') {
    const list = await env.ORDERS.list({ prefix: 'o:', limit: 150 });
    const out = await Promise.all(list.keys.map((k) => env.ORDERS.get(k.name, 'json')));
    return json({ orders: out.filter(Boolean) });
  }
  if (p === '/panel/api/status' && request.method === 'POST') {
    const b = await request.json();
    if ((b.status && !STATUSES.includes(b.status)) || !String(b.key || '').startsWith('o:')) return json({ error: 'datos' }, 400);
    const o = await env.ORDERS.get(b.key, 'json');
    if (!o) return json({ error: 'no existe' }, 404);
    if (b.status) { o.status = b.status; o.history = (o.history || []).concat({ s: b.status, t: Date.now() }); }
    if (b.finalTotal != null && isFinite(+b.finalTotal) && +b.finalTotal > 0) o.finalTotal = Math.round(+b.finalTotal);
    await env.ORDERS.put(b.key, JSON.stringify(o));
    return json({ ok: true, order: o });
  }
  if (p === '/panel') return html(PANEL_HTML);
  return json({ error: 'no encontrado' }, 404);
}

function loginPage(err) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pedidos · Tramo</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f1e6;font-family:system-ui,-apple-system,sans-serif;color:#1d2a1c}
form{background:#fff;padding:28px 24px;border-radius:20px;box-shadow:0 10px 30px rgba(38,61,37,.12);width:min(340px,90vw);text-align:center}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 18px;color:#6b7468;font-size:14px}
input{width:100%;box-sizing:border-box;font-size:22px;letter-spacing:6px;text-align:center;padding:12px;border:1.5px solid #263d25;border-radius:12px;margin-bottom:12px}
button{width:100%;padding:13px;border:0;border-radius:12px;background:#263d25;color:#fff;font-size:16px;font-weight:600}.e{color:#b3261e;margin-top:10px;font-size:14px}</style></head>
<body><form method="post" action="/panel/login"><h1>Pedidos · Tramo San Rafael</h1><p>Escribe tu PIN</p><input name="pin" type="password" inputmode="numeric" autocomplete="current-password" autofocus><button>Entrar</button>${err ? `<div class="e">${err}</div>` : ''}</form></body></html>`;
}

const PANEL_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Pedidos · Tramo</title><meta name="theme-color" content="#263d25">
<style>
:root{--g:#263d25;--g2:#6e9e58;--bg:#f6f1e6;--card:#fff;--line:#e4dccb;--mut:#6b7468;--txt:#1d2a1c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--txt)}
header{position:sticky;top:0;z-index:5;background:var(--g);color:#fff;padding:14px 16px calc(10px);padding-top:max(14px,env(safe-area-inset-top))}
header h1{margin:0;font-size:18px;display:flex;justify-content:space-between;align-items:center}
header small{font-weight:400;opacity:.8;font-size:12px}
.tabs{display:flex;gap:6px;overflow-x:auto;padding:10px 0 2px;scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}
.tab{flex:0 0 auto;border:0;border-radius:999px;padding:7px 12px;background:rgba(255,255,255,.14);color:#fff;font-size:13.5px;font-weight:600}
.tab.on{background:#fff;color:var(--g)}.tab b{margin-left:4px;opacity:.75}
main{padding:12px 12px 40px;max-width:760px;margin:0 auto;display:grid;gap:10px}
.o{background:var(--card);border-radius:16px;border:1px solid var(--line);overflow:hidden}
.o__top{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;cursor:pointer}
.o__main{flex:1;min-width:0}.o__name{font-weight:700;font-size:15.5px}.o__sub{color:var(--mut);font-size:13px;margin-top:2px}
.o__tot{font-weight:800;font-size:16px;white-space:nowrap;text-align:right}.o__ago{color:var(--mut);font-size:12px;font-weight:400;margin-top:2px}
.pill{display:inline-block;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:700;margin-top:6px}
.s-pago-pendiente{background:#fdf0d9;color:#8a5a10}.s-pagado{background:#e3eefc;color:#1d4f91}.s-preparando{background:#efe7fb;color:#5b3a99}
.s-listo{background:#dff1dc;color:#24602a}.s-var{background:#eef3fb;color:#1f3b63;margin-left:4px}.s-entregado{background:#eceee9;color:#4b5548}.s-cancelado{background:#f9e1df;color:#9b2c22}
.when{display:inline-block;margin-left:6px;font-size:12px;color:var(--g);font-weight:600}
.o__body{display:none;border-top:1px solid var(--line);padding:12px 14px;font-size:14px}.o.open .o__body{display:block}
.items{margin:0 0 10px;padding:0;list-style:none}.items li{display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px dashed var(--line)}
.items small{color:var(--mut)}.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;margin:8px 0}.kv dt{color:var(--mut)}.kv dd{margin:0;word-break:break-word}
.kv a{color:var(--g)}
.st{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 8px}.st button{border:1.5px solid var(--line);background:#fff;border-radius:10px;padding:8px 10px;font-size:13px;font-weight:600;color:var(--txt)}
.st button.on{border-color:var(--g);background:var(--g);color:#fff}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}.acts a{flex:1 1 140px;text-align:center;text-decoration:none;padding:11px;border-radius:12px;font-weight:700;font-size:14px;background:#25d366;color:#08331a}
.acts a.alt{background:#eef5ea;color:var(--g)}
.empty{text-align:center;color:var(--mut);padding:40px 10px}
.new{animation:flash 1.6s ease 2}@keyframes flash{50%{box-shadow:0 0 0 3px var(--g2)}}
</style></head><body>
<header><h1>Pedidos · Tramo <small id="upd"></small></h1><div class="tabs" id="tabs"></div></header>
<main id="list"><div class="empty">Cargando…</div></main>
<script>
const ST={'pago-pendiente':'Pago pendiente','pagado':'Pagado','preparando':'Preparando','listo':'Listo','entregado':'Entregado / enviado','cancelado':'Cancelado'};
const MODE={pickup:'Retiro',delivery:'Uber Flash',courier:'Encomienda'};
let orders=[],filter='activos',open={},known=null;
const money=n=>'₡'+Math.round(n||0).toLocaleString('es-CR');
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ago=t=>{const m=Math.round((Date.now()-t)/60000);if(m<1)return'ahora';if(m<60)return'hace '+m+' min';const h=Math.round(m/60);if(h<24)return'hace '+h+' h';return new Date(t).toLocaleDateString('es-CR',{day:'numeric',month:'short'})};
const wa=(o,t)=>'https://wa.me/506'+String(o.phone).replace(/\\D/g,'').slice(-8)+'?text='+encodeURIComponent(t);
const tot=o=>o.finalTotal||o.total;
function msgs(o){const n=o.name.split(' ')[0];return[
 ['Pedir pago','alt pay','¡Hola '+n+'! Recibimos tu pedido '+o.code+' 🙌 '+(o.variable&&o.variable.length&&!o.finalTotal?'Ya lo pesamos: ':'')+'El total es '+money(tot(o))+(o.mode!=='pickup'?' + envío':'')+'. Puedes pagar por SINPE Móvil y nos avisas. ¡Gracias!'],
 [o.mode==='pickup'?'Avisar: listo para recoger':o.mode==='delivery'?'Avisar: va en camino':'Avisar: encomienda enviada','',o.mode==='pickup'?'¡Hola '+n+'! Tu pedido '+o.code+' ya está listo ✅ Puedes pasar a recogerlo al Tramo San Rafael #1, Mercado Central (7:30 a. m. a 5:30 p. m.).':o.mode==='delivery'?'¡Hola '+n+'! Tu pedido '+o.code+' ya va en camino por Uber Flash 🛵 Por favor estate pendiente para recibirlo.':'¡Hola '+n+'! Tu pedido '+o.code+' ya fue enviado por encomienda 📦 Te llega en hasta 48 h.']
]}
function tabs(){const c={activos:0,todos:orders.length};orders.forEach(o=>{c[o.status]=(c[o.status]||0)+1;if(!['entregado','cancelado'].includes(o.status))c.activos++});
 const list=[['activos','Activos'],['pago-pendiente','Pago pendiente'],['pagado','Pagados'],['preparando','Preparando'],['listo','Listos'],['entregado','Entregados'],['cancelado','Cancelados'],['todos','Todos']];
 document.getElementById('tabs').innerHTML=list.map(([k,l])=>'<button class="tab'+(filter===k?' on':'')+'" data-f="'+k+'">'+l+'<b>'+(c[k]||0)+'</b></button>').join('')}
function render(){tabs();const L=orders.filter(o=>filter==='todos'||(filter==='activos'?!['entregado','cancelado'].includes(o.status):o.status===filter));
 const el=document.getElementById('list');if(!L.length){el.innerHTML='<div class="empty">No hay pedidos aquí.</div>';return}
 el.innerHTML=L.map(o=>{const isNew=known&&!known.has(o.key);return '<article class="o'+(open[o.key]?' open':'')+(isNew?' new':'')+'" data-k="'+esc(o.key)+'">'+
 '<div class="o__top" data-toggle><div class="o__main"><div class="o__name">'+esc(o.name)+' · '+esc(o.code)+'</div><div class="o__sub">'+esc(MODE[o.mode]||o.mode)+' · '+o.items.length+' producto'+(o.items.length>1?'s':'')+'</div>'+
 '<span class="pill s-'+o.status+'">'+ST[o.status]+'</span>'+(o.variable&&o.variable.length&&!o.finalTotal?'<span class="pill s-var">⚖️ Pesar</span>':'')+(o.eta?'<span class="when">'+esc(o.eta)+'</span>':'')+'</div>'+
 '<div class="o__tot">'+(o.variable&&o.variable.length&&!o.finalTotal?'≈ ':'')+money(tot(o))+(o.mode!=='pickup'?'<div class="o__ago">+ envío</div>':'')+'<div class="o__ago">'+ago(o.created)+'</div></div></div>'+
 '<div class="o__body"><ul class="items">'+o.items.map(i=>'<li><span>'+esc(i.title)+(i.variant?' <small>'+esc(i.variant)+'</small>':'')+(i.variant&&/granel/i.test(i.variant)?'':' <small>× '+i.qty+'</small>')+'</span><b>'+money(i.line)+'</b></li>').join('')+'</ul>'+
 '<dl class="kv"><dt>Teléfono</dt><dd><a href="tel:'+esc(o.phone)+'">'+esc(o.phone)+'</a></dd>'+(o.payer?'<dt>SINPE de</dt><dd>'+esc(o.payer)+'</dd>':'')+
 (o.location?'<dt>Ubicación</dt><dd><a href="'+esc(o.location)+'" target="_blank">Ver en el mapa</a></dd>':'')+(o.area?'<dt>Zona</dt><dd>'+esc(o.area)+'</dd>':'')+(o.address?'<dt>'+(o.mode==='courier'?'Dirección':'Señas')+'</dt><dd>'+esc(o.address)+'</dd>':'')+
 (o.fe?'<dt>Factura</dt><dd>'+esc(o.fe)+'</dd>':'')+'<dt>Pedido</dt><dd>'+new Date(o.created).toLocaleString('es-CR',{weekday:'short',day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})+'</dd></dl>'+
 '<div class="st">'+Object.keys(ST).map(s=>'<button data-s="'+s+'" class="'+(o.status===s?'on':'')+'">'+ST[s]+'</button>').join('')+'</div>'+
 (o.variable&&o.variable.length?'<p style="margin:0 0 8px;font-size:13px;color:#1f3b63">⚖️ Peso variable: '+esc(o.variable.join(', '))+'. Al pesar, toca <b>Pedir pago</b> y escribe el total exacto.</p>':'')+'<div class="acts">'+msgs(o).map(([l,c,t])=>'<a class="'+c+'" href="'+wa(o,t)+'" target="_blank">'+l+'</a>').join('')+'<a class="alt" href="'+wa(o,'')+'" target="_blank">WhatsApp</a></div></div></article>'}).join('')}
async function load(){try{const r=await fetch('/panel/api/orders',{cache:'no-store'});if(r.status===401){location.reload();return}const d=await r.json();
 const fresh=d.orders||[];if(known&&fresh.some(o=>!known.has(o.key))){try{navigator.vibrate&&navigator.vibrate(200)}catch(e){}}
 orders=fresh;render();known=new Set(orders.map(o=>o.key));document.getElementById('upd').textContent='actualizado '+new Date().toLocaleTimeString('es-CR',{hour:'numeric',minute:'2-digit'})}catch(e){}}
document.addEventListener('click',async e=>{const t=e.target.closest('[data-f]');if(t){filter=t.dataset.f;render();return}
 const card=e.target.closest('.o');if(!card)return;const k=card.dataset.k;
 if(e.target.closest('[data-toggle]')){open[k]=!open[k];card.classList.toggle('open');return}
 const pay=e.target.closest('a.pay');
 if(pay){const o=orders.find(x=>x.key===k);if(o&&o.variable&&o.variable.length){e.preventDefault();const v=prompt('Total exacto después de pesar (sin envío), en colones:',Math.round(tot(o)));if(!v)return;const n=parseInt(String(v).replace(/\\D/g,''),10);if(!n)return;
  const r=await fetch('/panel/api/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k,finalTotal:n})});if(r.ok){const d=await r.json();orders=orders.map(x=>x.key===k?d.order:x);render();const no=orders.find(x=>x.key===k);window.open(wa(no,msgs(no)[0][2]),'_blank')}}return}
 const s=e.target.closest('[data-s]');if(s){const r=await fetch('/panel/api/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k,status:s.dataset.s})});
  if(r.ok){const d=await r.json();orders=orders.map(o=>o.key===k?d.order:o);render()}}});
load();setInterval(load,30000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)load()});
</script></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/panel' || url.pathname.startsWith('/panel/')) return await handlePanel(request, url, env);
      if (!(await verifyProxy(url, env.SHOPIFY_CLIENT_SECRET))) return json({ error: 'firma inválida' }, 401);
      if (url.pathname.endsWith('/orders') && request.method === 'GET') return await handleOrders(url, env);
      if (url.pathname.endsWith('/ai') && request.method === 'POST') return await handleAI(request, url, env);
      if (url.pathname.endsWith('/cashback') && request.method === 'GET') return await handleCashback(url, env);
      if (url.pathname.endsWith('/cashback/redeem') && request.method === 'POST') return await handleRedeem(request, url, env);
      if (url.pathname.endsWith('/order') && request.method === 'POST') return await handleNewOrder(request, env);
      return json({ ok: true, service: 'tramo' });
    } catch (e) {
      return json({ error: 'error interno' }, 500);
    }
  }
};
