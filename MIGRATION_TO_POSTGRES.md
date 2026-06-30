# Migración Mongo → Postgres (Supabase)

Este documento explica cómo cambiar el backend de Tacos POS de MongoDB
a PostgreSQL (Supabase self-hosted en Hostinger).

---

## 1. Archivos involucrados

| Archivo | Qué hace |
|---|---|
| `backend/schema.sql` | Schema PostgreSQL (tablas, índices). Se aplica solo al arrancar. |
| `backend/server_pg.py` | **NUEVO backend** sobre Postgres. Mismos endpoints que `server.py`. |
| `backend/server.py` | Backend original sobre MongoDB. Lo dejamos hasta confirmar el switch. |
| `scripts/migrate_mongo_to_pg.py` | Script de migración Mongo → Postgres (idempotente). |
| `backend/requirements.txt` | Ya incluye `asyncpg` y `SQLAlchemy`. |

---

## 2. Pasos para hacer el cambio (en orden)

### A. Conseguir el POOLER_TENANT_ID de Hostinger
**Pendiente** — pedirle a soporte de Hostinger o buscar en variables del VPS.
La URI final será:
```
postgresql://postgres.<TENANT_ID>:<PASSWORD>@srv1793433.hstgr.cloud:5432/postgres
```

### B. Migrar los datos (corre 1 sola vez)
Desde una máquina con acceso a Mongo Atlas Y a Supabase:

```bash
export MONGO_URL='mongodb+srv://...tu-url-completa...'
export DB_NAME='tacos_pos'
export DATABASE_URL='postgresql://postgres.TENANT:PASS@srv1793433.hstgr.cloud:5432/postgres'
python scripts/migrate_mongo_to_pg.py
```

El script es **idempotente**: si lo corres 2 veces no duplica nada (usa `ON CONFLICT DO NOTHING/UPDATE`). Aplica el `schema.sql` automáticamente al inicio.

Salida esperada:
```
✓ sucursales: 5/5
✓ products: 12/12
✓ users: 8/8
✓ sales: 16/16
✅ Migración completa.
```

### C. Cambiar el backend en `.env`
En `backend/.env`:
```diff
- MONGO_URL="mongodb+srv://..."
- DB_NAME="tacos_pos"
+ DATABASE_URL="postgresql://postgres.TENANT:PASS@srv1793433.hstgr.cloud:5432/postgres"
```

### D. Cambiar a `server_pg.py`
En `supervisor` o el comando que arranca el backend, cambia `server:app` → `server_pg:app`:
```
uvicorn server_pg:app --host 0.0.0.0 --port 8001
```

(En Hostinger, en el panel de tu app, edita el "entry point" o `Procfile`.)

### E. Reiniciar y verificar
```bash
sudo supervisorctl restart backend
curl http://localhost:8001/api/health
# → {"ok": true, "last_sale_at": "..."}
curl http://localhost:8001/api/products | head
```

### F. Cuando todo funcione, borra `server.py`
Después de 1-2 días de tener Postgres en producción sin problemas, puedes eliminar
`server.py` y la dependencia `motor` de `requirements.txt`.

---

## 3. Rollback (volver a Mongo si algo sale mal)

Es **instantáneo** porque dejamos `server.py` intacto:
1. Revertir `.env` a `MONGO_URL` y `DB_NAME`
2. Cambiar entry point de `server_pg:app` → `server:app`
3. `sudo supervisorctl restart backend`

Los datos en Mongo Atlas no se modifican durante la migración (solo se leen), así que están seguros.

---

## 4. Comparación de comportamiento

| Característica | Mongo | Postgres |
|---|---|---|
| Endpoints API | iguales | iguales |
| Idempotencia (`client_id`) | índice unique parcial | índice unique parcial |
| Items/payments | docs anidados | columnas `JSONB` |
| Performance dashboard | índice en `created_at` | índice en `created_at` |
| Auditoría / health | iguales | iguales |
| Frontend | sin cambios | sin cambios |

**El frontend NO necesita ningún cambio.** Apunta al mismo `REACT_APP_BACKEND_URL`.

---

## 5. Notas

- Los **passwords de usuarios** se migran tal cual (texto plano, como estaban en Mongo). Después de la migración considera implementar bcrypt si quieres más seguridad.
- El campo `created_at` en Postgres es `TIMESTAMPTZ` real (mejor que el ISO string de Mongo).
- Si necesitas re-migrar (por si Atlas siguió recibiendo ventas mientras configurabas), corre el script otra vez: solo agregará las nuevas, no duplicará las viejas.
