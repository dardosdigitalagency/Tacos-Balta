"""Tacos POS Backend tests – Iteration 2.
Covers: sucursales, auth/login, sales w/sucursal+cashier+tip rules,
sales filtering by date/sucursal, dashboard w/tip_breakdown+by_sucursal,
users list (no password) and PUT users (password + sucursal updates).
"""
import os
import uuid
from datetime import datetime, timezone, timedelta

import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

MX_TZ = timezone(timedelta(hours=-6))
TODAY = datetime.now(MX_TZ).strftime("%Y-%m-%d")

EXPECTED_SUCURSALES = ["Valle Dorado", "Mezcalitos", "San Vicente", "3.14", "San Jose"]

CASHIERS = [
    ("valle_dorado", "valle123", "Valle Dorado"),
    ("mezcalitos", "mezca123", "Mezcalitos"),
    ("san_vicente", "vicente123", "San Vicente"),
    ("pi", "pi123", "3.14"),
    ("san_jose", "jose123", "San Jose"),
]


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def products(session):
    r = session.get(f"{API}/products")
    assert r.status_code == 200
    return r.json()


# ---------- Sucursales ----------
class TestSucursales:
    def test_list_sucursales(self, session):
        r = session.get(f"{API}/sucursales")
        assert r.status_code == 200
        assert r.json()["sucursales"] == EXPECTED_SUCURSALES


# ---------- Auth ----------
class TestAuth:
    def test_login_admin(self, session):
        r = session.post(f"{API}/auth/login", json={"username": "admin", "password": "taco123"})
        assert r.status_code == 200
        d = r.json()
        assert d["ok"] is True
        assert d["user"]["role"] == "admin"
        assert d["user"]["sucursal"] in (None, "")
        assert "password" not in d["user"]

    def test_login_cashier_valle(self, session):
        r = session.post(f"{API}/auth/login", json={"username": "valle_dorado", "password": "valle123"})
        assert r.status_code == 200
        u = r.json()["user"]
        assert u["role"] == "cashier"
        assert u["sucursal"] == "Valle Dorado"

    @pytest.mark.parametrize("username,password,sucursal", CASHIERS)
    def test_login_all_cashiers(self, session, username, password, sucursal):
        r = session.post(f"{API}/auth/login", json={"username": username, "password": password})
        assert r.status_code == 200, f"Login failed for {username}"
        u = r.json()["user"]
        assert u["role"] == "cashier"
        assert u["sucursal"] == sucursal

    def test_login_invalid(self, session):
        r = session.post(f"{API}/auth/login", json={"username": "admin", "password": "wrong"})
        assert r.status_code == 401


# ---------- Sales validation ----------
class TestSalesValidation:
    def test_missing_sucursal_422(self, session, products):
        tacos = next(p for p in products if p["name"] == "Tacos")
        r = session.post(f"{API}/sales", json={
            "items": [{"product_id": tacos["id"], "name": "Tacos", "price": 30, "quantity": 1}],
            "payment_method": "efectivo", "tip": 0,
        })
        assert r.status_code == 422

    def test_invalid_sucursal_400(self, session, products):
        tacos = next(p for p in products if p["name"] == "Tacos")
        r = session.post(f"{API}/sales", json={
            "items": [{"product_id": tacos["id"], "name": "Tacos", "price": 30, "quantity": 1}],
            "payment_method": "efectivo", "tip": 0, "sucursal": "XYZ",
        })
        assert r.status_code == 400


# ---------- Sales create + dashboard ----------
class TestSalesAndDashboard:
    @pytest.fixture(scope="class")
    def created_sale(self, session, products):
        tacos = next(p for p in products if p["name"] == "Tacos")
        payload = {
            "items": [{"product_id": tacos["id"], "name": tacos["name"], "price": tacos["price"], "quantity": 2}],
            "payment_method": "tarjeta",
            "tip": 30,
            "sucursal": "Mezcalitos",
            "cashier": "mezcalitos",
        }
        r = session.post(f"{API}/sales", json=payload)
        assert r.status_code == 200, r.text
        return r.json()

    def test_sale_returns_sucursal_and_cashier(self, created_sale):
        assert created_sale["sucursal"] == "Mezcalitos"
        assert created_sale["cashier"] == "mezcalitos"
        assert created_sale["subtotal"] == 60
        assert created_sale["tip"] == 30
        assert created_sale["total"] == 90

    def test_list_sales_filter_by_date_and_sucursal(self, session, created_sale):
        r = session.get(f"{API}/sales", params={"scope": "date", "date": TODAY, "sucursal": "Mezcalitos"})
        assert r.status_code == 200
        sales = r.json()
        assert len(sales) >= 1
        for s in sales:
            assert s["sucursal"] == "Mezcalitos"
        assert any(s["id"] == created_sale["id"] for s in sales)

    def test_list_sales_other_sucursal_excludes(self, session, created_sale):
        r = session.get(f"{API}/sales", params={"scope": "date", "date": TODAY, "sucursal": "Valle Dorado"})
        assert r.status_code == 200
        sales = r.json()
        assert all(s["sucursal"] == "Valle Dorado" for s in sales)
        assert all(s["id"] != created_sale["id"] for s in sales)

    def test_dashboard_filters_and_breakdown(self, session, created_sale):
        r = session.get(f"{API}/dashboard", params={"sucursal": "Mezcalitos", "date": TODAY})
        assert r.status_code == 200
        d = r.json()
        assert d["sucursal"] == "Mezcalitos"
        assert "tip_breakdown" in d
        assert "tarjeta" in d["tip_breakdown"] and "transferencia" in d["tip_breakdown"]
        assert d["tip_breakdown"]["tarjeta"] >= 30
        assert "by_sucursal" in d
        # by_sucursal must contain all sucursales keys
        for s in EXPECTED_SUCURSALES:
            assert s in d["by_sucursal"]


# ---------- Users ----------
class TestUsers:
    def test_list_users_no_password(self, session):
        r = session.get(f"{API}/users")
        assert r.status_code == 200
        users = r.json()
        assert len(users) >= 6
        for u in users:
            assert "password" not in u
            assert "_id" not in u

    def test_update_password_and_relogin(self, session):
        # Find pi user
        users = session.get(f"{API}/users").json()
        pi = next(u for u in users if u["username"] == "pi")
        new_pwd = f"pi-{uuid.uuid4().hex[:6]}"
        r = session.put(f"{API}/users/{pi['id']}", json={"password": new_pwd})
        assert r.status_code == 200
        assert "password" not in r.json()
        # Login with new password
        r2 = session.post(f"{API}/auth/login", json={"username": "pi", "password": new_pwd})
        assert r2.status_code == 200
        # Old password fails
        r3 = session.post(f"{API}/auth/login", json={"username": "pi", "password": "pi123"})
        assert r3.status_code == 401
        # Restore for idempotency
        session.put(f"{API}/users/{pi['id']}", json={"password": "pi123"})

    def test_update_sucursal(self, session):
        users = session.get(f"{API}/users").json()
        sj = next(u for u in users if u["username"] == "san_jose")
        original = sj["sucursal"]
        r = session.put(f"{API}/users/{sj['id']}", json={"sucursal": "Valle Dorado"})
        assert r.status_code == 200
        # Verify via list
        users2 = session.get(f"{API}/users").json()
        sj2 = next(u for u in users2 if u["username"] == "san_jose")
        assert sj2["sucursal"] == "Valle Dorado"
        # Restore
        session.put(f"{API}/users/{sj['id']}", json={"sucursal": original})
