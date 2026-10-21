# Tramo — tema de Shopify (Online Store 2.0)

Tema para Tramo San Rafael #1. Todo es editable desde **Personalizar** en Shopify.

## Instalar (como borrador, sin publicar)
1. Admin de Shopify → Tienda online → Temas → Añadir tema → Subir archivo zip.
2. Elige este zip. Queda como borrador; tus clientes no lo ven.
3. Pulsa **Personalizar**.

## Configurar
- **Colecciones de la portada:** en la página de inicio, cada bloque "Productos por categoría" tiene un selector de colección.
  La portada viene conectada a tus colecciones actuales: Especias (`frontpage`), Semillas & Granos (`test2`),
  Frutas & otros deshidratados y Insumos para Repostería. Se cambian desde el personalizador.
- **Videos tipo reel:** Personalizar → Pie de página/paneles → sección "Videos" → agregar bloques "Video".
- **Menú de categorías en la búsqueda:** sección "Búsqueda" → elige un menú cuyos enlaces sean colecciones.
- **Colores, fuentes, redes y granel:** Configuración del tema.

## Venta a granel
Crea en el producto una opción (ej. "Presentación") con el valor **A granel** (el nombre se cambia en Configuración del tema → Venta a granel).
El precio de esa variante es el de **10 g** (por defecto). La cantidad del carrito son esas unidades; el tema muestra gramos.
Ejemplo: si el kilo cuesta ₡28.000, la variante "A granel" cuesta ₡280. El mínimo (250 g) lo controla el tema, no el checkout.

## Cuenta de usuario y estado de pedidos

- Botón de iniciar sesión en el encabezado; con sesión iniciada abre una ficha con nombre, información y direcciones, compras pasadas y cerrar sesión.
- Cada pedido se muestra como tarjeta tipo seguimiento (monto, fecha, productos y etapa).
- **Para cambiar el estado:** en Shopify abre el pedido y agrega la etiqueta de la etapa (por defecto `estado-preparando`, `estado-en-camino`, `estado-entregado`). Las etapas y sus etiquetas se editan en el personalizador: Cuenta de usuario > bloques.
- Limitación: depende de que Shopify entregue los pedidos al tema (`customer.orders`). Con las cuentas nuevas de Shopify (páginas alojadas por Shopify) puede que solo aparezcan los enlaces; el seguimiento completo ahí requeriría una extensión (fase 2).

## Otras opciones del personalizador

- Textos: fuente, tamaño (computadora/móvil) y color en cada sección.
- Barra de anuncios con desplazamiento lateral y velocidad.
- Menú: barra lateral fija en computadora, panel en móvil; imagen de diseño; ocultar Inicio/Catálogo/Contacto.
- Videos: botón "Ver todos los videos" abre una cuadrícula estilo TikTok.
- Popup "producto agregado" (ver carrito / seguir comprando).
- Logo con tamaño en encabezado y pie de página.

## Notas
- Textos del tema en español fijo (sin traducciones).
- No incluye filtros de colección ni páginas de cuenta de cliente propias.
