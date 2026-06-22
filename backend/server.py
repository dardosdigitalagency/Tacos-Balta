"""
Tacos POS – Backend
FastAPI + MongoDB
Endpoints:
  - /api/products            CRUD productos (precios editables)
  - /api/sales               Crear y listar ventas
  - /api/dashboard           Estadísticas del día
  - /api/admin/login         Verificación simple de admin
"""
from fastapi import FastAPI, APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import io
import csv
import calendar
import logging
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional, Literal
import uuid
from datetime import datetime, timezone, timedelta

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

ADMIN_USERNAME = os.environ.get('ADMIN_USERNAME', 'admin')
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'taco123')

# Mexico City timezone (UTC-6, no DST since 2022)
MX_TZ = timezone(timedelta(hours=-6))

app = FastAPI(title="Tacos POS API")
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------------
# Models
# ----------------------------------------------------------------------------
class Product(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    price: float
    sort_order: int = 0
    active: bool = True
    category: str = "comida"   # "comida" | "bebida"
    pricing_mode: str = "fixed"  # "fixed" | "variable" (precio se ingresa al cobrar)


class ProductUpdate(BaseModel):
    name: Optional[str] = None
    price: Optional[float] = None
    sort_order: Optional[int] = None
    active: Optional[bool] = None
    category: Optional[str] = None
    pricing_mode: Optional[str] = None


class ProductCreate(BaseModel):
    name: str
    price: float = 0
    sort_order: int = 999
    category: str = "comida"
    pricing_mode: str = "fixed"


class CartItem(BaseModel):
    product_id: str
    name: str
    price: float            # price unitario al momento de la venta
    quantity: int


class Payment(BaseModel):
    """Una porción del pago. Una venta puede tener varias (pago dividido)."""
    method: Literal['efectivo', 'transferencia', 'tarjeta']
    amount: float           # monto sobre el subtotal de items
    tip: float = 0.0
    cash_received: Optional[float] = None
    change_given: Optional[float] = None


class SaleCreate(BaseModel):
    items: List[CartItem]
    payment_method: Literal['efectivo', 'transferencia', 'tarjeta', 'mixto']
    tip: float = 0.0
    sucursal: str
    cashier: Optional[str] = None
    caja: Optional[str] = None
    order_type: Literal['mesa', 'llevar', 'domicilio']
    mesa_number: Optional[str] = None
    cash_received: Optional[float] = None
    payments: Optional[List[Payment]] = None
    iva: float = 0.0
    invoice_requested: bool = False
    delivery_fee: float = 0.0
    client_id: Optional[str] = None   # idempotency key del cliente


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


class User(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    username: str
    password: str
    role: Literal['admin', 'cashier'] = 'cashier'
    sucursal: Optional[str] = None
    caja_name: str = "Caja 1"
    active: bool = True


class UserCreate(BaseModel):
    username: str
    password: str
    role: Literal['admin', 'cashier'] = 'cashier'
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


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
def date_range_utc(date_str: Optional[str] = None):
    """Devuelve (start_utc_iso, end_utc_iso) para el día indicado en MX TZ.
    Si date_str es None devuelve el día de hoy MX. date_str en formato YYYY-MM-DD."""
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
    return start_mx.astimezone(timezone.utc).isoformat(), end_mx.astimezone(timezone.utc).isoformat()


def today_mx_range_utc():
    return date_range_utc(None)


def period_range_utc(period: str, date_str: Optional[str] = None,
                     start_date: Optional[str] = None, end_date: Optional[str] = None):
    """Devuelve (start_utc_iso, end_utc_iso, start_mx_date, end_mx_date_inclusive)."""
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
        return (
            start_mx.astimezone(timezone.utc).isoformat(),
            end_mx.astimezone(timezone.utc).isoformat(),
            start_mx, end_base,
        )

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

    return (
        start_mx.astimezone(timezone.utc).isoformat(),
        end_mx.astimezone(timezone.utc).isoformat(),
        start_mx,
        end_mx - timedelta(days=1),
    )


SUCURSALES_DEFAULT = ["Valle Dorado", "Mezcalitos", "San Vicente", "3.14", "San Jose"]


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


async def get_sucursales_names() -> List[str]:
    docs = await db.sucursales.find({}, {"_id": 0}).sort("sort_order", 1).to_list(100)
    return [d["name"] for d in docs]


async def seed_sucursales_if_empty():
    count = await db.sucursales.count_documents({})
    if count == 0:
        docs = [Sucursal(name=n, sort_order=i + 1).model_dump()
                for i, n in enumerate(SUCURSALES_DEFAULT)]
        await db.sucursales.insert_many(docs)
        logger.info("Seeded %d default sucursales", len(docs))


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


async def seed_products_if_empty():
    count = await db.products.count_documents({})
    if count == 0:
        docs = [Product(**p).model_dump() for p in DEFAULT_PRODUCTS]
        await db.products.insert_many(docs)
        logger.info("Seeded %d default products", len(docs))
    # Migration: ensure all products have a category
    await db.products.update_many(
        {"category": {"$exists": False}},
        [{"$set": {"category": {
            "$cond": [
                {"$in": ["$name", ["Agua Grande", "Agua Chica", "Refresco"]]},
                "bebida", "comida"
            ]}}}],
    )


async def seed_users_if_empty():
    count = await db.users.count_documents({})
    if count == 0:
        docs = [User(**u).model_dump() for u in DEFAULT_USERS]
        await db.users.insert_many(docs)
        logger.info("Seeded %d default users", len(docs))
    # Migration: ensure all users have caja_name
    await db.users.update_many(
        {"caja_name": {"$exists": False}},
        {"$set": {"caja_name": "Caja 1"}},
    )


# ----------------------------------------------------------------------------
# Routes – Products
# ----------------------------------------------------------------------------
@api_router.get("/products", response_model=List[Product])
async def list_products(include_inactive: bool = False):
    q = {} if include_inactive else {"active": True}
    cursor = db.products.find(q, {"_id": 0}).sort("sort_order", 1)
    docs = await cursor.to_list(500)
    return docs


@api_router.post("/products", response_model=Product)
async def create_product(body: ProductCreate):
    prod = Product(**body.model_dump())
    await db.products.insert_one(prod.model_dump())
    return prod


@api_router.put("/products/{product_id}", response_model=Product)
async def update_product(product_id: str, body: ProductUpdate):
    update_fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not update_fields:
        raise HTTPException(status_code=400, detail="No fields to update")
    res = await db.products.find_one_and_update(
        {"id": product_id},
        {"$set": update_fields},
        return_document=True,
        projection={"_id": 0},
    )
    if not res:
        raise HTTPException(status_code=404, detail="Product not found")
    return Product(**res)


@api_router.post("/products/reorder")
async def reorder_products(body: dict):
    """Recibe {ids: [id1, id2, ...]} y asigna sort_order según el orden recibido."""
    ids = body.get("ids", [])
    if not isinstance(ids, list) or not ids:
        raise HTTPException(status_code=400, detail="ids requeridos")
    for idx, pid in enumerate(ids):
        await db.products.update_one({"id": pid}, {"$set": {"sort_order": idx + 1}})
    return {"ok": True, "count": len(ids)}


@api_router.delete("/products/{product_id}")
async def delete_product(product_id: str):
    res = await db.products.delete_one({"id": product_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Product not found")
    return {"ok": True}


# ----------------------------------------------------------------------------
# Routes – Sales
# ----------------------------------------------------------------------------
@api_router.post("/sales", response_model=Sale)
async def create_sale(body: SaleCreate):
    if not body.items:
        raise HTTPException(status_code=400, detail="Empty cart")
    # Idempotencia: si ya existe una venta con este client_id, devolvemos esa misma
    # (evita duplicados por reintentos del cliente cuando hay red intermitente).
    if body.client_id:
        existing = await db.sales.find_one({"client_id": body.client_id}, {"_id": 0})
        if existing:
            return Sale(**existing)
    valid_sucursales = await get_sucursales_names()
    if body.sucursal not in valid_sucursales:
        raise HTTPException(status_code=400, detail="Sucursal inválida")
    if body.order_type == "mesa" and not (body.mesa_number and str(body.mesa_number).strip()):
        raise HTTPException(status_code=400, detail="Número de mesa requerido")

    subtotal = round(sum(i.price * i.quantity for i in body.items), 2)
    iva = round(float(body.iva or 0), 2) if body.invoice_requested else 0.0
    delivery_fee = round(float(body.delivery_fee or 0), 2) if body.order_type == "domicilio" else 0.0

    # Pago dividido (mixto) vs pago único
    if body.payment_method == "mixto":
        if not body.payments or len(body.payments) < 2:
            raise HTTPException(status_code=400, detail="Pago mixto requiere al menos 2 partes")
        # Solo se acepta propina en partes tarjeta/transferencia
        tip = round(sum(p.tip for p in body.payments if p.method in ("tarjeta", "transferencia")), 2)
        total = round(subtotal + tip + iva + delivery_fee, 2)
        sum_amount = round(sum(p.amount for p in body.payments), 2)
        if abs(sum_amount - total) > 0.02:
            raise HTTPException(
                status_code=400,
                detail=f"Las partes ({sum_amount}) deben sumar el total ({total})",
            )
        processed_payments = []
        cash_total_received = 0.0
        change_total = 0.0
        for p in body.payments:
            cr = None
            cg = None
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
        # IVA solo si tarjeta involucrada y factura solicitada
        if body.payment_method != "tarjeta":
            iva = 0.0
        total = round(subtotal + tip + iva + delivery_fee, 2)
        cash_received = None
        change_given = None
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
    doc = sale.model_dump()
    doc["items"] = [i.model_dump() for i in sale.items]
    doc["payments"] = [p.model_dump() for p in (sale.payments or [])]
    try:
        await db.sales.insert_one(doc)
    except Exception as e:
        # Posible duplicado por carrera entre reintentos del mismo client_id
        if body.client_id:
            existing = await db.sales.find_one({"client_id": body.client_id}, {"_id": 0})
            if existing:
                return Sale(**existing)
        raise HTTPException(status_code=500, detail=f"No se pudo guardar la venta: {e}")
    return sale


@api_router.get("/sales", response_model=List[Sale])
async def list_sales(
    scope: Literal['today', 'all', 'date'] = 'today',
    date: Optional[str] = None,
    sucursal: Optional[str] = None,
    caja: Optional[str] = None,
):
    q: dict = {}
    if scope == 'today':
        start_iso, end_iso = today_mx_range_utc()
        q["created_at"] = {"$gte": start_iso, "$lt": end_iso}
    elif scope == 'date' and date:
        start_iso, end_iso = date_range_utc(date)
        q["created_at"] = {"$gte": start_iso, "$lt": end_iso}
    if sucursal and sucursal != "all":
        q["sucursal"] = sucursal
    if caja and caja != "all":
        q["caja"] = caja
    cursor = db.sales.find(q, {"_id": 0}).sort("created_at", -1)
    docs = await cursor.to_list(5000)
    # backfill missing fields for legacy docs
    for d in docs:
        d.setdefault("sucursal", "—")
        d.setdefault("cashier", None)
        d.setdefault("caja", None)
        d.setdefault("order_type", "mesa")
        d.setdefault("mesa_number", None)
        d.setdefault("cash_received", None)
        d.setdefault("change_given", None)
        d.setdefault("iva", 0)
        d.setdefault("delivery_fee", 0)
        d.setdefault("invoice_requested", False)
    return docs


# ----------------------------------------------------------------------------
# Routes – Dashboard
# ----------------------------------------------------------------------------
@api_router.get("/dashboard")
async def dashboard(
    date: Optional[str] = None,
    sucursal: Optional[str] = None,
    caja: Optional[str] = None,
):
    """Stats del día (o fecha indicada) en MX TZ. Filtros: sucursal, caja."""
    start_iso, end_iso = date_range_utc(date)
    q: dict = {"created_at": {"$gte": start_iso, "$lt": end_iso}}
    if sucursal and sucursal != "all":
        q["sucursal"] = sucursal
    if caja and caja != "all":
        q["caja"] = caja
    sales = await db.sales.find(q, {"_id": 0}).to_list(10000)

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
    grand_total = 0.0
    grand_subtotal = 0.0
    grand_tip = 0.0
    grand_iva = 0.0
    grand_delivery = 0.0
    invoice_count = 0
    total_items = 0
    tip_breakdown = {"tarjeta": 0.0, "transferencia": 0.0}
    by_sucursal: dict = {s: {"count": 0, "total": 0.0} for s in (await get_sucursales_names())}
    by_caja: dict = {}  # {caja_name: {count, total}}

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

        # Si la venta tiene desglose de pagos (mixto o single), úsalo
        if payments:
            tarjeta_in_payments = any(p.get("method") == "tarjeta" for p in payments)
            for p in payments:
                m = p.get("method")
                pa = float(p.get("amount", 0))
                pt = float(p.get("tip", 0))
                if m in totals:
                    totals[m]["count"] += 1
                    totals[m]["amount"] += pa
                    totals[m]["tip"] += pt
                if m in tip_breakdown:
                    tip_breakdown[m] += pt
            # IVA siempre va a tarjeta (única condición donde aplica)
            if tarjeta_in_payments and sale_iva > 0:
                totals["tarjeta"]["iva"] += sale_iva
        else:
            # Legacy: usa payment_method único
            if pm in totals:
                totals[pm]["count"] += 1
                totals[pm]["amount"] += sub
                totals[pm]["tip"] += tip
                if pm == "tarjeta" and sale_iva > 0:
                    totals[pm]["iva"] += sale_iva
            if pm in tip_breakdown:
                tip_breakdown[pm] += tip

        if ot in by_order_type:
            by_order_type[ot]["count"] += 1
            by_order_type[ot]["total"] += tot
            by_order_type[ot]["delivery"] += sale_delivery

        grand_subtotal += sub
        grand_tip += tip
        grand_total += tot
        grand_iva += sale_iva
        grand_delivery += sale_delivery
        if s.get("invoice_requested"):
            invoice_count += 1

        suc = s.get("sucursal", "—")
        if suc in by_sucursal:
            by_sucursal[suc]["count"] += 1
            by_sucursal[suc]["total"] += tot

        if ck not in by_caja:
            by_caja[ck] = {"count": 0, "total": 0.0}
        by_caja[ck]["count"] += 1
        by_caja[ck]["total"] += tot

        for it in s.get("items", []):
            n = it.get("name", "?")
            qty = int(it.get("quantity", 0))
            price = float(it.get("price", 0))
            products_count[n] = products_count.get(n, 0) + qty
            products_amount[n] = products_amount.get(n, 0.0) + price * qty
            total_items += qty

        try:
            dt_utc = datetime.fromisoformat(s["created_at"])
            dt_mx = dt_utc.astimezone(MX_TZ)
            hourly[dt_mx.hour] += tot
        except Exception:
            pass

    top_products = sorted(
        [{"name": k, "quantity": v, "revenue": round(products_amount.get(k, 0), 2)}
         for k, v in products_count.items()],
        key=lambda x: x["quantity"], reverse=True
    )
    sales_by_hour = [
        {"hour": f"{h:02d}:00", "total": round(hourly[h], 2)}
        for h in range(24)
    ]
    peak_hour = None
    if any(v > 0 for v in hourly.values()):
        peak = max(hourly.items(), key=lambda x: x[1])
        peak_hour = {"hour": f"{peak[0]:02d}:00", "total": round(peak[1], 2)}

    sales_count = len(sales)
    avg_ticket = round(grand_total / sales_count, 2) if sales_count else 0
    avg_items = round(total_items / sales_count, 2) if sales_count else 0

    return {
        "date": (date or datetime.now(MX_TZ).strftime("%Y-%m-%d")),
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
        "by_payment": {k: {"count": v["count"],
                           "amount": round(v["amount"], 2),
                           "tip": round(v["tip"], 2),
                           "iva": round(v["iva"], 2)} for k, v in totals.items()},
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


# ----------------------------------------------------------------------------
# Routes – Dashboard de periodo (semana/mes)
# ----------------------------------------------------------------------------
DAY_NAMES_ES = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"]


async def _aggregate_period(period: str, date: Optional[str], sucursal: Optional[str], caja: Optional[str],
                            start_date: Optional[str] = None, end_date: Optional[str] = None):
    start_iso, end_iso, start_mx, end_mx = period_range_utc(period, date, start_date, end_date)
    q: dict = {"created_at": {"$gte": start_iso, "$lt": end_iso}}
    if sucursal and sucursal != "all":
        q["sucursal"] = sucursal
    if caja and caja != "all":
        q["caja"] = caja
    sales = await db.sales.find(q, {"_id": 0}).to_list(50000)
    return sales, start_mx, end_mx


@api_router.get("/dashboard/period")
async def dashboard_period(
    period: Literal['week', 'month', 'custom'] = 'week',
    date: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    sucursal: Optional[str] = None,
    caja: Optional[str] = None,
):
    """Stats agregadas en una semana, mes o rango personalizado."""
    sales, start_mx, end_mx = await _aggregate_period(period, date, sucursal, caja, start_date, end_date)

    # Estructuras de agregación
    by_day: dict = {}              # YYYY-MM-DD -> {count, total}
    by_day_of_week: dict = {i: {"count": 0, "total": 0.0} for i in range(7)}
    by_day_hour: dict = {}         # (yyyy-mm-dd, hour) -> total
    by_hour: dict = {h: 0.0 for h in range(24)}
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
    grand_total = 0.0
    grand_subtotal = 0.0
    grand_tip = 0.0
    grand_iva = 0.0
    grand_delivery = 0.0
    invoice_count = 0
    total_items = 0

    for s in sales:
        sub = float(s.get("subtotal", 0))
        tip = float(s.get("tip", 0))
        tot = float(s.get("total", sub + tip))
        pm = s.get("payment_method", "efectivo")
        ot = s.get("order_type", "mesa")

        try:
            dt_utc = datetime.fromisoformat(s["created_at"])
            dt_mx = dt_utc.astimezone(MX_TZ)
        except Exception:
            continue

        day_key = dt_mx.strftime("%Y-%m-%d")
        hour = dt_mx.hour
        dow = dt_mx.weekday()

        by_day.setdefault(day_key, {"count": 0, "total": 0.0})
        by_day[day_key]["count"] += 1
        by_day[day_key]["total"] += tot

        by_day_of_week[dow]["count"] += 1
        by_day_of_week[dow]["total"] += tot

        dh_key = (day_key, hour)
        by_day_hour[dh_key] = by_day_hour.get(dh_key, 0.0) + tot
        by_hour[hour] += tot

        if pm in totals:
            totals[pm]["count"] += 1
            totals[pm]["amount"] += sub
            totals[pm]["tip"] += tip
        # Si hay split, sobreescribimos con desglose preciso
        payments = s.get("payments") or []
        if payments:
            # restar lo del payment_method "mixto" no aplica; aquí re-acumulamos correctamente
            if pm == "mixto":
                # quitar la cuenta global ya sumada en pm in totals (no estaba), nada que revertir
                pass
            else:
                # restar el conteo legacy (lo agregamos arriba)
                totals[pm]["count"] -= 1
                totals[pm]["amount"] -= sub
                totals[pm]["tip"] -= tip
            for p in payments:
                m = p.get("method")
                pa = float(p.get("amount", 0))
                pt = float(p.get("tip", 0))
                if m in totals:
                    totals[m]["count"] += 1
                    totals[m]["amount"] += pa
                    totals[m]["tip"] += pt
        if ot in by_order_type:
            by_order_type[ot]["count"] += 1
            by_order_type[ot]["total"] += tot
        suc = s.get("sucursal", "—")
        if suc in by_sucursal:
            by_sucursal[suc]["count"] += 1
            by_sucursal[suc]["total"] += tot
        ck = s.get("caja") or "—"
        by_caja.setdefault(ck, {"count": 0, "total": 0.0})
        by_caja[ck]["count"] += 1
        by_caja[ck]["total"] += tot

        for it in s.get("items", []):
            n = it.get("name", "?")
            qty = int(it.get("quantity", 0))
            price = float(it.get("price", 0))
            products_count[n] = products_count.get(n, 0) + qty
            products_amount[n] = products_amount.get(n, 0.0) + price * qty
            total_items += qty

        grand_subtotal += sub
        grand_tip += tip
        grand_total += tot
        grand_iva += float(s.get("iva", 0) or 0)
        grand_delivery += float(s.get("delivery_fee", 0) or 0)
        if s.get("invoice_requested"):
            invoice_count += 1

    # Construir serie de días (incluyendo días sin ventas)
    days_list = []
    cur = start_mx
    while cur.date() <= end_mx.date():
        key = cur.strftime("%Y-%m-%d")
        d = by_day.get(key, {"count": 0, "total": 0.0})
        days_list.append({
            "date": key,
            "label": cur.strftime("%d %b"),
            "count": d["count"],
            "total": round(d["total"], 2),
        })
        cur += timedelta(days=1)

    # Mejor día / peor día
    best_day = None
    if days_list:
        bd = max(days_list, key=lambda x: x["total"])
        if bd["total"] > 0:
            best_day = bd

    # Mejor combinación día+hora
    best_day_hour = None
    if by_day_hour:
        (dh_date, dh_hour), dh_total = max(by_day_hour.items(), key=lambda x: x[1])
        if dh_total > 0:
            best_day_hour = {
                "date": dh_date, "hour": f"{dh_hour:02d}:00",
                "total": round(dh_total, 2),
            }

    # Día de la semana más fuerte
    best_dow = None
    if any(v["total"] > 0 for v in by_day_of_week.values()):
        idx, val = max(by_day_of_week.items(), key=lambda x: x[1]["total"])
        best_dow = {"name": DAY_NAMES_ES[idx], "total": round(val["total"], 2),
                    "count": val["count"]}

    sales_count = len(sales)
    avg_ticket = round(grand_total / sales_count, 2) if sales_count else 0
    avg_items = round(total_items / sales_count, 2) if sales_count else 0
    days_with_sales = sum(1 for d in days_list if d["count"] > 0)
    avg_daily = round(grand_total / days_with_sales, 2) if days_with_sales else 0

    top_products = sorted(
        [{"name": k, "quantity": v, "revenue": round(products_amount.get(k, 0), 2)}
         for k, v in products_count.items()],
        key=lambda x: x["quantity"], reverse=True
    )

    return {
        "period": period,
        "start": start_mx.strftime("%Y-%m-%d"),
        "end": end_mx.strftime("%Y-%m-%d"),
        "sucursal": sucursal or "all",
        "caja": caja or "all",
        "grand_total": round(grand_total, 2),
        "grand_subtotal": round(grand_subtotal, 2),
        "grand_tip": round(grand_tip, 2),
        "grand_iva": round(grand_iva, 2),
        "grand_delivery": round(grand_delivery, 2),
        "invoice_count": invoice_count,
        "sales_count": sales_count,
        "total_items": total_items,
        "avg_ticket": avg_ticket,
        "avg_items": avg_items,
        "avg_daily": avg_daily,
        "days_with_sales": days_with_sales,
        "best_day": best_day,
        "best_day_hour": best_day_hour,
        "best_dow": best_dow,
        "by_day": days_list,
        "by_day_of_week": [
            {"name": DAY_NAMES_ES[i], "count": v["count"], "total": round(v["total"], 2)}
            for i, v in by_day_of_week.items()
        ],
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


# ----------------------------------------------------------------------------
# Routes – Reporte CSV
# ----------------------------------------------------------------------------
@api_router.get("/reports/csv")
async def report_csv(
    period: Literal['week', 'month', 'custom'] = 'week',
    date: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    sucursal: Optional[str] = None,
    caja: Optional[str] = None,
):
    """CSV con KPIs por día y por sucursal en el periodo indicado."""
    start_iso, end_iso, start_mx, end_mx = period_range_utc(period, date, start_date, end_date)
    q: dict = {"created_at": {"$gte": start_iso, "$lt": end_iso}}
    if sucursal and sucursal != "all":
        q["sucursal"] = sucursal
    if caja and caja != "all":
        q["caja"] = caja
    sales = await db.sales.find(q, {"_id": 0}).to_list(50000)

    # agrupar por (date, sucursal)
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
            "mesa_n": 0, "llevar_n": 0, "domicilio_n": 0,
            "items": 0,
        })
        sub = float(s.get("subtotal", 0))
        tip = float(s.get("tip", 0))
        tot = float(s.get("total", sub + tip))
        pm = s.get("payment_method", "efectivo")
        ot = s.get("order_type", "mesa")
        payments = s.get("payments") or []
        b["count"] += 1
        b["total"] += tot
        b["subtotal"] += sub
        b["tip"] += tip
        b["iva"] += float(s.get("iva", 0) or 0)
        b["delivery"] += float(s.get("delivery_fee", 0) or 0)
        if s.get("invoice_requested"):
            b["invoices"] += 1
        # Desglose por método de pago: si hay split, usa esos amounts
        if payments:
            for p in payments:
                m = p.get("method", "efectivo")
                pa = float(p.get("amount", 0))
                pt = float(p.get("tip", 0))
                if m in ("efectivo", "transferencia", "tarjeta"):
                    b[m] += pa
                if m == "tarjeta":
                    b["tip_tarjeta"] += pt
                if m == "transferencia":
                    b["tip_transferencia"] += pt
        else:
            if pm in ("efectivo", "transferencia", "tarjeta"):
                b[pm] += sub
            if pm == "tarjeta":
                b["tip_tarjeta"] += tip
            if pm == "transferencia":
                b["tip_transferencia"] += tip
        if ot in ("mesa", "llevar", "domicilio"):
            b[ot] += tot
            b[f"{ot}_n"] += 1
        for it in s.get("items", []):
            b["items"] += int(it.get("quantity", 0))

    # generar CSV
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([
        "Fecha", "Sucursal", "Ventas", "Total", "Subtotal", "Propinas",
        "IVA", "Envío", "Facturas (#)",
        "Ticket promedio", "Items vendidos",
        "Efectivo", "Transferencia", "Tarjeta",
        "Propina tarjeta", "Propina transferencia",
        "Mesa (total)", "Mesa (#)", "Llevar (total)", "Llevar (#)",
        "Domicilio (total)", "Domicilio (#)",
    ])

    cur = start_mx
    suc_filter = sucursal if sucursal and sucursal != "all" else None
    sucursal_list = (await get_sucursales_names()) if not suc_filter else [suc_filter]

    while cur.date() <= end_mx.date():
        date_key = cur.strftime("%Y-%m-%d")
        for suc in sucursal_list:
            b = buckets.get((date_key, suc))
            if not b:
                continue
            avg = (b["total"] / b["count"]) if b["count"] else 0
            w.writerow([
                date_key, suc, b["count"],
                f"{b['total']:.2f}", f"{b['subtotal']:.2f}", f"{b['tip']:.2f}",
                f"{b['iva']:.2f}", f"{b['delivery']:.2f}", b["invoices"],
                f"{avg:.2f}", b["items"],
                f"{b['efectivo']:.2f}", f"{b['transferencia']:.2f}", f"{b['tarjeta']:.2f}",
                f"{b['tip_tarjeta']:.2f}", f"{b['tip_transferencia']:.2f}",
                f"{b['mesa']:.2f}", b["mesa_n"],
                f"{b['llevar']:.2f}", b["llevar_n"],
                f"{b['domicilio']:.2f}", b["domicilio_n"],
            ])
        cur += timedelta(days=1)

    # totales
    if buckets:
        tot_total = sum(b["total"] for b in buckets.values())
        tot_count = sum(b["count"] for b in buckets.values())
        tot_avg = (tot_total / tot_count) if tot_count else 0
        w.writerow([])
        w.writerow([
            "TOTAL", f"{len(sucursal_list)} sucursales" if len(sucursal_list) > 1 else sucursal_list[0],
            tot_count, f"{tot_total:.2f}",
            f"{sum(b['subtotal'] for b in buckets.values()):.2f}",
            f"{sum(b['tip'] for b in buckets.values()):.2f}",
            f"{sum(b['iva'] for b in buckets.values()):.2f}",
            f"{sum(b['delivery'] for b in buckets.values()):.2f}",
            sum(b["invoices"] for b in buckets.values()),
            f"{tot_avg:.2f}",
            sum(b["items"] for b in buckets.values()),
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
            sum(b["domicilio_n"] for b in buckets.values()),
        ])

    buf.seek(0)
    filename = f"reporte_{period}_{start_mx.strftime('%Y%m%d')}_{end_mx.strftime('%Y%m%d')}.csv"
    # BOM para Excel UTF-8
    content = "\ufeff" + buf.getvalue()
    return StreamingResponse(
        iter([content]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ----------------------------------------------------------------------------
# Routes – Auth (login) y administración de usuarios
# ----------------------------------------------------------------------------
@api_router.post("/auth/login")
async def login(body: LoginRequest):
    user = await db.users.find_one(
        {"username": body.username, "password": body.password, "active": True},
        {"_id": 0, "password": 0},
    )
    if not user:
        # fallback to env admin for safety (en caso de DB vacía)
        if body.username == ADMIN_USERNAME and body.password == ADMIN_PASSWORD:
            return {"ok": True, "token": f"session-{ADMIN_USERNAME}",
                    "user": {"username": ADMIN_USERNAME, "role": "admin", "sucursal": None}}
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Credenciales inválidas")
    return {"ok": True, "token": f"session-{user['username']}", "user": user}


# Backwards-compatible admin login (acepta solo admins)
@api_router.post("/admin/login")
async def admin_login(body: LoginRequest):
    res = await login(body)
    if res["user"]["role"] != "admin":
        raise HTTPException(status_code=403, detail="Solo administradores")
    return res


@api_router.get("/sucursales")
async def list_sucursales():
    docs = await db.sucursales.find({}, {"_id": 0}).sort("sort_order", 1).to_list(200)
    return {"sucursales": [d["name"] for d in docs], "items": docs}


@api_router.post("/sucursales", response_model=Sucursal)
async def create_sucursal(body: SucursalCreate):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nombre requerido")
    existing = await db.sucursales.find_one({"name": name})
    if existing:
        raise HTTPException(status_code=409, detail="Esa sucursal ya existe")
    max_order = await db.sucursales.find({}, {"_id": 0, "sort_order": 1}).sort("sort_order", -1).limit(1).to_list(1)
    next_order = (max_order[0]["sort_order"] if max_order else 0) + 1
    suc = Sucursal(name=name, sort_order=next_order)
    await db.sucursales.insert_one(suc.model_dump())
    return suc


@api_router.put("/sucursales/{sucursal_id}", response_model=Sucursal)
async def update_sucursal(sucursal_id: str, body: SucursalUpdate):
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="Sin cambios")
    target = await db.sucursales.find_one({"id": sucursal_id})
    if not target:
        raise HTTPException(status_code=404, detail="Sucursal no encontrada")
    if "name" in fields:
        new_name = fields["name"].strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="Nombre requerido")
        fields["name"] = new_name
        dup = await db.sucursales.find_one({"name": new_name, "id": {"$ne": sucursal_id}})
        if dup:
            raise HTTPException(status_code=409, detail="Esa sucursal ya existe")
        old_name = target["name"]
        # Propagar cambio a usuarios y ventas existentes
        if new_name != old_name:
            await db.users.update_many({"sucursal": old_name}, {"$set": {"sucursal": new_name}})
            await db.sales.update_many({"sucursal": old_name}, {"$set": {"sucursal": new_name}})
    res = await db.sucursales.find_one_and_update(
        {"id": sucursal_id}, {"$set": fields},
        projection={"_id": 0}, return_document=True,
    )
    return Sucursal(**res)


@api_router.delete("/sucursales/{sucursal_id}")
async def delete_sucursal(sucursal_id: str):
    target = await db.sucursales.find_one({"id": sucursal_id})
    if not target:
        raise HTTPException(status_code=404, detail="Sucursal no encontrada")
    # Bloquear si hay usuarios asignados
    users_count = await db.users.count_documents({"sucursal": target["name"]})
    if users_count > 0:
        raise HTTPException(
            status_code=400,
            detail=f"No se puede eliminar: hay {users_count} usuario(s) asignado(s)",
        )
    await db.sucursales.delete_one({"id": sucursal_id})
    return {"ok": True}


@api_router.get("/users")
async def list_users(include_passwords: bool = False):
    projection = {"_id": 0} if include_passwords else {"_id": 0, "password": 0}
    users = await db.users.find({}, projection).sort("role", 1).to_list(500)
    return users


@api_router.post("/users")
async def create_user(body: UserCreate):
    if not body.username.strip():
        raise HTTPException(status_code=400, detail="Usuario requerido")
    if not body.password.strip():
        raise HTTPException(status_code=400, detail="Contraseña requerida")
    valid_sucursales = await get_sucursales_names()
    if body.role == "cashier" and (not body.sucursal or body.sucursal not in valid_sucursales):
        raise HTTPException(status_code=400, detail="Sucursal inválida")
    existing = await db.users.find_one({"username": body.username.strip()})
    if existing:
        raise HTTPException(status_code=409, detail="El usuario ya existe")
    user = User(
        username=body.username.strip(),
        password=body.password,
        role=body.role,
        sucursal=body.sucursal,
        caja_name=body.caja_name.strip() or "Caja 1",
    )
    await db.users.insert_one(user.model_dump())
    safe = user.model_dump()
    safe.pop("password", None)
    return safe


@api_router.put("/users/{user_id}")
async def update_user(user_id: str, body: UserUpdate):
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="Sin cambios")
    # Validar que no se duplique el username
    if "username" in fields:
        fields["username"] = fields["username"].strip()
        existing = await db.users.find_one(
            {"username": fields["username"], "id": {"$ne": user_id}}
        )
        if existing:
            raise HTTPException(status_code=409, detail="El usuario ya existe")
    res = await db.users.find_one_and_update(
        {"id": user_id}, {"$set": fields},
        projection={"_id": 0, "password": 0}, return_document=True,
    )
    if not res:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    return dict(res)


@api_router.delete("/users/{user_id}")
async def delete_user(user_id: str):
    # Evitar borrar al único admin
    target = await db.users.find_one({"id": user_id})
    if not target:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    if target.get("role") == "admin":
        admin_count = await db.users.count_documents({"role": "admin"})
        if admin_count <= 1:
            raise HTTPException(status_code=400, detail="No se puede eliminar el único administrador")
    await db.users.delete_one({"id": user_id})
    return {"ok": True}


@api_router.get("/")
async def root():
    return {"message": "Tacos POS API", "status": "ok"}


# ----------------------------------------------------------------------------
# App wiring
# ----------------------------------------------------------------------------
app.include_router(api_router)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def on_startup():
    await seed_sucursales_if_empty()
    await seed_products_if_empty()
    await seed_users_if_empty()
    # Índice único parcial para idempotencia de ventas (ignora docs sin client_id)
    try:
        await db.sales.create_index(
            "client_id", unique=True,
            partialFilterExpression={"client_id": {"$type": "string"}},
        )
    except Exception as e:
        print(f"[startup] WARN no se pudo crear índice client_id: {e}")


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
