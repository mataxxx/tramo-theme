import PREP_HTML from './prep.html';
import PANEL_HTML from './panel.html';
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
  if (!secret) return false;
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
const STATUSES = ['incompleto', 'pago-pendiente', 'pagado', 'preparando', 'listo', 'entregado', 'cancelado'];
const INV_TYPES = ['FE', 'TE', 'TN'];
// Resumen corto guardado junto a cada pedido (KV metadata): sirve para el tablero de ventas sin leer cada pedido
function orderMeta(o) {
  const inv = (o.invoices || []).filter((i) => !i.voided);
  return { s: o.status, t: o.created, p: Math.round(o.finalTotal || o.total || 0), sh: Math.round(o.shipping || 0), m: o.mode,
    n: String(o.name || '').slice(0, 40), c: String(o.code || '').slice(0, 20), f: inv.length ? inv.map((i) => i.type + ' ' + i.num).join(', ').slice(0, 120) : '',
    r: String(o.sinpeRef || '').slice(0, 40), pd: o.paidAt || 0 };
}
async function putOrder(env, key, o) {
  await env.ORDERS.put(key, JSON.stringify(o), { metadata: orderMeta(o) });
  await env.ORDERS.put('ver', String(Date.now()));
}

function clean(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, max || 200); }

const STORE_ORIGINS = ['https://tramosanrafael.com', 'https://www.tramosanrafael.com', 'https://7gpmsb-un.myshopify.com'];

// Avisos al dueño: Telegram (TELEGRAM_TOKEN) y/o WhatsApp con CallMeBot (OWNER_PHONE + CALLMEBOT_KEY)
// Telegram: cada teléfono le escribe tu PIN del panel al bot una vez y queda registrado.
async function telegramChats(env) {
  let chats = [];
  try { chats = JSON.parse(await env.ORDERS.get('tg:chats') || '[]'); } catch (e) { chats = []; }
  try {
    const r = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_TOKEN + '/getUpdates?allowed_updates=%5B%22message%22%5D');
    const d = await r.json();
    let changed = false;
    for (const u of (d.result || [])) {
      const m = u.message; if (!m || !m.chat) continue;
      if (env.PANEL_PIN && String(m.text || '').trim() === String(env.PANEL_PIN) && !chats.includes(m.chat.id)) {
        chats.push(m.chat.id); changed = true;
        await fetch('https://api.telegram.org/bot' + env.TELEGRAM_TOKEN + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: m.chat.id, text: '✅ Listo. Aquí te van a llegar los pedidos de Tramo San Rafael. Puedes borrar el mensaje con tu PIN.' }) });
      }
    }
    const last = (d.result || []).slice(-1)[0];
    if (last) await fetch('https://api.telegram.org/bot' + env.TELEGRAM_TOKEN + '/getUpdates?offset=' + (last.update_id + 1));
    if (changed) await env.ORDERS.put('tg:chats', JSON.stringify(chats));
  } catch (e) {}
  return chats;
}
async function notifyOwner(env, text) {
  let ok = false;
  if (env.TELEGRAM_TOKEN && env.ORDERS) {
    const chats = await telegramChats(env);
    for (const id of chats) {
      try {
        const r = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_TOKEN + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: id, text: text.slice(0, 4000), disable_web_page_preview: true }) });
        if (r.ok) ok = true;
      } catch (e) {}
    }
  }
  if (env.OWNER_PHONE && env.CALLMEBOT_KEY) {
    const u = 'https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent(env.OWNER_PHONE) +
      '&text=' + encodeURIComponent(text.slice(0, 3500)) + '&apikey=' + encodeURIComponent(env.CALLMEBOT_KEY);
    try { const r = await fetch(u); if (r.ok) ok = true; } catch (e) {}
  }
  return ok;
}

