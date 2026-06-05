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

## Backlog / Próximas mejoras
- P1: Reportes históricos (semana / mes), exportar CSV de ventas
- P1: Cierre de caja y arqueo
- P2: Múltiples cajeros con sesión por usuario, historial por persona
- P2: Cancelación / devolución de ventas
- P2: Notas por venta, comentarios al cocinero, ticket imprimible
