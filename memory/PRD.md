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

## Backlog / Próximas mejoras
- P1: Reportes históricos (semana / mes), exportar CSV de ventas
- P1: Cierre de caja y arqueo
- P2: Múltiples cajeros con sesión por usuario, historial por persona
- P2: Cancelación / devolución de ventas
- P2: Notas por venta, comentarios al cocinero, ticket imprimible
