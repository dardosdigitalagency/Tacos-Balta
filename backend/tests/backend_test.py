"""Tacos POS Backend tests – Iteration 3.
Covers (new features):
  - Users CRUD: POST/PUT/DELETE /api/users with caja_name, login of created user.
  - Sales: order_type required, mesa_number rules, cash_received/change_given.
  - Dashboard: new fields (avg_ticket, avg_items, peak_hour, total_items,
    by_caja, by_order_type, tip_breakdown) and caja filter.
Plus regression of iter 2 critical paths: sucursales list and admin login.
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


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def products(session):
    r = session.get(f"{API}/products")
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def tacos(products):
    return next(p for p in products if p["name"] == "Tacos")


# ---------------------- Regression: sucursales + admin login --------------
class TestRegression:
    def test_sucursales(self, session):
        r = session.get(f"{API}/sucursales")
        assert r.status_code == 200
        assert r.json()["sucursales"] == EXPECTED_SUCURSALES

    def test_login_admin(self, session):
        r = session.post(f"{API}/auth/login",
                         json={"username": "admin", "password": "taco123"})
        assert r.status_code == 200
        d = r.json()
        assert d["user"]["role"] == "admin"
        assert "password" not in d["user"]


# ---------------------- Users CRUD ----------------------------------------
class TestUsersCRUD:
    """POST/PUT/DELETE /api/users with caja_name and validations."""

    @pytest.fixture(scope="class")
    def created_username(self):
        return f"TEST_caja_{uuid.uuid4().hex[:6]}"

    @pytest.fixture(scope="class")
    def created_user(self, session, created_username):
        payload = {
            "username": created_username,
            "password": "pwd-orig",
            "role": "cashier",
            "sucursal": "Valle Dorado",
            "caja_name": "Caja 2",
        }
        r = session.post(f"{API}/users", json=payload)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["username"] == created_username
        assert body["caja_name"] == "Caja 2"
        assert body["sucursal"] == "Valle Dorado"
        assert "password" not in body
        return body

    def test_created_user_can_login(self, session, created_user, created_username):
        r = session.post(f"{API}/auth/login",
                         json={"username": created_username, "password": "pwd-orig"})
        assert r.status_code == 200, r.text
        u = r.json()["user"]
        assert u["sucursal"] == "Valle Dorado"
        assert u.get("caja_name") == "Caja 2"

    def test_duplicate_username_409(self, session, created_username):
        r = session.post(f"{API}/users", json={
            "username": created_username, "password": "x",
            "role": "cashier", "sucursal": "Valle Dorado", "caja_name": "Caja 3",
        })
        assert r.status_code == 409, r.text

    def test_cashier_without_sucursal_400(self, session):
        r = session.post(f"{API}/users", json={
            "username": f"TEST_nosuc_{uuid.uuid4().hex[:5]}",
            "password": "x", "role": "cashier", "caja_name": "Caja 1",
        })
        assert r.status_code == 400, r.text

    def test_update_user_full(self, session, created_user, created_username):
        new_name = f"TEST_upd_{uuid.uuid4().hex[:5]}"
        r = session.put(f"{API}/users/{created_user['id']}", json={
            "username": new_name,
            "password": "pwd-new",
            "sucursal": "Mezcalitos",
            "caja_name": "Caja 9",
        })
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["username"] == new_name
        assert d["sucursal"] == "Mezcalitos"
        assert d["caja_name"] == "Caja 9"
        assert "password" not in d
        # Login with NEW username and NEW password works
        r2 = session.post(f"{API}/auth/login",
                          json={"username": new_name, "password": "pwd-new"})
        assert r2.status_code == 200
        # Old credentials fail
        r3 = session.post(f"{API}/auth/login",
                          json={"username": created_username, "password": "pwd-orig"})
        assert r3.status_code == 401

    def test_delete_user(self, session, created_user):
        r = session.delete(f"{API}/users/{created_user['id']}")
        assert r.status_code == 200, r.text
        # cannot login anymore
        users = session.get(f"{API}/users").json()
        assert all(u["id"] != created_user["id"] for u in users)

    def test_cannot_delete_unique_admin(self, session):
        users = session.get(f"{API}/users").json()
        admins = [u for u in users if u["role"] == "admin"]
        # Assumes exactly one admin (default seed)
        if len(admins) != 1:
            pytest.skip("More than one admin – cannot validate unique-admin rule deterministically")
        r = session.delete(f"{API}/users/{admins[0]['id']}")
        assert r.status_code == 400, r.text


# ---------------------- Sales: order_type / mesa / cash --------------------
class TestSalesOrderType:
    def test_missing_order_type_422(self, session, tacos):
        r = session.post(f"{API}/sales", json={
            "items": [{"product_id": tacos["id"], "name": "Tacos", "price": 30, "quantity": 1}],
            "payment_method": "efectivo", "tip": 0, "sucursal": "Valle Dorado",
        })
        assert r.status_code == 422, r.text

    def test_mesa_without_mesa_number_400(self, session, tacos):
        r = session.post(f"{API}/sales", json={
            "items": [{"product_id": tacos["id"], "name": "Tacos", "price": 30, "quantity": 1}],
            "payment_method": "efectivo", "tip": 0, "sucursal": "Valle Dorado",
            "order_type": "mesa",
        })
        assert r.status_code == 400
        assert "mesa" in r.json()["detail"].lower()

    @pytest.mark.parametrize("ot", ["llevar", "domicilio"])
    def test_llevar_domicilio_no_mesa_ok(self, session, tacos, ot):
        r = session.post(f"{API}/sales", json={
            "items": [{"product_id": tacos["id"], "name": "Tacos",
                       "price": tacos["price"], "quantity": 1}],
            "payment_method": "efectivo", "tip": 0,
            "sucursal": "Valle Dorado",
            "cash_received": tacos["price"],
            "order_type": ot,
            "cashier": "valle_dorado",
            "caja": "Caja 1",
        })
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["order_type"] == ot
        assert d["mesa_number"] in (None, "")

    def test_efectivo_change_given(self, session, tacos):
        r = session.post(f"{API}/sales", json={
            "items": [{"product_id": tacos["id"], "name": "Tacos",
                       "price": tacos["price"], "quantity": 2}],
            "payment_method": "efectivo", "tip": 0,
            "sucursal": "Valle Dorado",
            "order_type": "mesa", "mesa_number": "5",
            "cash_received": 100,
            "cashier": "valle_dorado", "caja": "Caja 1",
        })
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["total"] == 60
        assert d["cash_received"] == 100
        assert d["change_given"] == 40

    def test_efectivo_insufficient_400(self, session, tacos):
        r = session.post(f"{API}/sales", json={
            "items": [{"product_id": tacos["id"], "name": "Tacos",
                       "price": tacos["price"], "quantity": 2}],
            "payment_method": "efectivo", "tip": 0,
            "sucursal": "Valle Dorado",
            "order_type": "mesa", "mesa_number": "5",
            "cash_received": 30,
            "cashier": "valle_dorado", "caja": "Caja 1",
        })
        assert r.status_code == 400


# ---------------------- Dashboard: new fields + caja filter ----------------
class TestDashboard:
    @pytest.fixture(scope="class", autouse=True)
    def seed_sale_caja2(self, session, tacos):
        # Create a sale at Valle Dorado, Caja 2, llevar so dashboard has data
        r = session.post(f"{API}/sales", json={
            "items": [{"product_id": tacos["id"], "name": "Tacos",
                       "price": tacos["price"], "quantity": 3}],
            "payment_method": "tarjeta", "tip": 15,
            "sucursal": "Valle Dorado",
            "order_type": "llevar",
            "cashier": "valle_caja2", "caja": "Caja 2",
        })
        assert r.status_code == 200, r.text
        return r.json()

    def test_dashboard_has_new_fields(self, session):
        r = session.get(f"{API}/dashboard", params={"date": TODAY})
        assert r.status_code == 200
        d = r.json()
        for key in ("avg_ticket", "avg_items", "peak_hour", "total_items",
                    "by_caja", "by_order_type", "tip_breakdown"):
            assert key in d, f"missing {key}"
        # by_order_type keys present
        for ot in ("mesa", "llevar", "domicilio"):
            assert ot in d["by_order_type"]
        # tip_breakdown keys
        assert "tarjeta" in d["tip_breakdown"]
        assert "transferencia" in d["tip_breakdown"]
        # peak hour structure
        assert d["peak_hour"] is None or {"hour", "total"} <= set(d["peak_hour"].keys())
        # total_items > 0 since we just seeded
        assert d["total_items"] >= 3
        # by_caja has Caja 2 entry
        assert "Caja 2" in d["by_caja"]

    def test_dashboard_caja_filter(self, session):
        r = session.get(f"{API}/dashboard",
                        params={"date": TODAY, "sucursal": "Valle Dorado", "caja": "Caja 2"})
        assert r.status_code == 200
        d = r.json()
        assert d["sucursal"] == "Valle Dorado"
        assert d["caja"] == "Caja 2"
        # All counted sales should be Caja 2 only -> by_caja has only Caja 2
        # (could be empty if seeding race, but expect at least 1)
        assert d["sales_count"] >= 1
        assert "Caja 2" in d["by_caja"]
        # Other caja names not in by_caja (filter applied)
        assert all(k == "Caja 2" for k in d["by_caja"].keys())
