# PRD – Tacos POS

## Problem Statement (original)
Sistema POS mobile-first para taquería con:
1. **POS**: Lista vertical de productos táctil, controles +/- y campo numérico, carrito sticky con subtotal, selector de pago (Efectivo / Transferencia / Tarjeta), opción de propina cuando paga con tarjeta o transferencia, botón "Cobrar Orden".
2. **Admin**: Login simple, dashboard con totales del día, desglose por método de pago, propina separada, gráficas (productos top, ventas por hora, distribución de pagos), tabla de ventas, editor de precios.
3. Mobile-first, sin imágenes ni iconos externos, datos en MongoDB, refresco automático cada 5s, sin IVA.

## Stack
- **Backend**: FastAPI + MongoDB (motor)
- **Frontend**: React 19 + Tailwind + Recharts + Sonner
- **Auth admin**: comparación simple usuario/contraseña vs `ADMIN_USERNAME/ADMIN_PASSWORD` en `.env`

## Personas
- **Cajero/Vendedor**: usa el POS desde un teléfono. Necesita rapidez, botones grandes, mínimos pasos.
- **Dueño/Admin**: revisa ventas del día y edita precios desde el panel admin.

## Implementado (Feb 2026)
- Backend `/api/products` (GET/POST/PUT/DELETE), `/api/sales` (POST/GET today), `/api/dashboard`, `/api/admin/login`
- Seed automático de 11 productos por defecto
- POS mobile-first con carrito sticky, propina condicional, métodos de pago
- Admin con tabs: Dashboard, Ventas, Precios
- Gráficas: barras (productos), línea (ventas/hora), pastel (distribución de pagos)
- Polling cada 5 s
- Sin IVA aplicado; propina separada en dashboard

## Iteración 2 (Feb 2026)
- **Login obligatorio** con sesión por rol (RootRedirect): admin → /admin, cashier → /pos
- **6 usuarios sembrados**: 1 admin + 5 cajeros (uno por sucursal)
- **5 sucursales**: Valle Dorado, Mezcalitos, San Vicente, 3.14, San José
- Ventas guardan `sucursal` y `cashier` para trazabilidad
- POS **compacto**: panel inferior reducido, nombres completos sin truncar, etiqueta y color azul para `BEBIDA` vs verde para `COMIDA`
- Admin: selector de fecha (calendario shadcn), filtro por sucursal, propinas detalladas por método (tarjeta vs transferencia), gráfica de ventas por sucursal, tab `Usuarios` para editar contraseñas y sucursal asignada

## Iteración 3 (Feb 2026)
- **Propina por porcentaje** (5/10/15/20%) además del monto manual cuando paga con tarjeta/transferencia
- **Tipo de orden obligatorio**: Mesa, Llevar o Domicilio. Mesa requiere número de mesa
- **Efectivo**: input "dinero recibido" y muestra cambio automáticamente
- **Pull-to-refresh bloqueado** en móvil (`overscroll-behavior-y: contain`)
- **Multicaja**: cada perfil tiene `caja_name`, admin puede CREAR, EDITAR (todo) y ELIMINAR usuarios. El único admin no puede eliminarse.
- **Estadísticas mejoradas**: KPIs ticket promedio, items por venta, hora pico, total de items. Sección "Por tipo de orden". Filtro y gráfica por caja dentro de cada sucursal.
- **Badge "Made with Emergent" eliminado** (vía JS + MutationObserver)

## Iteración 5 (Feb 2026) — Production hardening
- **Bug crítico de suma corregido**: inc/dec en POS usaban `cart[pid]` desde closure (stale state). Cuando se tocaban + o - rápido, varios clicks leían el mismo valor y se perdían increments (ej. 5 toques sumaban 4). Arreglado con functional setState `setCart(c => ...)`. Verificado en tests: 5 clicks consecutivos = $150 correcto.
- **Productos por peso / precio variable** (`pricing_mode: 'fixed' | 'variable'`): el cobrador ingresa el monto al cobrar. Birria sembrada por defecto. Admin puede crear/editar el modo desde la pestaña Precios.
- **Pago dividido** (efectivo + tarjeta / efectivo + transferencia): toggle naranja en el panel del carrito. Auto-balance del monto digital. Propina aplica sólo a la parte digital. Backend guarda `payments[]` array y el dashboard/CSV desglosan correctamente cada método.
- **Botones B1/B2/B3** (barras) en el campo mesa, **sólo para Valle Dorado**. Input mesa ahora acepta texto, no sólo números.
- **Cobradores rotativos**: ya estaba implementado en datos — cada venta guarda su propia `sucursal` y `cashier` al momento de la venta. Mover a un cobrador de sucursal NO cambia su histórico.
- **Default caja_name = username**: al crear un usuario sin caja_name, se asigna automáticamente el username (ya no aparece "Caja 1" por defecto).

