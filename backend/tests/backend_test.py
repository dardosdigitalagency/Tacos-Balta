"""Tacos POS Backend tests"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://mobile-checkout-pos.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

EXPECTED_PRODUCTS = [
    "Tacos", "Taco con Queso", "Quesadilla Sencilla", "Quesadilla con Carne",
    "Volcanes", "Tacote", "Orden Grande", "Orden Chica",
    "Agua Grande", "Agua Chica", "Refresco",
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


# ----- Products -----
class TestProducts:
    def test_list_products_default_seed(self, products):
        assert len(products) == 11
        names = [p["name"] for p in products]
        for n in EXPECTED_PRODUCTS:
            assert n in names, f"Missing default product {n}"

    def test_products_sorted_by_sort_order(self, products):
        orders = [p["sort_order"] for p in products]
        assert orders == sorted(orders)
        # Ensure first one is Tacos (sort_order=1)
        assert products[0]["name"] == "Tacos"

    def test_product_no_mongo_id(self, products):
        for p in products:
            assert "_id" not in p
            assert "id" in p

    def test_update_product_price(self, session, products):
        tacos = next(p for p in products if p["name"] == "Tacos")
        original = tacos["price"]
        r = session.put(f"{API}/products/{tacos['id']}", json={"price": 35})
        assert r.status_code == 200
        assert r.json()["price"] == 35
        # Verify via GET
        r2 = session.get(f"{API}/products")
        updated = next(p for p in r2.json() if p["id"] == tacos["id"])
        assert updated["price"] == 35
        # restore
        session.put(f"{API}/products/{tacos['id']}", json={"price": original})

    def test_toggle_active_hides_from_default_list(self, session, products):
        refresco = next(p for p in products if p["name"] == "Refresco")
        r = session.put(f"{API}/products/{refresco['id']}", json={"active": False})
        assert r.status_code == 200
        assert r.json()["active"] is False
        # Should be hidden in default list
        r2 = session.get(f"{API}/products")
        ids = [p["id"] for p in r2.json()]
        assert refresco["id"] not in ids
        # But visible with include_inactive
        r3 = session.get(f"{API}/products?include_inactive=true")
        ids_all = [p["id"] for p in r3.json()]
        assert refresco["id"] in ids_all
        # Restore
        session.put(f"{API}/products/{refresco['id']}", json={"active": True})


# ----- Sales -----
class TestSales:
    def test_create_sale_efectivo_no_tip(self, session, products):
        tacos = next(p for p in products if p["name"] == "Tacos")
        payload = {
            "items": [{"product_id": tacos["id"], "name": tacos["name"], "price": tacos["price"], "quantity": 3}],
            "payment_method": "efectivo",
            "tip": 0,
        }
        r = session.post(f"{API}/sales", json=payload)
        assert r.status_code == 200
        d = r.json()
        assert d["subtotal"] == tacos["price"] * 3
        assert d["tip"] == 0
        assert d["total"] == d["subtotal"]

    def test_create_sale_tarjeta_with_tip(self, session, products):
        ques = next(p for p in products if p["name"] == "Quesadilla Sencilla")
        payload = {
            "items": [{"product_id": ques["id"], "name": ques["name"], "price": ques["price"], "quantity": 2}],
            "payment_method": "tarjeta",
            "tip": 20,
        }
        r = session.post(f"{API}/sales", json=payload)
        assert r.status_code == 200
        d = r.json()
        assert d["subtotal"] == ques["price"] * 2
        assert d["tip"] == 20
        assert d["total"] == d["subtotal"] + 20

    def test_create_sale_efectivo_ignores_forced_tip(self, session, products):
        agua = next(p for p in products if p["name"] == "Agua Chica")
        payload = {
            "items": [{"product_id": agua["id"], "name": agua["name"], "price": agua["price"], "quantity": 1}],
            "payment_method": "efectivo",
            "tip": 50,
        }
        r = session.post(f"{API}/sales", json=payload)
        assert r.status_code == 200
        d = r.json()
        assert d["tip"] == 0, "Backend should ignore tip for efectivo"
        assert d["total"] == d["subtotal"]

    def test_create_sale_transferencia_with_tip(self, session, products):
        vol = next(p for p in products if p["name"] == "Volcanes")
        payload = {
            "items": [{"product_id": vol["id"], "name": vol["name"], "price": vol["price"], "quantity": 1}],
            "payment_method": "transferencia",
            "tip": 15,
        }
        r = session.post(f"{API}/sales", json=payload)
        assert r.status_code == 200
        d = r.json()
        assert d["tip"] == 15
        assert d["total"] == d["subtotal"] + 15

    def test_create_sale_empty_cart_400(self, session):
        r = session.post(f"{API}/sales", json={"items": [], "payment_method": "efectivo", "tip": 0})
        assert r.status_code == 400

    def test_list_sales_today(self, session):
        r = session.get(f"{API}/sales?scope=today")
        assert r.status_code == 200
        assert isinstance(r.json(), list)
        assert len(r.json()) >= 1  # we created at least a few


# ----- Dashboard -----
class TestDashboard:
    def test_dashboard_structure(self, session):
        r = session.get(f"{API}/dashboard")
        assert r.status_code == 200
        d = r.json()
        for k in ("grand_total", "grand_subtotal", "grand_tip", "sales_count", "by_payment", "top_products", "sales_by_hour"):
            assert k in d
        for m in ("efectivo", "transferencia", "tarjeta"):
            assert m in d["by_payment"]
            for sub in ("count", "amount", "tip"):
                assert sub in d["by_payment"][m]
        assert len(d["sales_by_hour"]) == 24
        # top_products sorted by quantity desc
        qtys = [p["quantity"] for p in d["top_products"]]
        assert qtys == sorted(qtys, reverse=True)


# ----- Admin login -----
class TestAdminLogin:
    def test_login_success(self, session):
        r = session.post(f"{API}/admin/login", json={"username": "admin", "password": "taco123"})
        assert r.status_code == 200
        assert r.json().get("ok") is True

    def test_login_invalid(self, session):
        r = session.post(f"{API}/admin/login", json={"username": "admin", "password": "wrong"})
        assert r.status_code == 401
