// Servidor de Tramo (Cloudflare Worker).
// Atiende dos rutas que Shopify reenvía desde la tienda (App Proxy):
//   GET  /apps/tramo/orders  -> pedidos del cliente que inició sesión (con etiquetas de estado)
//   POST /apps/tramo/ai      -> respuestas de IA sobre un producto (Claude)
// Variables (secretas) que necesita: SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_SHOP, ANTHROPIC_API_KEY
// Opcionales: CLAUDE_MODEL, STORE_INFO, WHATSAPP_TEXT

const enc = new TextEncoder();

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Verifica que la petición venga realmente de Shopify (firma del App Proxy).
export async function verifyProxy(url, secret) {
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

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: env.CLAUDE_MODEL || 'claude-haiku-5-5', max_tokens: 350, system, messages: [{ role: 'user', content: question }] })
  });
  if (!res.ok) return json({ answer: 'No pude responder ahora. Escríbenos por WhatsApp y te ayudamos.' }, 502);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return json({ answer: text || 'No pude encontrar una respuesta. Escríbenos por WhatsApp.' });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (!(await verifyProxy(url, env.SHOPIFY_CLIENT_SECRET))) return json({ error: 'firma inválida' }, 401);
      if (url.pathname.endsWith('/orders') && request.method === 'GET') return await handleOrders(url, env);
      if (url.pathname.endsWith('/ai') && request.method === 'POST') return await handleAI(request, url, env);
      return json({ ok: true, service: 'tramo' });
    } catch (e) {
      return json({ error: 'error interno' }, 500);
    }
  }
};
