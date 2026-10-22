// Servidor de Tramo (Cloudflare Worker).
// Atiende dos rutas que Shopify reenvía desde la tienda (App Proxy):
//   GET  /apps/tramo/orders  -> pedidos del cliente que inició sesión (con etiquetas de estado)
//   POST /apps/tramo/ai      -> respuestas de IA sobre un producto (Claude)
//   GET  /apps/tramo/cashback         -> saldo de cash back y códigos del cliente
//   POST /apps/tramo/cashback/redeem  -> convierte saldo en un código (tarjeta de regalo) para el checkout
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (!(await verifyProxy(url, env.SHOPIFY_CLIENT_SECRET))) return json({ error: 'firma inválida' }, 401);
      if (url.pathname.endsWith('/orders') && request.method === 'GET') return await handleOrders(url, env);
      if (url.pathname.endsWith('/ai') && request.method === 'POST') return await handleAI(request, url, env);
      if (url.pathname.endsWith('/cashback') && request.method === 'GET') return await handleCashback(url, env);
      if (url.pathname.endsWith('/cashback/redeem') && request.method === 'POST') return await handleRedeem(request, url, env);
      return json({ ok: true, service: 'tramo' });
    } catch (e) {
      return json({ error: 'error interno' }, 500);
    }
  }
};