async function handleNewOrder(request, env, ctx) {
  if (!env.ORDERS) return json({ error: 'falta configurar ORDERS' }, 500);
  let b;
  try { b = JSON.parse(await request.text()); } catch (e) { return json({ error: 'datos inválidos' }, 400); }
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
  const status = b.status === 'incompleto' ? 'incompleto' : 'pago-pendiente';
  // Si ya existe este pedido (borrador "sin terminar"), se actualiza en vez de duplicarlo
  let prev = null, prevKey = code ? await env.ORDERS.get('c:' + code) : null;
  if (prevKey) prev = await env.ORDERS.get(prevKey, 'json');
  if (prev && prev.status !== 'incompleto' && status === 'incompleto') return json({ ok: true, kept: true });
  const order = {
    id: code || String(now), code, created: prev ? prev.created : now, status,
    name, phone, mode, eta: clean(b.eta, 120),
    payer: clean(b.payer, 80), location: clean(b.location, 200), address: clean(b.address, 300), area: clean(b.area, 120),
    fe: clean(b.fe, 300), items, total: Math.round(total * 100) / 100,
    variable: (Array.isArray(b.variable) ? b.variable : []).slice(0, 20).map((x) => clean(x, 80)).filter(Boolean), message: clean(b.message, 4000), history: [{ s: 'pago-pendiente', t: now }]
  };
  if (prev) order.history = (prev.history || []).concat(status !== prev.status ? [{ s: status, t: now }] : []);
  else order.history = [{ s: status, t: now }];
  if (prev && prev.notifiedDraft) order.notifiedDraft = true;
  const key = prevKey || ('o:' + String(9999999999999 - now).padStart(13, '0') + ':' + order.id);
  order.key = key;
  await putOrder(env, key, order);
  if (code) await env.ORDERS.put('c:' + code, key, { expirationTtl: 60 * 60 * 24 * 30 });
  if (status === 'incompleto') return json({ ok: true, draft: true });
  const head = (prev && prev.notifiedDraft ? '✅ Se completó el pedido ' : '🛒 Pedido nuevo ') + (code || '') + ' · ' + (order.variable.length ? '≈ ' : '') + '₡' + Math.round(order.total).toLocaleString('es-CR') + ' · ' + MODE_LABEL[mode] + (order.eta ? ' · ' + order.eta : '') + (order.variable.length ? ' · ⚖️ pesar: ' + order.variable.join(', ') : '');
  const note = notifyOwner(env, head + '\n\n' + order.message);
  if (ctx) ctx.waitUntil(note); else await note;
  return json({ ok: true });
}

