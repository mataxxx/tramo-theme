import { verifyProxy } from './worker.js';
import crypto from 'node:crypto';
// La firma se calcula con el método de la documentación de Shopify (parámetros ordenados y pegados, HMAC-SHA256).
const secret = 'hush';
const ts = Math.floor(Date.now() / 1000);
const msg = `extra=1,2logged_in_customer_id=1path_prefix=/apps/tramoshop=tienda.myshopify.comtimestamp=${ts}`;
const sig = crypto.createHmac('sha256', secret).update(msg).digest('hex');
const ok = new URL(`https://x.com/orders?extra=1&extra=2&shop=tienda.myshopify.com&logged_in_customer_id=1&path_prefix=%2Fapps%2Ftramo&timestamp=${ts}&signature=${sig}`);
console.log('firma válida aceptada:', await verifyProxy(ok, secret));
console.log('cliente alterado rechazado:', !(await verifyProxy(new URL(ok.href.replace('customer_id=1', 'customer_id=2')), secret)));
console.log('secreto incorrecto rechazado:', !(await verifyProxy(ok, 'otro')));
