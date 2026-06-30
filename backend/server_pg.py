"""
Tacos POS – Backend (PostgreSQL / Supabase)
============================================
Re-escritura del backend original (que usaba MongoDB) sobre PostgreSQL.
Mantiene EXACTAMENTE los mismos endpoints, payloads y comportamiento.

- `items` y `payments` se guardan como JSONB para preservar la flexibilidad
  del modelo original.
- `client_id` UNIQUE garantiza idempotencia (igual que el índice de Mongo).
- Mismos índices que la versión Mongo: created_at, (sucursal, created_at),
  (caja, created_at).

Variables de entorno:
  DATABASE_URL=postgresql://postgres:PASS@HOST:5432/postgres
  ADMIN_USERNAME, ADMIN_PASSWORD (fallback)
  CORS_ORIGINS=*
"""
from fastapi import FastAPI, APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
import asyncpg
import os
import io
import csv
import json
import calendar
import logging
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional, Literal
import uuid
from datetime import datetime, timezone, timedelta

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

DATABASE_URL = os.environ["DATABASE_URL"]
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "taco123")
MX_TZ = timezone(timedelta(hours=-6))

app = FastAPI(title="Tacos POS API (Postgres)")
api_router = APIRouter(prefix="/api")
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Pool global de asyncpg, creado en startup
pool: Optional[asyncpg.Pool] = None