// ---------- Panel ----------
// Dos niveles de acceso: administrador (PANEL_PIN) y alistador (PREP_PIN, solo prepara pedidos pagados)
async function sign(env, val, role) {
  const secret = role === 'prep' ? env.PREP_PIN + '|prep' : env.PANEL_PIN + '|tramo';
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(val)));
}
async function panelAuthed(request, env) {
  const m = (request.headers.get('cookie') || '').match(/tp=([a-f0-9]+)\.(\d+)(?:\.(prep))?/);
  if (!m) return null;
  if (Date.now() - parseInt(m[2], 10) > 1000 * 60 * 60 * 24 * 60) return null;
  const role = m[3] === 'prep' ? 'prep' : 'admin';
  if (role === 'prep' && !env.PREP_PIN) return null;
  if (role === 'admin' && !env.PANEL_PIN) return null;
  return (await sign(env, role === 'prep' ? m[2] + '.prep' : m[2], role)) === m[1] ? role : null;
}
// Cambia con cada versión del panel: las pantallas abiertas se recargan solas
const APP_V = '2026-10-28-4';
const SOLD_ST = ['pagado', 'preparando', 'listo', 'entregado'];
function setStatusOn(o, st, now) {
  if (STATUSES.includes(st) && st !== o.status) { o.status = st; o.history = (o.history || []).concat({ s: st, t: now }); if (SOLD_ST.includes(st) && !o.paidAt) o.paidAt = now; }
}
// API del alistador: solo ve pedidos pagados / preparando (y los listos de las últimas 24 h), sin teléfonos ni montos
function prepView(o) {
  return { key: o.key, code: o.code, name: String(o.name || '').trim().split(/\s+/)[0] || '', mode: o.mode, eta: o.eta || '', status: o.status,
    created: o.created, paidAt: o.paidAt || 0, variable: o.variable || [], prepNote: o.prepNote || '',
    items: (o.items || []).map((i) => ({ title: i.title, variant: i.variant, qty: i.qty })), prep: o.prep || {} };
}
async function handlePrep(request, url, env, p) {
  if (p === '/panel/api/prep' && request.method === 'GET') {
    const keys = []; let cursor;
    do { const l = await env.ORDERS.list({ prefix: 'o:', cursor, limit: 1000 }); keys.push(...l.keys); cursor = l.list_complete ? null : l.cursor; } while (cursor && keys.length < 5000);
    const day = Date.now() - 864e5;
    const want = keys.filter((k) => !k.metadata || ['pagado', 'preparando'].includes(k.metadata.s) || (k.metadata.s === 'listo' && (k.metadata.pd || k.metadata.t) > day - 6 * 864e5));
    const full = (await Promise.all(want.slice(0, 120).map((k) => env.ORDERS.get(k.name, 'json')))).filter(Boolean);
    const out = full.filter((o) => ['pagado', 'preparando'].includes(o.status) || (o.status === 'listo' && o.prep && o.prep.doneAt > day)).map(prepView);
    return json({ ver: (await env.ORDERS.get('ver')) || '0', orders: out });
  }
  if (request.method !== 'POST' || !p.startsWith('/panel/api/prep/')) return json({ error: 'sin permiso' }, 403);
  const b = await request.json().catch(() => ({}));
  if (!String(b.key || '').startsWith('o:')) return json({ error: 'datos' }, 400);
  const o = await env.ORDERS.get(b.key, 'json');
  if (!o) return json({ error: 'no existe' }, 404);
  const now = Date.now(), by = clean(b.by || '', 40);
  if (!['pagado', 'preparando'].includes(o.status) && !p.endsWith('/issue')) return json({ error: 'Este pedido ya no está para alistar.' }, 409);
  o.prep = o.prep || { checks: [], weights: {}, issues: [] };
  o.prep.checks = o.prep.checks || []; o.prep.weights = o.prep.weights || {}; o.prep.issues = o.prep.issues || [];
  if (by) o.prep.by = by;
  const i = parseInt(b.i, 10);
  if (p === '/panel/api/prep/check') {
    if (!(i >= 0 && i < (o.items || []).length)) return json({ error: 'datos' }, 400);
    o.prep.checks[i] = !!b.on;
    if (!o.prep.start) o.prep.start = now;
    if (o.status === 'pagado') setStatusOn(o, 'preparando', now);
  } else if (p === '/panel/api/prep/weight') {
    if (!(i >= 0 && i < (o.items || []).length)) return json({ error: 'datos' }, 400);
    o.prep.weights[i] = clean(b.w, 20);
  } else if (p === '/panel/api/prep/done') {
    const n = (o.items || []).length;
    for (let j = 0; j < n; j++) if (!o.prep.checks[j]) return json({ error: 'Faltan productos por revisar.' }, 400);
    o.prep.doneAt = now; o.prep.doneBy = by || o.prep.by || '';
    setStatusOn(o, 'listo', now);
    const w = Object.keys(o.prep.weights).filter((j) => o.prep.weights[j]).map((j) => '⚖️ ' + o.items[j].title + ': ' + o.prep.weights[j] + ' g');
    await putOrder(env, b.key, o);
    await notifyOwner(env, '📦 Pedido ' + o.code + ' (' + o.name + ') ALISTADO por ' + (o.prep.doneBy || 'colaborador') + '. Revísalo en el panel y avísale al cliente.' + (w.length ? '\n' + w.join('\n') : ''));
    return json({ ok: true, order: prepView(o) });
  } else if (p === '/panel/api/prep/issue') {
    const text = clean(b.text, 300);
    if (text.length < 3) return json({ error: 'Escribe qué pasó.' }, 400);
    o.prep.issues.push({ t: now, by, text, item: i >= 0 ? (o.items[i] || {}).title : '' });
    await putOrder(env, b.key, o);
    await notifyOwner(env, '⚠️ Problema alistando ' + o.code + ' (' + o.name + ')' + (by ? ' — ' + by : '') + ':\n' + text);
    return json({ ok: true, order: prepView(o) });
  } else return json({ error: 'no encontrado' }, 404);
  await putOrder(env, b.key, o);
  return json({ ok: true, order: prepView(o) });
}
const html = (body, status = 200, headers = {}) => new Response(body, { status, headers: Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, headers) });

