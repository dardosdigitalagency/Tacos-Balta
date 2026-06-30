# Tacos POS — Despliegue Postgres / Supabase (LISTO)

> Estado: **Backend Postgres conectado y validado contra tu Supabase Cloud**.
> Schema aplicado, idempotencia funcionando, pooler conectado.

## Tu configuración real

- **Project ref**: `dpepjqbcaxdaqdekifyq`
- **Pooler host**: `aws-1-us-east-2.pooler.supabase.com`
- **Port**: `6543` (Transaction pooler) ✅ probado y funcionando
- **DATABASE_URL** (ya con password URL-encoded):

```
postgresql://postgres.dpepjqbcaxdaqdekifyq:q46M%2BZpC%2C%3Fn%23%2FLB@aws-1-us-east-2.pooler.supabase.com:6543/postgres
```

## Paso 1 — Migrar tus datos REALES de Mongo Atlas a Supabase

Yo no tengo acceso a tu Atlas desde el preview (IP restriction). **Tú debes correr esto desde tu compu / VPS Hostinger** (donde sí puede llegar a Atlas):

```bash
cd /ruta/al/proyecto
export MONGO_URL='mongodb+srv://mobile-checkout-pos:d8kubp36p6ps73b3pa7g@customer-apps.lzstca.mongodb.net/?appName=mobile-checkout-pos&maxPoolSize=5&retryWrites=true&timeoutMS=10000&w=majority'
export DB_NAME='test_database'   # cambia si tu DB de Atlas tiene otro nombre
export DATABASE_URL='postgresql://postgres.dpepjqbcaxdaqdekifyq:q46M%2BZpC%2C%3Fn%23%2FLB@aws-1-us-east-2.pooler.supabase.com:6543/postgres'

pip install motor asyncpg
python scripts/migrate_mongo_to_pg.py
```

**Es idempotente** — puedes correrlo varias veces sin duplicar.

Salida esperada (números varían según tu data):
```
✓ sucursales: 5/5
✓ products: 12/12
✓ users: 8/8
✓ sales: NNN/NNN
✅ Migración completa.
```

⚠️ **No sé el nombre exacto de tu base de datos en Atlas**. Si la primera corrida marca `0/0` en todas las tablas, prueba con otros valores de `DB_NAME` (`tacos_pos`, `mobile-checkout-pos`, `prod`, etc.). En Atlas Studio puedes verlo.

## Paso 2 — Cambiar el backend a Postgres

En `backend/.env` reemplaza:
```diff
- MONGO_URL=...
- DB_NAME=...
+ DATABASE_URL=postgresql://postgres.dpepjqbcaxdaqdekifyq:q46M%2BZpC%2C%3Fn%23%2FLB@aws-1-us-east-2.pooler.supabase.com:6543/postgres
```

En el entry point del servidor (supervisor / docker / Procfile), cambia:
```diff
- uvicorn server:app --host 0.0.0.0 --port 8001
+ uvicorn server_pg:app --host 0.0.0.0 --port 8001
```

Reinicia el backend. Listo.

## Verificación

```bash
curl https://tu-dominio.com/api/health
# → {"ok": true, "last_sale_at": "..."}

curl https://tu-dominio.com/api/products
# → [12 productos]
```

## Rollback (volver a Mongo)

`server.py` original quedó intacto. Para rollback:
1. Revertir `.env` a `MONGO_URL` / `DB_NAME`
2. Cambiar entry point a `server:app`
3. Reiniciar

Los datos en Atlas no se tocaron durante la migración (solo se leyeron).

## Recordatorios

- 🔐 **Rota el password** de Supabase después de tener todo funcionando (te lo enviaste por chat).
- 📦 `backend/requirements.txt` ya incluye `asyncpg` y `SQLAlchemy`.
- 🗑️ Cuando tengas 2+ días en Postgres sin problemas, puedes borrar `server.py` y eliminar `motor` de requirements.

## Lo que ya está probado (preview)

✅ Conexión a Supabase Cloud
✅ Schema aplicado (4 tablas + 5 índices)
✅ Migración: 5 sucursales, 12 productos, 8 users, 16 ventas desde Mongo del preview
✅ `/api/health` con `last_sale_at`
✅ `/api/products` lista los 12
✅ `/api/auth/login` con admin
✅ `/api/dashboard` con totales correctos ($139.60, IVA $9.60)
✅ Idempotencia (`client_id` UNIQUE)
✅ Compatibilidad con pgbouncer (Transaction pooler)
