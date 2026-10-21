import worker from './worker.js';
import crypto from 'node:crypto';
// Prueba: el servicio solo acepta peticiones firmadas por Shopify (método de la documentación).
const secret = 'hush';
const env = { SHOPIFY_CLIENT_SECRET: secret };
const ts = Math.floor(Date.now() / 1000);
const msg = `logged_in_customer_id=path_prefix=/apps/tramoshop=tienda.myshopify.comtimestamp=${ts}`;
const sig = crypto.createHmac('sha256', secret).update(msg).digest('hex');
const url = `https://x.com/ping?shop=tienda.myshopify.com&logged_in_customer_id=&path_prefix=%2Fapps%2Ftramo&timestamp=${ts}&signature=${sig}`;
const ok = await worker.fetch(new Request(url), env);
console.log('firma válida -> 200:', ok.status === 200);
const bad = await worker.fetch(new Request(url.replace('tienda', 'otra')), env);
console.log('firma alterada -> 401:', bad.status === 401);
const none = await worker.fetch(new Request('https://x.com/ping'), env);
console.log('sin firma -> 401:', none.status === 401);