async function handlePanel(request, url, env) {
  const p = url.pathname.replace(/\/+$/, '');
  if (p === '/panel/login' && request.method === 'POST') {
    // Bloqueo contra intentos repetidos: 5 fallos por conexión → 15 min; 20 fallos en total → 1 hora para todos
    const ip = request.headers.get('cf-connecting-ip') || 'x';
    const kIp = 'lf:' + ip, kAll = 'lf:all';
    const nIp = +(await env.ORDERS.get(kIp) || 0), nAll = +(await env.ORDERS.get(kAll) || 0);
    if (nIp >= 5 || nAll >= 20) return html(loginPage('Demasiados intentos. Probá de nuevo más tarde.'), 429);
    const form = await request.formData();
    const pin = String(form.get('pin') || '');
    const role = env.PANEL_PIN && pin === String(env.PANEL_PIN) ? 'admin' : (env.PREP_PIN && pin === String(env.PREP_PIN) ? 'prep' : null);
    if (!role) {
      await env.ORDERS.put(kIp, String(nIp + 1), { expirationTtl: 900 });
      await env.ORDERS.put(kAll, String(nAll + 1), { expirationTtl: 3600 });
      return html(loginPage('PIN incorrecto'), 401);
    }
    await env.ORDERS.delete(kIp);
    const t = String(Date.now());
    const val = role === 'prep' ? t + '.prep' : t;
    return new Response(null, { status: 303, headers: { location: '/panel', 'set-cookie': `tp=${await sign(env, val, role)}.${val}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${60 * 60 * 24 * 60}` } });
  }
  if (p === '/panel/salir') return new Response(null, { status: 303, headers: { location: '/panel', 'set-cookie': 'tp=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' } });
  const role = await panelAuthed(request, env);
  if (!role) return p.startsWith('/panel/api') ? json({ error: 'login' }, 401) : html(loginPage(''));
  if (role === 'prep') {
    if (p === '/panel') return html(PREP_HTML.replace('__APPV__', APP_V));
    if (p === '/panel/api/ver') return json({ ver: (await env.ORDERS.get('ver')) || '0', app: APP_V });
    if (p.startsWith('/panel/api/prep')) return await handlePrep(request, url, env, p);
    return p.startsWith('/panel/api') ? json({ error: 'sin permiso' }, 403) : new Response(null, { status: 303, headers: { location: '/panel' } });
  }
  if (p === '/panel/probar-aviso') {
    const ok = await notifyOwner(env, '🔔 Prueba de aviso: así te van a llegar los pedidos nuevos de la tienda.');
    const n = env.TELEGRAM_TOKEN ? (await telegramChats(env)).length : 0;
    return html('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:17px system-ui;padding:24px;line-height:1.5"><h2>' + (ok ? '✅ Aviso enviado' : '⚠️ No se pudo enviar') + '</h2><p>Teléfonos registrados en Telegram: <b>' + n + '</b></p>' + (ok ? '' : '<p>Revisa que agregaste TELEGRAM_TOKEN en Cloudflare y que cada teléfono le escribió tu PIN al bot.</p>') + '<p><a href="/panel">← Volver al panel</a></p></body>');
  }
  if (p === '/panel/api/ver') return json({ ver: (await env.ORDERS.get('ver')) || '0', app: APP_V });
  if (p === '/panel/api/orders' && request.method === 'GET') {
    // Todos los pedidos en resumen (para ventas) + los más recientes completos (para la lista)
    const keys = []; let cursor;
    do { const l = await env.ORDERS.list({ prefix: 'o:', cursor, limit: 1000 }); keys.push(...l.keys); cursor = l.list_complete ? null : l.cursor; } while (cursor && keys.length < 20000);
    const nFull = Math.min(200, Math.max(1, parseInt(url.searchParams.get('full') || '80', 10)));
    const full = await Promise.all(keys.slice(0, nFull).map((k) => env.ORDERS.get(k.name, 'json')));
    const summaries = await Promise.all(keys.map(async (k) => {
      if (k.metadata && k.metadata.s) return Object.assign({ key: k.name }, k.metadata);
      const o = await env.ORDERS.get(k.name, 'json'); return o ? Object.assign({ key: k.name }, orderMeta(o)) : null;
    }));
    return json({ ver: (await env.ORDERS.get('ver')) || '0', orders: full.filter(Boolean), summaries: summaries.filter(Boolean),
      cfg: { sinpe: env.SINPE_NUMBER || '7095-5061', sinpeName: env.SINPE_NAME || 'Carlos Garita Rojas', lat: +(env.STORE_LAT || 9.9349), lng: +(env.STORE_LNG || -84.0789),
        pickup: env.PICKUP_TEXT || 'Tramo San Rafael #1, Mercado Central de San José', hours: env.STORE_HOURS || '7:30 a. m. a 5:30 p. m.' } });
  }
  if (p === '/panel/api/order' && request.method === 'GET') {
    const k = url.searchParams.get('key') || '';
    if (!k.startsWith('o:')) return json({ error: 'datos' }, 400);
    const o = await env.ORDERS.get(k, 'json');
    return o ? json({ order: o }) : json({ error: 'no existe' }, 404);
  }
  if ((p === '/panel/api/status' || p === '/panel/api/update') && request.method === 'POST') {
    const b = await request.json();
    const P = b.patch || b;
    if (!String(b.key || '').startsWith('o:')) return json({ error: 'datos' }, 400);
    const o = await env.ORDERS.get(b.key, 'json');
    if (!o) return json({ error: 'no existe' }, 404);
    const now = Date.now();
    const setStatus = (st) => setStatusOn(o, st, now);
    if (P.status === 'cancelado' && o.status !== 'cancelado' && clean(P.cancelReason || '', 300).length < 3) return json({ error: 'Para cancelar hay que escribir el motivo.' }, 400);
    if (P.status != null) { if (!STATUSES.includes(P.status)) return json({ error: 'estado' }, 400); setStatus(P.status); }
    if (P.status === 'cancelado') { o.cancelReason = clean(P.cancelReason || '', 300); if (o.history && o.history.length) o.history[o.history.length - 1].note = o.cancelReason; }
    if (P.mode != null && MODE_LABEL[P.mode] && P.mode !== o.mode) { o.history = (o.history || []).concat({ s: 'cambio-entrega', t: now, from: o.mode, to: P.mode, note: clean(P.changeNote || '', 200) }); o.mode = P.mode; }
    if (P.location != null) o.location = clean(P.location, 300);
    if (P.address != null) o.address = clean(P.address, 300);
    if (P.area != null) o.area = clean(P.area, 120);
    if (P.note != null) o.note = clean(P.note, 1000);
    if (P.prepNote != null) o.prepNote = clean(P.prepNote, 300);
    const num = (v) => { const n = Math.round(+String(v).replace(/[^\d.]/g, '')); return isFinite(n) && n >= 0 ? n : null; };
    if (P.finalTotal != null) { const n = num(P.finalTotal); o.finalTotal = n || undefined; }
    if (P.shipping != null) { const n = num(P.shipping); o.shipping = n || 0; }
    if (P.sinpeRef != null) {
      o.sinpeRef = clean(P.sinpeRef, 40);
      if (o.sinpeRef && ['incompleto', 'pago-pendiente'].includes(o.status)) setStatus('pagado');
      if (o.sinpeRef && !o.paidAt) o.paidAt = now;
    }
    if (Array.isArray(P.invoices)) {
      o.invoices = P.invoices.slice(0, 10).map((i) => ({ type: INV_TYPES.includes(i.type) ? i.type : 'TE', num: clean(i.num, 60), voided: !!i.voided, note: clean(i.note || '', 120), t: +i.t || now, vt: i.voided ? (+i.vt || now) : undefined })).filter((i) => i.num);
    }
    await putOrder(env, b.key, o);
    return json({ ok: true, order: o });
  }
  if (p === '/panel') return html(PANEL_HTML.replace('__APPV__', APP_V));
  return json({ error: 'no encontrado' }, 404);
}

