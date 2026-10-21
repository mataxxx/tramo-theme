# Servidor de Tramo (pedidos con estado + IA)

Un solo servicio pequeño (Cloudflare Worker, gratis para este uso) que Shopify conecta a tu tienda con un **App Proxy**:

- `tu-tienda/apps/tramo/orders` → pedidos del cliente que inició sesión (monto, productos, etiquetas de estado).
- `tu-tienda/apps/tramo/ai` → respuestas de IA sobre el producto (usa Claude).

Shopify firma cada petición; el servicio rechaza cualquier cosa que no venga de tu tienda, y solo devuelve los pedidos del cliente con sesión iniciada.

## Pasos para encenderlo (una sola vez)

1. **App en Shopify** (Dev Dashboard → Apps → Crear app, "Tramo Backend"):
   - Permisos (scopes): `read_orders`, `read_customers`, `read_products`.
   - App proxy: prefijo `apps`, subruta `tramo`, URL = la del Worker (paso 2).
   - Publicar la versión e instalarla en la tienda. Copiar Client ID y Client secret.
   - Nota: el método de claves automáticas solo funciona si la tienda está en la misma organización del Dev Dashboard.
2. **Worker** (cuenta gratis de Cloudflare):
   ```
   cd backend
   npx wrangler deploy
   npx wrangler secret put SHOPIFY_CLIENT_ID
   npx wrangler secret put SHOPIFY_CLIENT_SECRET
   npx wrangler secret put ANTHROPIC_API_KEY
   ```
3. Listo: el tema ya apunta a `/apps/tramo/orders` y `/apps/tramo/ai`.

Para pedidos con más de 60 días de antigüedad hay que pedir a Shopify el permiso `read_all_orders`.

## Estado del pedido (tipo Uber)

En Shopify, abre el pedido y agrega la etiqueta de la etapa (`estado-preparando`, `estado-en-camino`, `estado-entregado`). Las etapas y etiquetas se editan en el personalizador (Cuenta de usuario).

## Prueba local de la verificación de firma

`node backend/test-signature.mjs`
