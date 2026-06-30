"""
Migración Mongo → Postgres
==========================
Lee TODOS los datos de tu instancia Mongo Atlas y los carga a Postgres
(Supabase) con idempotencia: lo puedes correr múltiples veces sin duplicar.

Uso:
    export MONGO_URL="mongodb+srv://..."
    export DB_NAME="tacos_pos"   # o el que uses
    export DATABASE_URL="postgresql://postgres:PASS@HOST:5432/postgres"
    python scripts/migrate_mongo_to_pg.py

Lo que migra:
    - sucursales
    - products
    - users (con password_hash = password original; cambia luego si quieres bcrypt)
    - sales (incluyendo items y payments como JSONB)
"""
import asyncio, asyncpg, json, os, sys
from motor.motor_asyncio import AsyncIOMotorClient
from datetime import datetime, timezone


def _parse_dt(v):
    """Acepta datetime nativo o ISO string; devuelve datetime tz-aware UTC."""
    if v is None:
        return None
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, str):
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00"))
        except Exception:
            return None
    return None


async def main():
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME", "tacos_pos")
    pg_url = os.environ.get("DATABASE_URL")
    if not (mongo_url and pg_url):
        print("ERROR: define MONGO_URL y DATABASE_URL en el entorno.")
        sys.exit(1)

    print(f"→ Conectando a Mongo (db={db_name})…")
    mclient = AsyncIOMotorClient(mongo_url)
    mdb = mclient[db_name]

    print("→ Conectando a Postgres…")
    pool = await asyncpg.create_pool(pg_url, min_size=1, max_size=4, timeout=20)

    async with pool.acquire() as c:
        # Aplicar schema si no existe (idempotente)
        sql_path = os.path.join(os.path.dirname(__file__), "..", "backend", "schema.sql")
        if os.path.exists(sql_path):
            print("→ Aplicando schema.sql…")
            with open(sql_path) as f:
                await c.execute(f.read())

        # 1) Sucursales
        docs = await mdb.sucursales.find({}).to_list(10000)
        ok = 0
        for d in docs:
            try:
                await c.execute(
                    """INSERT INTO sucursales (id, name, sort_order) VALUES ($1,$2,$3)
                       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, sort_order=EXCLUDED.sort_order""",
                    d["id"], d["name"], int(d.get("sort_order", 0)))
                ok += 1
            except Exception as e:
                print(f"  ✗ sucursal {d.get('name')}: {e}")
        print(f"  ✓ sucursales: {ok}/{len(docs)}")

        # 2) Products
        docs = await mdb.products.find({}).to_list(10000)
        ok = 0
        for d in docs:
            try:
                await c.execute(
                    """INSERT INTO products (id, name, price, sort_order, active, category, pricing_mode)
                       VALUES ($1,$2,$3,$4,$5,$6,$7)
                       ON CONFLICT (id) DO UPDATE SET
                         name=EXCLUDED.name, price=EXCLUDED.price,
                         sort_order=EXCLUDED.sort_order, active=EXCLUDED.active,
                         category=EXCLUDED.category, pricing_mode=EXCLUDED.pricing_mode""",
                    d["id"], d["name"], float(d.get("price", 0)),
                    int(d.get("sort_order", 0)), bool(d.get("active", True)),
                    d.get("category", "comida"), d.get("pricing_mode", "fixed"))
                ok += 1
            except Exception as e:
                print(f"  ✗ product {d.get('name')}: {e}")
        print(f"  ✓ products: {ok}/{len(docs)}")

        # 3) Users
        docs = await mdb.users.find({}).to_list(10000)
        ok = 0
        for d in docs:
            try:
                await c.execute(
                    """INSERT INTO users (id, username, password_hash, role, sucursal, caja_name, active)
                       VALUES ($1,$2,$3,$4,$5,$6,$7)
                       ON CONFLICT (id) DO UPDATE SET
                         username=EXCLUDED.username, password_hash=EXCLUDED.password_hash,
                         role=EXCLUDED.role, sucursal=EXCLUDED.sucursal,
                         caja_name=EXCLUDED.caja_name, active=EXCLUDED.active""",
                    d["id"], d["username"], d.get("password", ""), d.get("role", "cashier"),
                    d.get("sucursal"), d.get("caja_name", "Caja 1"),
                    bool(d.get("active", True)))
                ok += 1
            except Exception as e:
                print(f"  ✗ user {d.get('username')}: {e}")
        print(f"  ✓ users: {ok}/{len(docs)}")

        # 4) Sales (incluyendo items y payments)
        cursor = mdb.sales.find({})
        batch = []
        total = 0
        ok = 0
        async for d in cursor:
            total += 1
            try:
                created = _parse_dt(d.get("created_at"))
                if created is None:
                    created = datetime.now(timezone.utc)
                items_json = json.dumps(d.get("items", []))
                payments = d.get("payments")
                payments_json = json.dumps(payments) if payments is not None else None
                await c.execute(
                    """INSERT INTO sales (
                           id, client_id, sucursal, cashier, caja, order_type, mesa_number,
                           subtotal, tip, iva, invoice_requested, delivery_fee, total,
                           payment_method, cash_received, change_given,
                           items, payments, created_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19)
                       ON CONFLICT (id) DO NOTHING""",
                    d["id"], d.get("client_id"), d.get("sucursal", "—"),
                    d.get("cashier"), d.get("caja"),
                    d.get("order_type", "mesa"), d.get("mesa_number"),
                    float(d.get("subtotal", 0)), float(d.get("tip", 0)),
                    float(d.get("iva", 0) or 0), bool(d.get("invoice_requested", False)),
                    float(d.get("delivery_fee", 0) or 0), float(d.get("total", 0)),
                    d.get("payment_method", "efectivo"),
                    d.get("cash_received"), d.get("change_given"),
                    items_json, payments_json, created)
                ok += 1
                if ok % 500 == 0:
                    print(f"    … {ok} ventas migradas")
            except Exception as e:
                print(f"  ✗ sale {d.get('id')}: {e}")
        print(f"  ✓ sales: {ok}/{total}")

    await pool.close()
    mclient.close()
    print("\n✅ Migración completa.")


if __name__ == "__main__":
    asyncio.run(main())
