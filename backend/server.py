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


class ProductUpdate(BaseModel):
    name: Optional[str] = None
    price: Optional[float] = None
    sort_order: Optional[int] = None
    active: Optional[bool] = None


class ProductCreate(BaseModel):
    name: str
    price: float
    sort_order: int = 999


class CartItem(BaseModel):
    product_id: str
    name: str
    price: float            # price unitario al momento de la venta
    quantity: int


class SaleCreate(BaseModel):
    items: List[CartItem]
    payment_method: Literal['efectivo', 'transferencia', 'tarjeta']
    tip: float = 0.0


class Sale(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    items: List[CartItem]
    subtotal: float          # suma items (sin propina, sin IVA)
    tip: float = 0.0
    total: float             # subtotal + tip
    payment_method: str
    created_at: str          # ISO string (UTC)


class LoginRequest(BaseModel):
    username: str
    password: str


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
def today_mx_range_utc():
    """Devuelve (start_utc_iso, end_utc_iso) para el día actual en Mexico City."""
    now_mx = datetime.now(MX_TZ)
    start_mx = now_mx.replace(hour=0, minute=0, second=0, microsecond=0)
    end_mx = start_mx + timedelta(days=1)
    return start_mx.astimezone(timezone.utc).isoformat(), end_mx.astimezone(timezone.utc).isoformat()


DEFAULT_PRODUCTS = [
    {"name": "Tacos",                "price": 30,  "sort_order": 1},
    {"name": "Taco con Queso",       "price": 40,  "sort_order": 2},
    {"name": "Quesadilla Sencilla",  "price": 60,  "sort_order": 3},
    {"name": "Quesadilla con Carne", "price": 90,  "sort_order": 4},
    {"name": "Volcanes",             "price": 40,  "sort_order": 5},
    {"name": "Tacote",               "price": 70,  "sort_order": 6},
    {"name": "Orden Grande",         "price": 160, "sort_order": 7},
    {"name": "Orden Chica",          "price": 120, "sort_order": 8},
    {"name": "Agua Grande",          "price": 40,  "sort_order": 9},
    {"name": "Agua Chica",           "price": 30,  "sort_order": 10},
    {"name": "Refresco",             "price": 30,  "sort_order": 11},
]


async def seed_products_if_empty():
    count = await db.products.count_documents({})
    if count == 0:
        docs = [Product(**p).model_dump() for p in DEFAULT_PRODUCTS]
        await db.products.insert_many(docs)
        logger.info("Seeded %d default products", len(docs))


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
    return res


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
    subtotal = sum(i.price * i.quantity for i in body.items)
    tip = body.tip if body.payment_method in ("tarjeta", "transferencia") else 0.0
    total = subtotal + tip
    sale = Sale(
        items=body.items,
        subtotal=round(subtotal, 2),
        tip=round(tip, 2),
        total=round(total, 2),
        payment_method=body.payment_method,
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    doc = sale.model_dump()
    # items stored as list of dicts
    doc["items"] = [i.model_dump() for i in sale.items]
    await db.sales.insert_one(doc)
    return sale


@api_router.get("/sales", response_model=List[Sale])
async def list_sales(scope: Literal['today', 'all'] = 'today'):
    q = {}
    if scope == 'today':
        start_iso, end_iso = today_mx_range_utc()
        q = {"created_at": {"$gte": start_iso, "$lt": end_iso}}
    cursor = db.sales.find(q, {"_id": 0}).sort("created_at", -1)
    docs = await cursor.to_list(2000)
    return docs


# ----------------------------------------------------------------------------
# Routes – Dashboard
# ----------------------------------------------------------------------------
@api_router.get("/dashboard")
async def dashboard():
    """Devuelve stats del día (Mexico City TZ)."""
    start_iso, end_iso = today_mx_range_utc()
    q = {"created_at": {"$gte": start_iso, "$lt": end_iso}}
    sales = await db.sales.find(q, {"_id": 0}).to_list(5000)

    totals = {
        "efectivo":      {"count": 0, "amount": 0.0, "tip": 0.0},
        "transferencia": {"count": 0, "amount": 0.0, "tip": 0.0},
        "tarjeta":       {"count": 0, "amount": 0.0, "tip": 0.0},
    }
    products_count = {}     # name -> quantity
    products_amount = {}    # name -> revenue (precio * qty)
    hourly = {h: 0.0 for h in range(24)}  # ventas totales por hora (incluye propina)
    grand_total = 0.0
    grand_subtotal = 0.0
    grand_tip = 0.0

    for s in sales:
        pm = s.get("payment_method", "efectivo")
        sub = float(s.get("subtotal", 0))
        tip = float(s.get("tip", 0))
        tot = float(s.get("total", sub + tip))
        if pm in totals:
            totals[pm]["count"] += 1
            totals[pm]["amount"] += sub   # monto sin propina por método
            totals[pm]["tip"] += tip
        grand_subtotal += sub
        grand_tip += tip
        grand_total += tot

        for it in s.get("items", []):
            n = it.get("name", "?")
            qty = int(it.get("quantity", 0))
            price = float(it.get("price", 0))
            products_count[n] = products_count.get(n, 0) + qty
            products_amount[n] = products_amount.get(n, 0.0) + price * qty

        # hora local MX
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

    return {
        "grand_total": round(grand_total, 2),
        "grand_subtotal": round(grand_subtotal, 2),
        "grand_tip": round(grand_tip, 2),
        "sales_count": len(sales),
        "by_payment": {k: {"count": v["count"],
                           "amount": round(v["amount"], 2),
                           "tip": round(v["tip"], 2)} for k, v in totals.items()},
        "top_products": top_products,
        "sales_by_hour": sales_by_hour,
    }


# ----------------------------------------------------------------------------
# Routes – Admin auth (simple)
# ----------------------------------------------------------------------------
@api_router.post("/admin/login")
async def admin_login(body: LoginRequest):
    if body.username == ADMIN_USERNAME and body.password == ADMIN_PASSWORD:
        return {"ok": True, "token": "admin-session"}
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                        detail="Credenciales inválidas")


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


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