function loginPage(err) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pedidos · Tramo</title><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Pedidos"><meta name="apple-mobile-web-app-status-bar-style" content="default">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f1e6;font-family:system-ui,-apple-system,sans-serif;color:#1d2a1c}
form{background:#fff;padding:28px 24px;border-radius:20px;box-shadow:0 10px 30px rgba(38,61,37,.12);width:min(340px,90vw);text-align:center}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 18px;color:#6b7468;font-size:14px}
input{width:100%;box-sizing:border-box;font-size:22px;letter-spacing:6px;text-align:center;padding:12px;border:1.5px solid #263d25;border-radius:12px;margin-bottom:12px}
button{width:100%;padding:13px;border:0;border-radius:12px;background:#263d25;color:#fff;font-size:16px;font-weight:600}.e{color:#b3261e;margin-top:10px;font-size:14px}</style></head>
<body><form method="post" action="/panel/login"><h1>Pedidos · Tramo San Rafael</h1><p>Escribe tu PIN</p><input name="pin" type="password" inputmode="numeric" autocomplete="current-password" autofocus><button>Entrar</button>${err ? `<div class="e">${err}</div>` : ''}</form></body></html>`;
}


// Cada 5 minutos (Cron Trigger en Cloudflare): avisa de pedidos que se quedaron "sin terminar" más de 10 minutos
async function checkDrafts(env) {
  if (!env.ORDERS) return;
  const list = await env.ORDERS.list({ prefix: 'o:', limit: 40 });
  for (const k of list.keys) {
    if (k.metadata && k.metadata.s !== 'incompleto') continue;
    const o = await env.ORDERS.get(k.name, 'json');
    if (!o || o.status !== 'incompleto' || o.notifiedDraft) continue;
    if (Date.now() - o.created < 10 * 60 * 1000) continue;
    const ok = await notifyOwner(env, '⚠️ Pedido SIN TERMINAR ' + (o.code || '') + ' · ' + o.name + ' · ' + o.phone + '\nLlegó hasta el pago pero no lo confirmó. Escríbele para ayudarle.\n\n' + (o.message || ''));
    o.notifiedDraft = true; if (!ok) o.notifyFailed = true;
    await putOrder(env, k.name, o);
  }
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(checkDrafts(env)); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/panel' || url.pathname.startsWith('/panel/')) return await handlePanel(request, url, env);
      // Pedidos enviados directo desde la tienda (sin App Proxy): solo desde los dominios de la tienda
      if (url.pathname === '/order') {
        const origin = request.headers.get('origin') || '';
        const okOrigin = STORE_ORIGINS.includes(origin) || origin === 'https://' + env.SHOPIFY_SHOP + '.myshopify.com';
        const cors = { 'access-control-allow-origin': okOrigin ? origin : 'null', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'origin' };
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        if (!okOrigin || request.method !== 'POST') return json({ error: 'no permitido' }, 403);
        const ip = request.headers.get('cf-connecting-ip') || 'x', kr = 'rl:' + ip;
        const n = env.ORDERS ? +(await env.ORDERS.get(kr) || 0) : 0;
        if (n >= 40) return json({ error: 'demasiados pedidos' }, 429);
        if (env.ORDERS) await env.ORDERS.put(kr, String(n + 1), { expirationTtl: 3600 });
        const r = await handleNewOrder(request, env, ctx);
        const h = new Headers(r.headers); Object.keys(cors).forEach((k) => h.set(k, cors[k]));
        return new Response(r.body, { status: r.status, headers: h });
      }
      if (!(await verifyProxy(url, env.SHOPIFY_CLIENT_SECRET))) return json({ error: 'firma inválida' }, 401);
      if (url.pathname.endsWith('/orders') && request.method === 'GET') return await handleOrders(url, env);
      if (url.pathname.endsWith('/ai') && request.method === 'POST') return await handleAI(request, url, env);
      if (url.pathname.endsWith('/cashback') && request.method === 'GET') return await handleCashback(url, env);
      if (url.pathname.endsWith('/cashback/redeem') && request.method === 'POST') return await handleRedeem(request, url, env);
      if (url.pathname.endsWith('/order') && request.method === 'POST') return await handleNewOrder(request, env, ctx);
      return json({ ok: true, service: 'tramo' });
    } catch (e) {
      return json({ error: 'error interno' }, 500);
    }
  }
};
