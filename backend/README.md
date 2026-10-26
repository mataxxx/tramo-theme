# Servidor de Tramo (pedidos con estado + IA)

Un servicio pequeño en Cloudflare (gratis) que Shopify conecta a tu tienda con un App Proxy:

- `tu-tienda/apps/tramo/orders` → pedidos del cliente que inició sesión, con su estado.
- `tu-tienda/apps/tramo/ai` → respuestas de IA sobre el producto.
- `tu-tienda/apps/tramo/cashback` → saldo de cash back y códigos del cliente; `/cashback/redeem` genera un código.

Shopify firma cada petición. El servicio rechaza todo lo que no venga de tu tienda, y solo devuelve los pedidos del cliente con sesión iniciada.

No necesitas terminal: todo se hace desde las páginas web.

## Paso 1. Cloudflare (la IA y el servicio)

1. Crea una cuenta gratis en https://dash.cloudflare.com
2. Menú **Workers & Pages** → **Create** → **Create Worker** → nombre `tramo-backend` → **Deploy**.
3. Botón **Edit code**. Borra todo, pega el contenido de `backend/worker.js` (en GitHub: mataxxx/tramo-theme → backend → worker.js) → **Deploy**.
4. Anota la dirección del Worker (algo como `https://tramo-backend.TU-USUARIO.workers.dev`).
5. **Settings → Bindings → Add → Workers AI**, nombre de variable exacto: `AI`. (Esto activa la IA gratis; no hay que pagar ni crear claves.)
6. **Settings → Variables and Secrets** → agrega:
   - `SHOPIFY_SHOP` (texto) = `tramo-san-rafael-1`
   - `STORE_INFO` (texto, opcional) = datos de tu tienda que la IA puede usar (envíos, horarios…)
   - `SHOPIFY_CLIENT_ID` (secreto) y `SHOPIFY_CLIENT_SECRET` (secreto) → se llenan en el paso 2.

## Paso 2. App en Shopify

1. Entra a https://dev.shopify.com → **Apps** → **Create app** → nombre `Tramo Backend`.
2. En la versión de la app, **Access scopes**: `read_orders`, `read_customers`, `write_customers`, `read_products`, `read_gift_cards`, `write_gift_cards`.
   (Si la app ya estaba instalada, agrega los nuevos permisos, publica una versión nueva y acepta la actualización en la tienda.)
3. **App proxy**: prefijo `apps`, subruta `tramo`, URL = la dirección del Worker del paso 1.
4. **Release** (publicar la versión) y luego **Install** en tu tienda.
5. En **Settings** copia el **Client ID** y el **Client secret**, y pégalos en los secretos del paso 1.6.

Nota: el Client ID/secret solo sirven para obtener acceso si la tienda está en la misma organización del Dev Dashboard. Si Shopify responde `shop_not_permitted`, avísame y cambiamos el método.

## Paso 3. Probar

1. En tu tienda inicia sesión con un cliente que tenga pedidos y abre el menú: deben aparecer.
2. En un producto con el bloque de preguntas, escribe una pregunta: debe responder la IA.

## Estado del pedido (tipo Uber)

En Shopify abre el pedido y agrega la etiqueta de la etapa: `estado-preparando`, `estado-en-camino`, `estado-entregado`. Las etapas y etiquetas se editan en el personalizador (Cuenta de usuario).

## Sobre la IA

- Por defecto usa **Workers AI** de Cloudflare (modelo Llama): sin clave y con una cuota diaria gratis. Para cambiar de modelo, crea la variable `AI_MODEL`.
- Opcional: si prefieres Claude, quita el binding `AI` y agrega el secreto `ANTHROPIC_API_KEY`.

## Prueba de la verificación de firma (opcional)

`node backend/test-signature.mjs`

## Cash back

- Cada pedido pagado suma `CASHBACK_PCT` % (5 por defecto) de los productos, sin envío y sin IVA (`CASHBACK_TAX`, 0.13).
- El cliente convierte su saldo en un código desde **Mi cuenta → Mi cash back**. El código es una tarjeta de regalo de Shopify a su nombre (nota "Cash back Tramo"); se pega en el checkout y se puede usar en partes.
- Mínimo para generar un código: `CASHBACK_MIN` (1000).
- No vence. Los códigos se ven en el admin en **Productos → Tarjetas de regalo**.
- Variables opcionales en Cloudflare: `CASHBACK_PCT`, `CASHBACK_TAX`, `CASHBACK_MIN`. Si cambias el % aquí, cámbialo también en el personalizador (Configuración del tema → Cash back).


## Panel de pedidos (propio, fuera de Shopify)

Cuando el cliente toca "Enviar pedido", la página guarda una copia en tu panel, aunque el cliente no mande el WhatsApp. Shopify no crea pedidos ni cobra comisión: solo hospeda la tienda.

**Panel:** `https://tramo-backend.TU-USUARIO.workers.dev/panel` (entras con tu PIN). Guárdalo en la pantalla de inicio del celular.
Estados: Pago pendiente → Pagado → Preparando → Listo → Entregado / enviado (o Cancelado). Botones para escribirle al cliente por WhatsApp: pedir el pago, avisar que está listo / en camino / enviado.

Configuración en Cloudflare (una sola vez):
1. **Storage & Databases → KV → Create** → nombre `tramo-pedidos`.
2. En el Worker → **Settings → Bindings → Add → KV namespace**: nombre de variable exacto `ORDERS`, namespace `tramo-pedidos`.
3. **Settings → Variables and Secrets**: secreto `PANEL_PIN` = el PIN que quieras (ej. 6 números).
4. **Edit code** → pega el `worker.js` nuevo → **Deploy**.

Aviso a tu WhatsApp (opcional): activa CallMeBot desde el 7017-0518 (https://www.callmebot.com/blog/free-api-whatsapp-messages/, te responde con tu apikey) y agrega `OWNER_PHONE` = `50670170518` y el secreto `CALLMEBOT_KEY`.