## Iteración 6 (Feb 2026) — Factura, Envío, Split Tarjeta+Transf., Rango Personalizado
- **Toggle "Factura (+16% IVA)"**: aparece sólo cuando el pago involucra Tarjeta (single o split). Se suma `subtotal × 0.16` al total y se guarda `invoice_requested` + `iva` en la venta.
- **Input "Envío"**: visible sólo cuando el tipo de orden es Domicilio. Se suma directo al total y se guarda en `delivery_fee`.
- **3ª opción de pago dividido — Tarjeta + Transferencia**: ahora hay 3 splits posibles (efectivo+tarjeta, efectivo+transferencia, tarjeta+transferencia). Backend valida que `sum(payment.amount) == total` (incluye tip+iva+envío).
- **Custom Date Range en Admin → Período**: botón "Personalizado" en el toggle. Aparecen 2 date pickers (Desde/Hasta) y pasa `period=custom&start_date&end_date` al endpoint. CSV también soporta rango personalizado.

## Iteración 7 (Feb 2026) — Sync sucursal en vivo · Audit histórico · Cola offline robusta

**Bugs fix:**
- **Suma incorrecta en dispositivo específico**: identificado como bundle JS cacheado en el celular. Fixes:
  - `no-cache` meta tags en `index.html`
  - Botón visible **"Actualizar app"** (`btn-refresh-app`) en el header del POS: limpia `localStorage` (preservando cola de ventas y sesión), borra `Cache Storage` y recarga con `?_v=<ts>` para bust HTTP cache.
  - Poda automática del carrito cuando el catálogo de productos cambia (evita IDs huérfanos que generarían "totales fantasma").
- **Cajero ve sucursal vieja tras cambio del admin**: nuevo endpoint `GET /api/auth/me?username=X`. El POS lo llama al montar, cada 60s y al volver a visible. Si detecta cambio en `sucursal`/`caja_name`, muestra toast **"Tu sucursal cambió a: X"**, actualiza sesión y recarga.
- **Admin ve cajeros de HOY al revisar AYER**: `/api/audit/sales_count` ahora agrega por `caja + cashier + sucursal`. El dropdown de Caja en Admin usa la **unión** de: (a) cajas con ventas históricas ese día en esa sucursal, (b) cajeros actualmente asignados. La tabla de auditoría ahora muestra la columna **Sucursal** (histórica, tomada de la venta al momento en que ocurrió).

**Cola offline v2** (`salesQueue.js` reescrito):
- Backoff exponencial **por venta**: 5s → 10s → 20s → 40s → 60s → 2min → cap 5min. Cada item guarda `next_try_at`, `attempts` y `last_error`.
- Concurrency guard: solo un `flushQueue()` corre a la vez (evita saturar la red).
- Auto-flush en múltiples eventos: intervalo 10s, `online`, `visibilitychange` (tab activa).
- Errores `4xx` (excepto 429) marcan la venta como `hard_error` (no reintentos infinitos, la conserva visible para inspección).
- Fallo de `localStorage` (cuota): copia de emergencia a `window._emergencySales` para no perder datos.
- **Nuevo modal "Ventas guardadas"** (`pending-modal`): tocando el badge amarillo, el cajero ve la lista de ventas encoladas con monto, hora, intentos, último error. Botón "Reintentar ahora".

**Testing (iter 6):** 6/6 backend pytest + 100% flows frontend verificados.

## Backlog / Próximas mejoras
- P1: Cierre de caja y arqueo (día/turno)
- P1: Auth token en `/api/auth/me` (hoy es público — ver comentario del testing agent)
- P2: Validar `cashier.sucursal == body.sucursal` en `POST /sales`
- P2: Hash de contraseñas (siguen en texto plano)
- P2: Cancelación / devolución de ventas
- P2: Notas por venta y ticket imprimible
- P3: Refactor de `POS.jsx` y `AdminDashboard.jsx` en componentes más chicos
- P3: Migrar `@app.on_event` a `lifespan` handlers (deprecated en FastAPI)
