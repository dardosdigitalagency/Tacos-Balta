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
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
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


class ProductUpdate(BaseModel):
    name: Optional[str] = None
    price: Optional[float] = None
    sort_order: Optional[int] = None
    active: Optional[bool] = None
    category: Optional[str] = None


class ProductCreate(BaseModel):
    name: str
    price: float
    sort_order: int = 999
    category: str = "comida"


class CartItem(BaseModel):
    product_id: str
    name: str
    price: float            # price unitario al momento de la venta
    quantity: int


class SaleCreate(BaseModel):
    items: List[CartItem]
    payment_method: Literal['efectivo', 'transferencia', 'tarjeta']
    tip: float = 0.0
    sucursal: str
    cashier: Optional[str] = None
    caja: Optional[str] = None
    order_type: Literal['mesa', 'llevar', 'domicilio']
    mesa_number: Optional[str] = None
    cash_received: Optional[float] = None


class Sale(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    items: List[CartItem]
    subtotal: float
    tip: float = 0.0
    total: float
    payment_method: str
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


SUCURSALES = ["Valle Dorado", "Mezcalitos", "San Vicente", "3.14", "San Jose"]

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
    if body.sucursal not in SUCURSALES:
        raise HTTPException(status_code=400, detail="Sucursal inválida")
    if body.order_type == "mesa" and not (body.mesa_number and str(body.mesa_number).strip()):
        raise HTTPException(status_code=400, detail="Número de mesa requerido")

    subtotal = sum(i.price * i.quantity for i in body.items)
    tip = body.tip if body.payment_method in ("tarjeta", "transferencia") else 0.0
    total = subtotal + tip

    # Cálculo de cambio para efectivo
    change_given = None
    cash_received = None
    if body.payment_method == "efectivo" and body.cash_received is not None:
        cash_received = float(body.cash_received)
        if cash_received < total:
            raise HTTPException(status_code=400, detail="Dinero recibido menor al total")
        change_given = round(cash_received - total, 2)

    sale = Sale(
        items=body.items,
        subtotal=round(subtotal, 2),
        tip=round(tip, 2),
        total=round(total, 2),
        payment_method=body.payment_method,
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
    await db.sales.insert_one(doc)
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
        "efectivo":      {"count": 0, "amount": 0.0, "tip": 0.0},
        "transferencia": {"count": 0, "amount": 0.0, "tip": 0.0},
        "tarjeta":       {"count": 0, "amount": 0.0, "tip": 0.0},
    }
    by_order_type = {
        "mesa":      {"count": 0, "total": 0.0},
        "llevar":    {"count": 0, "total": 0.0},
        "domicilio": {"count": 0, "total": 0.0},
    }
    products_count: dict = {}
    products_amount: dict = {}
    hourly = {h: 0.0 for h in range(24)}
    grand_total = 0.0
    grand_subtotal = 0.0
    grand_tip = 0.0
    total_items = 0
    tip_breakdown = {"tarjeta": 0.0, "transferencia": 0.0}
    by_sucursal: dict = {s: {"count": 0, "total": 0.0} for s in SUCURSALES}
    by_caja: dict = {}  # {caja_name: {count, total}}

    for s in sales:
        pm = s.get("payment_method", "efectivo")
        sub = float(s.get("subtotal", 0))
        tip = float(s.get("tip", 0))
        tot = float(s.get("total", sub + tip))
        ot = s.get("order_type", "mesa")
        ck = s.get("caja") or "—"

        if pm in totals:
            totals[pm]["count"] += 1
            totals[pm]["amount"] += sub
            totals[pm]["tip"] += tip
        if pm in tip_breakdown:
            tip_breakdown[pm] += tip
        if ot in by_order_type:
            by_order_type[ot]["count"] += 1
            by_order_type[ot]["total"] += tot

        grand_subtotal += sub
        grand_tip += tip
        grand_total += tot

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
        "sales_count": sales_count,
        "avg_ticket": avg_ticket,
        "avg_items": avg_items,
        "peak_hour": peak_hour,
        "total_items": total_items,
        "by_payment": {k: {"count": v["count"],
                           "amount": round(v["amount"], 2),
                           "tip": round(v["tip"], 2)} for k, v in totals.items()},
        "tip_breakdown": {k: round(v, 2) for k, v in tip_breakdown.items()},
        "by_sucursal": {k: {"count": v["count"], "total": round(v["total"], 2)}
                        for k, v in by_sucursal.items()},
        "by_caja": {k: {"count": v["count"], "total": round(v["total"], 2)}
                    for k, v in by_caja.items()},
        "by_order_type": {k: {"count": v["count"], "total": round(v["total"], 2)}
                          for k, v in by_order_type.items()},
        "top_products": top_products,
        "sales_by_hour": sales_by_hour,
    }


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
    return {"sucursales": SUCURSALES}


@api_router.get("/users")
async def list_users():
    users = await db.users.find({}, {"_id": 0, "password": 0}).sort("role", 1).to_list(200)
    return users


@api_router.post("/users")
async def create_user(body: UserCreate):
    if not body.username.strip():
        raise HTTPException(status_code=400, detail="Usuario requerido")
    if not body.password.strip():
        raise HTTPException(status_code=400, detail="Contraseña requerida")
    if body.role == "cashier" and (not body.sucursal or body.sucursal not in SUCURSALES):
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
    await seed_products_if_empty()
    await seed_users_if_empty()


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