# ---------------------------------------------------------------------------
# Models (idénticos al server.py de Mongo)
# ---------------------------------------------------------------------------
class Product(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    price: float
    sort_order: int = 0
    active: bool = True
    category: str = "comida"
    pricing_mode: str = "fixed"


class ProductCreate(BaseModel):
    name: str
    price: float = 0
    sort_order: int = 999
    category: str = "comida"
    pricing_mode: str = "fixed"


class ProductUpdate(BaseModel):
    name: Optional[str] = None
    price: Optional[float] = None
    sort_order: Optional[int] = None
    active: Optional[bool] = None
    category: Optional[str] = None
    pricing_mode: Optional[str] = None


class CartItem(BaseModel):
    product_id: str
    name: str
    price: float
    quantity: int


class Payment(BaseModel):
    method: Literal["efectivo", "transferencia", "tarjeta"]
    amount: float
    tip: float = 0.0
    cash_received: Optional[float] = None
    change_given: Optional[float] = None


class SaleCreate(BaseModel):
    items: List[CartItem]
    payment_method: Literal["efectivo", "transferencia", "tarjeta", "mixto"]
    tip: float = 0.0
    sucursal: str
    cashier: Optional[str] = None
    caja: Optional[str] = None
    order_type: Literal["mesa", "llevar", "domicilio"]
    mesa_number: Optional[str] = None
    cash_received: Optional[float] = None
    payments: Optional[List[Payment]] = None
    iva: float = 0.0
    invoice_requested: bool = False
    delivery_fee: float = 0.0
    client_id: Optional[str] = None


class Sale(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_id: Optional[str] = None
    items: List[CartItem]
    subtotal: float
    tip: float = 0.0
    iva: float = 0.0
    invoice_requested: bool = False
    delivery_fee: float = 0.0
    total: float
    payment_method: str
    payments: Optional[List[Payment]] = None
    sucursal: str
    cashier: Optional[str] = None
    caja: Optional[str] = None
    order_type: str = "mesa"
    mesa_number: Optional[str] = None
    cash_received: Optional[float] = None
    change_given: Optional[float] = None
    created_at: str


class Sucursal(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    sort_order: int = 0


class SucursalCreate(BaseModel):
    name: str


class SucursalUpdate(BaseModel):
    name: Optional[str] = None
    sort_order: Optional[int] = None


class User(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    username: str
    password: str
    role: Literal["admin", "cashier"] = "cashier"
    sucursal: Optional[str] = None
    caja_name: str = "Caja 1"
    active: bool = True


class UserCreate(BaseModel):
    username: str
    password: str
    role: Literal["admin", "cashier"] = "cashier"
    sucursal: Optional[str] = None
    caja_name: str = "Caja 1"


class UserUpdate(BaseModel):
    username: Optional[str] = None
    password: Optional[str] = None
    sucursal: Optional[str] = None
    caja_name: Optional[str] = None
    active: Optional[bool] = None


class LoginRequest(BaseModel):
    username: str
    password: str


# ---------------------------------------------------------------------------
# Helpers de fecha (igual al server original)
# ---------------------------------------------------------------------------
def date_range_utc(date_str: Optional[str] = None):
    if date_str:
        try:
            d = datetime.strptime(date_str, "%Y-%m-%d")
            start_mx = d.replace(tzinfo=MX_TZ)
        except ValueError:
            raise HTTPException(status_code=400, detail="Fecha inválida (YYYY-MM-DD)")
    else:
        now_mx = datetime.now(MX_TZ)
        start_mx = now_mx.replace(hour=0, minute=0, second=0, microsecond=0)
    end_mx = start_mx + timedelta(days=1)
    return start_mx.astimezone(timezone.utc), end_mx.astimezone(timezone.utc)


def today_mx_range_utc():
    return date_range_utc(None)


def period_range_utc(period: str, date_str: Optional[str] = None,
                     start_date: Optional[str] = None, end_date: Optional[str] = None):
    if period == "custom":
        if not start_date or not end_date:
            raise HTTPException(status_code=400, detail="start_date y end_date requeridos para custom")
        try:
            start_mx = datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=MX_TZ)
            end_base = datetime.strptime(end_date, "%Y-%m-%d").replace(tzinfo=MX_TZ)
        except ValueError:
            raise HTTPException(status_code=400, detail="Fechas inválidas (YYYY-MM-DD)")
        if end_base < start_mx:
            raise HTTPException(status_code=400, detail="end_date debe ser >= start_date")
        end_mx = end_base + timedelta(days=1)
        return (start_mx.astimezone(timezone.utc), end_mx.astimezone(timezone.utc), start_mx, end_base)
    if date_str:
        try:
            base = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=MX_TZ)
        except ValueError:
            raise HTTPException(status_code=400, detail="Fecha inválida (YYYY-MM-DD)")
    else:
        now_mx = datetime.now(MX_TZ)
        base = now_mx.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "week":
        start_mx = base - timedelta(days=base.weekday())
        end_mx = start_mx + timedelta(days=7)
    elif period == "month":
        start_mx = base.replace(day=1)
        last_day = calendar.monthrange(base.year, base.month)[1]
        end_mx = start_mx.replace(day=last_day) + timedelta(days=1)
    else:
        raise HTTPException(status_code=400, detail="Periodo inválido (week|month|custom)")
    return (start_mx.astimezone(timezone.utc), end_mx.astimezone(timezone.utc),
            start_mx, end_mx - timedelta(days=1))


# ---------------------------------------------------------------------------
# Seed defaults (idénticos al Mongo)
# ---------------------------------------------------------------------------
SUCURSALES_DEFAULT = ["Valle Dorado", "Mezcalitos", "San Vicente", "3.14", "San Jose"]

DEFAULT_PRODUCTS = [
    {"name": "Tacos",                "price": 30,  "sort_order": 1,  "category": "comida"},
    {"name": "Taco con Queso",       "price": 40,  "sort_order": 2,  "category": "comida"},
    {"name": "Quesadilla Sencilla",  "price": 60,  "sort_order": 3,  "category": "comida"},
    {"name": "Quesadilla con Carne", "price": 90,  "sort_order": 4,  "category": "comida"},
    {"name": "Volcanes",             "price": 40,  "sort_order": 5,  "category": "comida"},
    {"name": "Tacote",               "price": 70,  "sort_order": 6,  "category": "comida"},
    {"name": "Orden Grande",         "price": 160, "sort_order": 7,  "category": "comida"},
    {"name": "Orden Chica",          "price": 120, "sort_order": 8,  "category": "comida"},
    {"name": "Agua Grande",          "price": 40,  "sort_order": 9,  "category": "bebida"},
    {"name": "Agua Chica",           "price": 30,  "sort_order": 10, "category": "bebida"},
    {"name": "Refresco",             "price": 30,  "sort_order": 11, "category": "bebida"},
]
DEFAULT_USERS = [
    {"username": "admin",        "password": "taco123",    "role": "admin",   "sucursal": None,           "caja_name": "Admin"},
    {"username": "valle_dorado", "password": "valle123",   "role": "cashier", "sucursal": "Valle Dorado", "caja_name": "Caja 1"},
    {"username": "mezcalitos",   "password": "mezca123",   "role": "cashier", "sucursal": "Mezcalitos",   "caja_name": "Caja 1"},
    {"username": "san_vicente",  "password": "vicente123", "role": "cashier", "sucursal": "San Vicente",  "caja_name": "Caja 1"},
    {"username": "pi",           "password": "pi123",      "role": "cashier", "sucursal": "3.14",         "caja_name": "Caja 1"},
    {"username": "san_jose",     "password": "jose123",    "role": "cashier", "sucursal": "San Jose",     "caja_name": "Caja 1"},
]


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------
async def get_sucursales_names() -> List[str]:
    async with pool.acquire() as c:
        rows = await c.fetch("SELECT name FROM sucursales ORDER BY sort_order ASC")
    return [r["name"] for r in rows]


def _sale_row_to_dict(r) -> dict:
    """Convierte una fila de la tabla sales a dict serializable (mismo formato Mongo)."""
    d = dict(r)
    # JSONB ya viene como str de Postgres → parsear
    items = d.get("items")
    if isinstance(items, str):
        d["items"] = json.loads(items) if items else []
    elif items is None:
        d["items"] = []
    payments = d.get("payments")
    if isinstance(payments, str):
        d["payments"] = json.loads(payments) if payments else None
    # Convertir numéricos a float (asyncpg devuelve Decimal por DEFAULT)
    for k in ("subtotal", "tip", "iva", "delivery_fee", "total", "cash_received", "change_given"):
        if d.get(k) is not None:
            d[k] = float(d[k])
    # created_at a ISO string (como Mongo)
    ca = d.get("created_at")
    if isinstance(ca, datetime):
        d["created_at"] = ca.astimezone(timezone.utc).isoformat()
    return d


async def seed_if_empty():
    """Crea sucursales, productos y usuarios por defecto si las tablas están vacías."""
    async with pool.acquire() as c:
        n = await c.fetchval("SELECT COUNT(*) FROM sucursales")
        if n == 0:
            for i, name in enumerate(SUCURSALES_DEFAULT):
                await c.execute(
                    "INSERT INTO sucursales (id, name, sort_order) VALUES ($1, $2, $3)",
                    str(uuid.uuid4()), name, i + 1,
                )
            logger.info("Seeded %d sucursales", len(SUCURSALES_DEFAULT))

        n = await c.fetchval("SELECT COUNT(*) FROM products")
        if n == 0:
            for p in DEFAULT_PRODUCTS:
                await c.execute(
                    """INSERT INTO products (id, name, price, sort_order, category, active, pricing_mode)
                       VALUES ($1, $2, $3, $4, $5, TRUE, 'fixed')""",
                    str(uuid.uuid4()), p["name"], p["price"], p["sort_order"], p["category"],
                )
            logger.info("Seeded %d products", len(DEFAULT_PRODUCTS))

        n = await c.fetchval("SELECT COUNT(*) FROM users")
        if n == 0:
            for u in DEFAULT_USERS:
                await c.execute(
                    """INSERT INTO users (id, username, password_hash, role, sucursal, caja_name, active)
                       VALUES ($1, $2, $3, $4, $5, $6, TRUE)""",
                    str(uuid.uuid4()), u["username"], u["password"], u["role"], u["sucursal"], u["caja_name"],
                )
            logger.info("Seeded %d users", len(DEFAULT_USERS))


# ---------------------------------------------------------------------------
# Routes – Products
# ---------------------------------------------------------------------------
@api_router.get("/products", response_model=List[Product])
async def list_products(include_inactive: bool = False):
    sql = "SELECT * FROM products"
    if not include_inactive:
        sql += " WHERE active = TRUE"
    sql += " ORDER BY sort_order ASC"
    async with pool.acquire() as c:
        rows = await c.fetch(sql)
    return [Product(**dict(r) | {"price": float(r["price"])}) for r in rows]


@api_router.post("/products", response_model=Product)
async def create_product(body: ProductCreate):
    prod = Product(**body.model_dump())
    async with pool.acquire() as c:
        await c.execute(
            """INSERT INTO products (id, name, price, sort_order, active, category, pricing_mode)
               VALUES ($1, $2, $3, $4, TRUE, $5, $6)""",
            prod.id, prod.name, prod.price, prod.sort_order, prod.category, prod.pricing_mode,
        )
    return prod


@api_router.put("/products/{product_id}", response_model=Product)
async def update_product(product_id: str, body: ProductUpdate):
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")
    # Build dynamic UPDATE
    sets = []
    vals = []
    for i, (k, v) in enumerate(fields.items(), start=1):
        sets.append(f"{k} = ${i}")
        vals.append(v)
    vals.append(product_id)
    async with pool.acquire() as c:
        row = await c.fetchrow(
            f"UPDATE products SET {', '.join(sets)} WHERE id = ${len(vals)} RETURNING *",
            *vals,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Product not found")
    return Product(**dict(row) | {"price": float(row["price"])})


@api_router.post("/products/reorder")
async def reorder_products(body: dict):
    ids = body.get("ids", [])
    if not isinstance(ids, list) or not ids:
        raise HTTPException(status_code=400, detail="ids requeridos")
    async with pool.acquire() as c:
        async with c.transaction():
            for idx, pid in enumerate(ids):
                await c.execute("UPDATE products SET sort_order = $1 WHERE id = $2", idx + 1, pid)
    return {"ok": True, "count": len(ids)}


@api_router.delete("/products/{product_id}")
async def delete_product(product_id: str):
    async with pool.acquire() as c:
        res = await c.execute("DELETE FROM products WHERE id = $1", product_id)
    if res.endswith(" 0"):
        raise HTTPException(status_code=404, detail="Product not found")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Routes – Sales
# ---------------------------------------------------------------------------
@api_router.post("/sales", response_model=Sale)
async def create_sale(body: SaleCreate):
    if not body.items:
        raise HTTPException(status_code=400, detail="Empty cart")

    # Idempotencia
    if body.client_id:
        async with pool.acquire() as c:
            row = await c.fetchrow("SELECT * FROM sales WHERE client_id = $1", body.client_id)
        if row:
            return Sale(**_sale_row_to_dict(row))

    valid_sucursales = await get_sucursales_names()
    if body.sucursal not in valid_sucursales:
        raise HTTPException(status_code=400, detail="Sucursal inválida")
    if body.order_type == "mesa" and not (body.mesa_number and str(body.mesa_number).strip()):
        raise HTTPException(status_code=400, detail="Número de mesa requerido")

    subtotal = round(sum(i.price * i.quantity for i in body.items), 2)
    iva = round(float(body.iva or 0), 2) if body.invoice_requested else 0.0
    delivery_fee = round(float(body.delivery_fee or 0), 2) if body.order_type == "domicilio" else 0.0

    if body.payment_method == "mixto":
        if not body.payments or len(body.payments) < 2:
            raise HTTPException(status_code=400, detail="Pago mixto requiere al menos 2 partes")
        tip = round(sum(p.tip for p in body.payments if p.method in ("tarjeta", "transferencia")), 2)
        total = round(subtotal + tip + iva + delivery_fee, 2)
        sum_amount = round(sum(p.amount for p in body.payments), 2)
        if abs(sum_amount - total) > 0.02:
            raise HTTPException(status_code=400,
                                detail=f"Las partes ({sum_amount}) deben sumar el total ({total})")
        processed_payments = []
        cash_total_received = 0.0
        change_total = 0.0
        for p in body.payments:
            cr = cg = None
            if p.method == "efectivo" and p.cash_received is not None:
                cr = float(p.cash_received)
                if cr < p.amount:
                    raise HTTPException(status_code=400, detail="Dinero recibido menor al monto en efectivo")
                cg = round(cr - p.amount, 2)
                cash_total_received += cr
                change_total += cg
            t = p.tip if p.method in ("tarjeta", "transferencia") else 0.0
            processed_payments.append(Payment(
                method=p.method, amount=round(p.amount, 2),
                tip=round(t, 2), cash_received=cr, change_given=cg,
            ))
        cash_received = cash_total_received if cash_total_received > 0 else None
        change_given = change_total if change_total > 0 else None
    else:
        tip = body.tip if body.payment_method in ("tarjeta", "transferencia") else 0.0
        if body.payment_method != "tarjeta":
            iva = 0.0
        total = round(subtotal + tip + iva + delivery_fee, 2)
        cash_received = change_given = None
        if body.payment_method == "efectivo" and body.cash_received is not None:
            cash_received = float(body.cash_received)
            if cash_received < total:
                raise HTTPException(status_code=400, detail="Dinero recibido menor al total")
            change_given = round(cash_received - total, 2)
        processed_payments = [Payment(
            method=body.payment_method, amount=total,
            tip=round(tip, 2), cash_received=cash_received, change_given=change_given,
        )]

    sale = Sale(
        client_id=body.client_id,
        items=body.items,
        subtotal=subtotal,
        tip=round(tip, 2),
        iva=iva,
        invoice_requested=bool(body.invoice_requested and iva > 0),
        delivery_fee=delivery_fee,
        total=total,
        payment_method=body.payment_method,
        payments=processed_payments,
        sucursal=body.sucursal,
        cashier=body.cashier,
        caja=body.caja,
        order_type=body.order_type,
        mesa_number=(str(body.mesa_number).strip() if body.mesa_number else None),
        cash_received=cash_received,
        change_given=change_given,
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    items_json = json.dumps([i.model_dump() for i in sale.items])
    payments_json = json.dumps([p.model_dump() for p in (sale.payments or [])])
    created_dt = datetime.fromisoformat(sale.created_at)

    try:
        async with pool.acquire() as c:
            await c.execute(
                """INSERT INTO sales (
                       id, client_id, sucursal, cashier, caja, order_type, mesa_number,
                       subtotal, tip, iva, invoice_requested, delivery_fee, total,
                       payment_method, cash_received, change_given,
                       items, payments, created_at
                   ) VALUES (
                       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19
                   )""",
                sale.id, sale.client_id, sale.sucursal, sale.cashier, sale.caja,
                sale.order_type, sale.mesa_number,
                sale.subtotal, sale.tip, sale.iva, sale.invoice_requested,
                sale.delivery_fee, sale.total, sale.payment_method,
                sale.cash_received, sale.change_given,
                items_json, payments_json, created_dt,
            )
    except asyncpg.UniqueViolationError:
        # carrera entre reintentos del mismo client_id → devolver la existente
        if body.client_id:
            async with pool.acquire() as c:
                row = await c.fetchrow("SELECT * FROM sales WHERE client_id = $1", body.client_id)
            if row:
                return Sale(**_sale_row_to_dict(row))
        raise HTTPException(status_code=500, detail="Duplicado de venta")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"No se pudo guardar la venta: {e}")
    return sale


@api_router.get("/sales", response_model=List[Sale])
async def list_sales(
    scope: Literal["today", "all", "date"] = "today",
    date: Optional[str] = None,
    sucursal: Optional[str] = None,
    caja: Optional[str] = None,
):
    where = []
    args: list = []
    if scope == "today":
        start_dt, end_dt = today_mx_range_utc()
        args += [start_dt, end_dt]
        where.append(f"created_at >= ${len(args)-1} AND created_at < ${len(args)}")
    elif scope == "date" and date:
        start_dt, end_dt = date_range_utc(date)
        args += [start_dt, end_dt]
        where.append(f"created_at >= ${len(args)-1} AND created_at < ${len(args)}")
    if sucursal and sucursal != "all":
        args.append(sucursal)
        where.append(f"sucursal = ${len(args)}")
    if caja and caja != "all":
        args.append(caja)
        where.append(f"caja = ${len(args)}")
    sql = "SELECT * FROM sales"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC LIMIT 50000"
    async with pool.acquire() as c:
        rows = await c.fetch(sql, *args)
    return [Sale(**_sale_row_to_dict(r)) for r in rows]


# ---------------------------------------------------------------------------
# Helper: query sales for aggregations
# ---------------------------------------------------------------------------
async def _query_sales(start_dt: datetime, end_dt: datetime,
                       sucursal: Optional[str], caja: Optional[str]) -> List[dict]:
    where = ["created_at >= $1", "created_at < $2"]
    args: list = [start_dt, end_dt]
    if sucursal and sucursal != "all":
        args.append(sucursal); where.append(f"sucursal = ${len(args)}")
    if caja and caja != "all":
        args.append(caja); where.append(f"caja = ${len(args)}")
    sql = "SELECT * FROM sales WHERE " + " AND ".join(where) + " ORDER BY created_at"
    async with pool.acquire() as c:
        rows = await c.fetch(sql, *args)
    return [_sale_row_to_dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Dashboard del día
# ---------------------------------------------------------------------------
@api_router.get("/dashboard")
async def dashboard(date: Optional[str] = None, sucursal: Optional[str] = None, caja: Optional[str] = None):
    start_dt, end_dt = date_range_utc(date)
    sales = await _query_sales(start_dt, end_dt, sucursal, caja)
    totals = {
        "efectivo":      {"count": 0, "amount": 0.0, "tip": 0.0, "iva": 0.0},
        "transferencia": {"count": 0, "amount": 0.0, "tip": 0.0, "iva": 0.0},
        "tarjeta":       {"count": 0, "amount": 0.0, "tip": 0.0, "iva": 0.0},
    }
    by_order_type = {
        "mesa":      {"count": 0, "total": 0.0, "delivery": 0.0},
        "llevar":    {"count": 0, "total": 0.0, "delivery": 0.0},
        "domicilio": {"count": 0, "total": 0.0, "delivery": 0.0},
    }
    products_count: dict = {}
    products_amount: dict = {}
    hourly = {h: 0.0 for h in range(24)}
    grand_total = grand_subtotal = grand_tip = grand_iva = grand_delivery = 0.0
    invoice_count = total_items = 0
    tip_breakdown = {"tarjeta": 0.0, "transferencia": 0.0}
    by_sucursal: dict = {s: {"count": 0, "total": 0.0} for s in (await get_sucursales_names())}
    by_caja: dict = {}

    for s in sales:
        pm = s.get("payment_method", "efectivo")
        sub = float(s.get("subtotal", 0))
        tip = float(s.get("tip", 0))
        tot = float(s.get("total", sub + tip))
        ot = s.get("order_type", "mesa")
        ck = s.get("caja") or "—"
        payments = s.get("payments") or []
        sale_iva = float(s.get("iva", 0) or 0)
        sale_delivery = float(s.get("delivery_fee", 0) or 0)

        if payments:
            tarjeta_in = any(p.get("method") == "tarjeta" for p in payments)
            for p in payments:
                m = p.get("method"); pa = float(p.get("amount", 0)); pt = float(p.get("tip", 0))
                if m in totals:
                    totals[m]["count"] += 1; totals[m]["amount"] += pa; totals[m]["tip"] += pt
                if m in tip_breakdown:
                    tip_breakdown[m] += pt
            if tarjeta_in and sale_iva > 0:
                totals["tarjeta"]["iva"] += sale_iva
        else:
            if pm in totals:
                totals[pm]["count"] += 1; totals[pm]["amount"] += sub; totals[pm]["tip"] += tip
                if pm == "tarjeta" and sale_iva > 0:
                    totals[pm]["iva"] += sale_iva
            if pm in tip_breakdown:
                tip_breakdown[pm] += tip

        if ot in by_order_type:
            by_order_type[ot]["count"] += 1; by_order_type[ot]["total"] += tot
            by_order_type[ot]["delivery"] += sale_delivery

        grand_subtotal += sub; grand_tip += tip; grand_total += tot
        grand_iva += sale_iva; grand_delivery += sale_delivery
        if s.get("invoice_requested"):
            invoice_count += 1

        suc = s.get("sucursal", "—")
        if suc in by_sucursal:
            by_sucursal[suc]["count"] += 1; by_sucursal[suc]["total"] += tot
        by_caja.setdefault(ck, {"count": 0, "total": 0.0})
        by_caja[ck]["count"] += 1; by_caja[ck]["total"] += tot

        for it in s.get("items", []):
            n = it.get("name", "?")
            qty = int(it.get("quantity", 0))
            price = float(it.get("price", 0))
            products_count[n] = products_count.get(n, 0) + qty
            products_amount[n] = products_amount.get(n, 0.0) + price * qty
            total_items += qty

        try:
            dt_mx = datetime.fromisoformat(s["created_at"]).astimezone(MX_TZ)
            hourly[dt_mx.hour] += tot
        except Exception:
            pass

    top_products = sorted(
        [{"name": k, "quantity": v, "revenue": round(products_amount.get(k, 0), 2)}
         for k, v in products_count.items()],
        key=lambda x: x["quantity"], reverse=True,
    )
    sales_by_hour = [{"hour": f"{h:02d}:00", "total": round(hourly[h], 2)} for h in range(24)]
    peak_hour = None
    if any(v > 0 for v in hourly.values()):
        peak = max(hourly.items(), key=lambda x: x[1])
        peak_hour = {"hour": f"{peak[0]:02d}:00", "total": round(peak[1], 2)}

    sales_count = len(sales)
    avg_ticket = round(grand_total / sales_count, 2) if sales_count else 0
    avg_items = round(total_items / sales_count, 2) if sales_count else 0

    return {
        "date": date or datetime.now(MX_TZ).strftime("%Y-%m-%d"),
        "sucursal": sucursal or "all",
        "caja": caja or "all",
        "grand_total": round(grand_total, 2),
        "grand_subtotal": round(grand_subtotal, 2),
        "grand_tip": round(grand_tip, 2),
        "grand_iva": round(grand_iva, 2),
        "grand_delivery": round(grand_delivery, 2),
        "invoice_count": invoice_count,
        "sales_count": sales_count,
        "avg_ticket": avg_ticket,
        "avg_items": avg_items,
        "peak_hour": peak_hour,
        "total_items": total_items,
        "by_payment": {k: {"count": v["count"], "amount": round(v["amount"], 2),
                           "tip": round(v["tip"], 2), "iva": round(v["iva"], 2)}
                       for k, v in totals.items()},
        "tip_breakdown": {k: round(v, 2) for k, v in tip_breakdown.items()},
        "by_sucursal": {k: {"count": v["count"], "total": round(v["total"], 2)}
                        for k, v in by_sucursal.items()},
        "by_caja": {k: {"count": v["count"], "total": round(v["total"], 2)}
                    for k, v in by_caja.items()},
        "by_order_type": {k: {"count": v["count"], "total": round(v["total"], 2),
                              "delivery": round(v["delivery"], 2)}
                          for k, v in by_order_type.items()},
        "top_products": top_products,
        "sales_by_hour": sales_by_hour,
    }


# ---------------------------------------------------------------------------
# Dashboard de periodo
# ---------------------------------------------------------------------------
DAY_NAMES_ES = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"]


@api_router.get("/dashboard/period")
async def dashboard_period(
    period: Literal["week", "month", "custom"] = "week",
    date: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    sucursal: Optional[str] = None,
    caja: Optional[str] = None,
):
    start_dt, end_dt, start_mx, end_mx = period_range_utc(period, date, start_date, end_date)
    sales = await _query_sales(start_dt, end_dt, sucursal, caja)

    by_day: dict = {}
    by_day_of_week = {i: {"count": 0, "total": 0.0} for i in range(7)}
    by_day_hour: dict = {}
    by_hour = {h: 0.0 for h in range(24)}
    products_count: dict = {}
    products_amount: dict = {}
    totals = {
        "efectivo":      {"count": 0, "amount": 0.0, "tip": 0.0},
        "transferencia": {"count": 0, "amount": 0.0, "tip": 0.0},
        "tarjeta":       {"count": 0, "amount": 0.0, "tip": 0.0},
    }
    by_order_type = {
        "mesa":      {"count": 0, "total": 0.0},
        "llevar":    {"count": 0, "total": 0.0},
        "domicilio": {"count": 0, "total": 0.0},
    }
    by_sucursal: dict = {s: {"count": 0, "total": 0.0} for s in (await get_sucursales_names())}
    by_caja: dict = {}
    grand_total = grand_subtotal = grand_tip = grand_iva = grand_delivery = 0.0
    invoice_count = total_items = 0

    for s in sales:
        sub = float(s.get("subtotal", 0)); tip = float(s.get("tip", 0))
        tot = float(s.get("total", sub + tip))
        pm = s.get("payment_method", "efectivo"); ot = s.get("order_type", "mesa")
        try:
            dt_mx = datetime.fromisoformat(s["created_at"]).astimezone(MX_TZ)
        except Exception:
            continue
        day_key = dt_mx.strftime("%Y-%m-%d"); hour = dt_mx.hour; dow = dt_mx.weekday()
        by_day.setdefault(day_key, {"count": 0, "total": 0.0})
        by_day[day_key]["count"] += 1; by_day[day_key]["total"] += tot
        by_day_of_week[dow]["count"] += 1; by_day_of_week[dow]["total"] += tot
        by_day_hour[(day_key, hour)] = by_day_hour.get((day_key, hour), 0.0) + tot
        by_hour[hour] += tot

        if pm in totals:
            totals[pm]["count"] += 1; totals[pm]["amount"] += sub; totals[pm]["tip"] += tip
        payments = s.get("payments") or []
        if payments:
            if pm != "mixto":
                totals[pm]["count"] -= 1; totals[pm]["amount"] -= sub; totals[pm]["tip"] -= tip
            for p in payments:
                m = p.get("method"); pa = float(p.get("amount", 0)); pt = float(p.get("tip", 0))
                if m in totals:
                    totals[m]["count"] += 1; totals[m]["amount"] += pa; totals[m]["tip"] += pt
        if ot in by_order_type:
            by_order_type[ot]["count"] += 1; by_order_type[ot]["total"] += tot
        suc = s.get("sucursal", "—")
        if suc in by_sucursal:
            by_sucursal[suc]["count"] += 1; by_sucursal[suc]["total"] += tot
        ck = s.get("caja") or "—"
        by_caja.setdefault(ck, {"count": 0, "total": 0.0})
        by_caja[ck]["count"] += 1; by_caja[ck]["total"] += tot

        for it in s.get("items", []):
            n = it.get("name", "?"); qty = int(it.get("quantity", 0))
            price = float(it.get("price", 0))
            products_count[n] = products_count.get(n, 0) + qty
            products_amount[n] = products_amount.get(n, 0.0) + price * qty
            total_items += qty

        grand_subtotal += sub; grand_tip += tip; grand_total += tot
        grand_iva += float(s.get("iva", 0) or 0); grand_delivery += float(s.get("delivery_fee", 0) or 0)
        if s.get("invoice_requested"):
            invoice_count += 1

    days_list = []
    cur = start_mx
    while cur.date() <= end_mx.date():
        key = cur.strftime("%Y-%m-%d")
        d = by_day.get(key, {"count": 0, "total": 0.0})
        days_list.append({"date": key, "label": cur.strftime("%d %b"),
                          "count": d["count"], "total": round(d["total"], 2)})
        cur += timedelta(days=1)

    best_day = None
    if days_list:
        bd = max(days_list, key=lambda x: x["total"])
        if bd["total"] > 0:
            best_day = bd

    best_day_hour = None
    if by_day_hour:
        (dh_date, dh_hour), dh_total = max(by_day_hour.items(), key=lambda x: x[1])
        if dh_total > 0:
            best_day_hour = {"date": dh_date, "hour": f"{dh_hour:02d}:00", "total": round(dh_total, 2)}

    best_dow = None
    if any(v["total"] > 0 for v in by_day_of_week.values()):
        idx, val = max(by_day_of_week.items(), key=lambda x: x[1]["total"])
        best_dow = {"name": DAY_NAMES_ES[idx], "total": round(val["total"], 2), "count": val["count"]}

    sales_count = len(sales)
    avg_ticket = round(grand_total / sales_count, 2) if sales_count else 0
    avg_items = round(total_items / sales_count, 2) if sales_count else 0
    days_with_sales = sum(1 for d in days_list if d["count"] > 0)
    avg_daily = round(grand_total / days_with_sales, 2) if days_with_sales else 0

    top_products = sorted(
        [{"name": k, "quantity": v, "revenue": round(products_amount.get(k, 0), 2)}
         for k, v in products_count.items()],
        key=lambda x: x["quantity"], reverse=True,
    )

    return {
        "period": period,
        "start": start_mx.strftime("%Y-%m-%d"),
        "end": end_mx.strftime("%Y-%m-%d"),
        "sucursal": sucursal or "all", "caja": caja or "all",
        "grand_total": round(grand_total, 2),
        "grand_subtotal": round(grand_subtotal, 2),
        "grand_tip": round(grand_tip, 2),
        "grand_iva": round(grand_iva, 2),
        "grand_delivery": round(grand_delivery, 2),
        "invoice_count": invoice_count,
        "sales_count": sales_count,
        "total_items": total_items,
        "avg_ticket": avg_ticket, "avg_items": avg_items, "avg_daily": avg_daily,
        "days_with_sales": days_with_sales,
        "best_day": best_day, "best_day_hour": best_day_hour, "best_dow": best_dow,
        "by_day": days_list,
        "by_day_of_week": [{"name": DAY_NAMES_ES[i], "count": v["count"], "total": round(v["total"], 2)}
                           for i, v in by_day_of_week.items()],
        "by_hour": [{"hour": f"{h:02d}:00", "total": round(by_hour[h], 2)} for h in range(24)],
        "by_payment": {k: {"count": v["count"], "amount": round(v["amount"], 2),
                           "tip": round(v["tip"], 2)} for k, v in totals.items()},
        "by_order_type": {k: {"count": v["count"], "total": round(v["total"], 2)}
                          for k, v in by_order_type.items()},
        "by_sucursal": {k: {"count": v["count"], "total": round(v["total"], 2)}
                        for k, v in by_sucursal.items()},
        "by_caja": {k: {"count": v["count"], "total": round(v["total"], 2)}
                    for k, v in by_caja.items()},
        "top_products": top_products,
    }


# ---------------------------------------------------------------------------
# CSV report
# ---------------------------------------------------------------------------
@api_router.get("/reports/csv")
async def report_csv(
    period: Literal["week", "month", "custom"] = "week",
    date: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    sucursal: Optional[str] = None,
    caja: Optional[str] = None,
):
    start_dt, end_dt, start_mx, end_mx = period_range_utc(period, date, start_date, end_date)
    sales = await _query_sales(start_dt, end_dt, sucursal, caja)
    buckets: dict = {}
    for s in sales:
        try:
            dt_mx = datetime.fromisoformat(s["created_at"]).astimezone(MX_TZ)
        except Exception:
            continue
        key = (dt_mx.strftime("%Y-%m-%d"), s.get("sucursal", "—"))
        b = buckets.setdefault(key, {
            "count": 0, "total": 0.0, "subtotal": 0.0, "tip": 0.0,
            "iva": 0.0, "delivery": 0.0, "invoices": 0,
            "efectivo": 0.0, "transferencia": 0.0, "tarjeta": 0.0,
            "tip_tarjeta": 0.0, "tip_transferencia": 0.0,
            "mesa": 0.0, "llevar": 0.0, "domicilio": 0.0,
            "mesa_n": 0, "llevar_n": 0, "domicilio_n": 0, "items": 0,
        })
        sub = float(s.get("subtotal", 0)); tip = float(s.get("tip", 0))
        tot = float(s.get("total", sub + tip))
        pm = s.get("payment_method", "efectivo"); ot = s.get("order_type", "mesa")
        payments = s.get("payments") or []
        b["count"] += 1; b["total"] += tot; b["subtotal"] += sub; b["tip"] += tip
        b["iva"] += float(s.get("iva", 0) or 0); b["delivery"] += float(s.get("delivery_fee", 0) or 0)
        if s.get("invoice_requested"):
            b["invoices"] += 1
        if payments:
            for p in payments:
                m = p.get("method", "efectivo"); pa = float(p.get("amount", 0)); pt = float(p.get("tip", 0))
                if m in ("efectivo", "transferencia", "tarjeta"):
                    b[m] += pa
                if m == "tarjeta": b["tip_tarjeta"] += pt
                if m == "transferencia": b["tip_transferencia"] += pt
        else:
            if pm in ("efectivo", "transferencia", "tarjeta"):
                b[pm] += sub
            if pm == "tarjeta": b["tip_tarjeta"] += tip
            if pm == "transferencia": b["tip_transferencia"] += tip
        if ot in ("mesa", "llevar", "domicilio"):
            b[ot] += tot; b[f"{ot}_n"] += 1
        for it in s.get("items", []):
            b["items"] += int(it.get("quantity", 0))

    buf = io.StringIO(); w = csv.writer(buf)
    w.writerow(["Fecha", "Sucursal", "Ventas", "Total", "Subtotal", "Propinas",
                "IVA", "Envío", "Facturas (#)", "Ticket promedio", "Items vendidos",
                "Efectivo", "Transferencia", "Tarjeta",
                "Propina tarjeta", "Propina transferencia",
                "Mesa (total)", "Mesa (#)", "Llevar (total)", "Llevar (#)",
                "Domicilio (total)", "Domicilio (#)"])
    cur = start_mx
    suc_filter = sucursal if sucursal and sucursal != "all" else None
    sucursal_list = (await get_sucursales_names()) if not suc_filter else [suc_filter]
    while cur.date() <= end_mx.date():
        date_key = cur.strftime("%Y-%m-%d")
        for suc in sucursal_list:
            b = buckets.get((date_key, suc))
            if not b: continue
            avg = (b["total"] / b["count"]) if b["count"] else 0
            w.writerow([date_key, suc, b["count"],
                        f"{b['total']:.2f}", f"{b['subtotal']:.2f}", f"{b['tip']:.2f}",
                        f"{b['iva']:.2f}", f"{b['delivery']:.2f}", b["invoices"],
                        f"{avg:.2f}", b["items"],
                        f"{b['efectivo']:.2f}", f"{b['transferencia']:.2f}", f"{b['tarjeta']:.2f}",
                        f"{b['tip_tarjeta']:.2f}", f"{b['tip_transferencia']:.2f}",
                        f"{b['mesa']:.2f}", b["mesa_n"],
                        f"{b['llevar']:.2f}", b["llevar_n"],
                        f"{b['domicilio']:.2f}", b["domicilio_n"]])
        cur += timedelta(days=1)
    if buckets:
        tot_total = sum(b["total"] for b in buckets.values())
        tot_count = sum(b["count"] for b in buckets.values())
        tot_avg = (tot_total / tot_count) if tot_count else 0
        w.writerow([])
        w.writerow(["TOTAL", f"{len(sucursal_list)} sucursales" if len(sucursal_list) > 1 else sucursal_list[0],
                    tot_count, f"{tot_total:.2f}",
                    f"{sum(b['subtotal'] for b in buckets.values()):.2f}",
                    f"{sum(b['tip'] for b in buckets.values()):.2f}",
                    f"{sum(b['iva'] for b in buckets.values()):.2f}",
                    f"{sum(b['delivery'] for b in buckets.values()):.2f}",
                    sum(b["invoices"] for b in buckets.values()),
                    f"{tot_avg:.2f}", sum(b["items"] for b in buckets.values()),
                    f"{sum(b['efectivo'] for b in buckets.values()):.2f}",
                    f"{sum(b['transferencia'] for b in buckets.values()):.2f}",
                    f"{sum(b['tarjeta'] for b in buckets.values()):.2f}",
                    f"{sum(b['tip_tarjeta'] for b in buckets.values()):.2f}",
                    f"{sum(b['tip_transferencia'] for b in buckets.values()):.2f}",
                    f"{sum(b['mesa'] for b in buckets.values()):.2f}",
                    sum(b["mesa_n"] for b in buckets.values()),
                    f"{sum(b['llevar'] for b in buckets.values()):.2f}",
                    sum(b["llevar_n"] for b in buckets.values()),
                    f"{sum(b['domicilio'] for b in buckets.values()):.2f}",
                    sum(b["domicilio_n"] for b in buckets.values())])
    buf.seek(0)
    filename = f"reporte_{period}_{start_mx.strftime('%Y%m%d')}_{end_mx.strftime('%Y%m%d')}.csv"
    content = "\ufeff" + buf.getvalue()
    return StreamingResponse(iter([content]),
                             media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# ---------------------------------------------------------------------------
# Auth & users & sucursales
# ---------------------------------------------------------------------------
@api_router.post("/auth/login")
async def login(body: LoginRequest):
    async with pool.acquire() as c:
        row = await c.fetchrow(
            """SELECT id, username, role, sucursal, caja_name, active
               FROM users WHERE username = $1 AND password_hash = $2 AND active = TRUE""",
            body.username, body.password,
        )
    if not row:
        if body.username == ADMIN_USERNAME and body.password == ADMIN_PASSWORD:
            return {"ok": True, "token": f"session-{ADMIN_USERNAME}",
                    "user": {"username": ADMIN_USERNAME, "role": "admin", "sucursal": None}}
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Credenciales inválidas")
    user = dict(row)
    return {"ok": True, "token": f"session-{user['username']}", "user": user}


@api_router.post("/admin/login")
async def admin_login(body: LoginRequest):
    res = await login(body)
    if res["user"]["role"] != "admin":
        raise HTTPException(status_code=403, detail="Solo administradores")
    return res


@api_router.get("/sucursales")
async def list_sucursales():
    async with pool.acquire() as c:
        rows = await c.fetch("SELECT * FROM sucursales ORDER BY sort_order ASC")
    items = [dict(r) for r in rows]
    for it in items:
        it.pop("created_at", None)
    return {"sucursales": [d["name"] for d in items], "items": items}


@api_router.post("/sucursales", response_model=Sucursal)
async def create_sucursal(body: SucursalCreate):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nombre requerido")
    async with pool.acquire() as c:
        ex = await c.fetchval("SELECT 1 FROM sucursales WHERE name = $1", name)
        if ex:
            raise HTTPException(status_code=409, detail="Esa sucursal ya existe")
        max_order = await c.fetchval("SELECT COALESCE(MAX(sort_order), 0) FROM sucursales")
        suc = Sucursal(name=name, sort_order=int(max_order) + 1)
        await c.execute("INSERT INTO sucursales (id, name, sort_order) VALUES ($1, $2, $3)",
                        suc.id, suc.name, suc.sort_order)
    return suc


@api_router.put("/sucursales/{sucursal_id}", response_model=Sucursal)
async def update_sucursal(sucursal_id: str, body: SucursalUpdate):
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="Sin cambios")
    async with pool.acquire() as c:
        target = await c.fetchrow("SELECT * FROM sucursales WHERE id = $1", sucursal_id)
        if not target:
            raise HTTPException(status_code=404, detail="Sucursal no encontrada")
        if "name" in fields:
            new_name = fields["name"].strip()
            if not new_name:
                raise HTTPException(status_code=400, detail="Nombre requerido")
            fields["name"] = new_name
            dup = await c.fetchval("SELECT 1 FROM sucursales WHERE name = $1 AND id <> $2",
                                   new_name, sucursal_id)
            if dup:
                raise HTTPException(status_code=409, detail="Esa sucursal ya existe")
            old_name = target["name"]
            if new_name != old_name:
                await c.execute("UPDATE users SET sucursal = $1 WHERE sucursal = $2", new_name, old_name)
                await c.execute("UPDATE sales SET sucursal = $1 WHERE sucursal = $2", new_name, old_name)
        sets = []; vals = []
        for i, (k, v) in enumerate(fields.items(), start=1):
            sets.append(f"{k} = ${i}"); vals.append(v)
        vals.append(sucursal_id)
        row = await c.fetchrow(
            f"UPDATE sucursales SET {', '.join(sets)} WHERE id = ${len(vals)} RETURNING *",
            *vals,
        )
    return Sucursal(**dict(row))


@api_router.delete("/sucursales/{sucursal_id}")
async def delete_sucursal(sucursal_id: str):
    async with pool.acquire() as c:
        target = await c.fetchrow("SELECT * FROM sucursales WHERE id = $1", sucursal_id)
        if not target:
            raise HTTPException(status_code=404, detail="Sucursal no encontrada")
        n = await c.fetchval("SELECT COUNT(*) FROM users WHERE sucursal = $1", target["name"])
        if n > 0:
            raise HTTPException(status_code=400,
                                detail=f"No se puede eliminar: hay {n} usuario(s) asignado(s)")
        await c.execute("DELETE FROM sucursales WHERE id = $1", sucursal_id)
    return {"ok": True}


@api_router.get("/users")
async def list_users(include_passwords: bool = False):
    cols = "id, username, role, sucursal, caja_name, active"
    if include_passwords:
        cols += ", password_hash AS password"
    async with pool.acquire() as c:
        rows = await c.fetch(f"SELECT {cols} FROM users ORDER BY role ASC, username ASC LIMIT 500")
    return [dict(r) for r in rows]


@api_router.post("/users")
async def create_user(body: UserCreate):
    if not body.username.strip():
        raise HTTPException(status_code=400, detail="Usuario requerido")
    if not body.password.strip():
        raise HTTPException(status_code=400, detail="Contraseña requerida")
    valid_sucursales = await get_sucursales_names()
    if body.role == "cashier" and (not body.sucursal or body.sucursal not in valid_sucursales):
        raise HTTPException(status_code=400, detail="Sucursal inválida")
    async with pool.acquire() as c:
        ex = await c.fetchval("SELECT 1 FROM users WHERE username = $1", body.username.strip())
        if ex:
            raise HTTPException(status_code=409, detail="El usuario ya existe")
        user = User(username=body.username.strip(), password=body.password, role=body.role,
                    sucursal=body.sucursal, caja_name=(body.caja_name.strip() or "Caja 1"))
        await c.execute(
            """INSERT INTO users (id, username, password_hash, role, sucursal, caja_name, active)
               VALUES ($1, $2, $3, $4, $5, $6, TRUE)""",
            user.id, user.username, user.password, user.role, user.sucursal, user.caja_name,
        )
    safe = user.model_dump(); safe.pop("password", None)
    return safe


@api_router.put("/users/{user_id}")
async def update_user(user_id: str, body: UserUpdate):
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="Sin cambios")
    if "password" in fields:
        fields["password_hash"] = fields.pop("password")
    async with pool.acquire() as c:
        if "username" in fields:
            fields["username"] = fields["username"].strip()
            dup = await c.fetchval(
                "SELECT 1 FROM users WHERE username = $1 AND id <> $2",
                fields["username"], user_id,
            )
            if dup:
                raise HTTPException(status_code=409, detail="El usuario ya existe")
        sets = []; vals = []
        for i, (k, v) in enumerate(fields.items(), start=1):
            sets.append(f"{k} = ${i}"); vals.append(v)
        vals.append(user_id)
        row = await c.fetchrow(
            f"UPDATE users SET {', '.join(sets)} WHERE id = ${len(vals)} "
            f"RETURNING id, username, role, sucursal, caja_name, active",
            *vals,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    return dict(row)


@api_router.delete("/users/{user_id}")
async def delete_user(user_id: str):
    async with pool.acquire() as c:
        target = await c.fetchrow("SELECT * FROM users WHERE id = $1", user_id)
        if not target:
            raise HTTPException(status_code=404, detail="Usuario no encontrado")
        if target["role"] == "admin":
            n = await c.fetchval("SELECT COUNT(*) FROM users WHERE role = 'admin'")
            if n <= 1:
                raise HTTPException(status_code=400, detail="No se puede eliminar el único administrador")
        await c.execute("DELETE FROM users WHERE id = $1", user_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Misc routes
# ---------------------------------------------------------------------------
@api_router.get("/")
async def root():
    return {"message": "Tacos POS API (Postgres)", "status": "ok"}


@api_router.get("/health")
async def health():
    try:
        async with pool.acquire() as c:
            last = await c.fetchval("SELECT MAX(created_at) FROM sales")
        last_iso = last.astimezone(timezone.utc).isoformat() if last else None
        return {"ok": True, "last_sale_at": last_iso}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"DB unavailable: {e}")


@api_router.get("/audit/sales_count")
async def audit_sales_count(date: Optional[str] = None, sucursal: Optional[str] = None,
                            caja: Optional[str] = None):
    start_dt, end_dt = date_range_utc(date)
    where = ["created_at >= $1", "created_at < $2"]
    args: list = [start_dt, end_dt]
    if sucursal and sucursal != "all":
        args.append(sucursal); where.append(f"sucursal = ${len(args)}")
    if caja and caja != "all":
        args.append(caja); where.append(f"caja = ${len(args)}")
    where_sql = " AND ".join(where)
    async with pool.acquire() as c:
        count = await c.fetchval(f"SELECT COUNT(*) FROM sales WHERE {where_sql}", *args)
        grand_total = await c.fetchval(f"SELECT COALESCE(SUM(total), 0) FROM sales WHERE {where_sql}", *args)
        rows = await c.fetch(
            f"""SELECT
                    COALESCE(caja, '—') AS caja,
                    COALESCE(cashier, '—') AS cashier,
                    COUNT(*) AS count,
                    SUM(total) AS total,
                    MIN(created_at) AS first_at,
                    MAX(created_at) AS last_at
                FROM sales WHERE {where_sql}
                GROUP BY 1, 2
                ORDER BY count DESC""",
            *args,
        )
    by_cashier = [{
        "caja": r["caja"], "cashier": r["cashier"], "count": int(r["count"]),
        "total": round(float(r["total"]), 2),
        "first_at": r["first_at"].astimezone(timezone.utc).isoformat() if r["first_at"] else None,
        "last_at": r["last_at"].astimezone(timezone.utc).isoformat() if r["last_at"] else None,
    } for r in rows]
    return {
        "date": date or "today",
        "sucursal": sucursal or "all",
        "caja": caja or "all",
        "sales_count": int(count or 0),
        "grand_total": round(float(grand_total or 0), 2),
        "by_cashier": by_cashier,
    }


# ---------------------------------------------------------------------------
# App wiring
# ---------------------------------------------------------------------------
app.include_router(api_router)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"], allow_headers=["*"],
)


@app.on_event("startup")
async def on_startup():
    global pool
    pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=20,
                                     command_timeout=30, timeout=15)
    # Crear schema si no existe (idempotente)
    schema_path = ROOT_DIR / "schema.sql"
    if schema_path.exists():
        async with pool.acquire() as c:
            await c.execute(schema_path.read_text())
    await seed_if_empty()
    logger.info("Postgres backend ready")


@app.on_event("shutdown")
async def on_shutdown():
    if pool:
        await pool.close()
