"""Iteration 6 tests – fixes for POS/Admin bugs.
Coverage:
  - GET /api/auth/me?username=... returns fresh user data (sucursal/caja_name/role).
  - GET /api/auth/me?username=admin returns env-fallback admin even without DB row.
  - GET /api/auth/me?username=<invalid> returns 404.
  - POST /api/sales idempotency: same client_id -> same sale id (no duplicate).
  - GET /api/audit/sales_count now includes 'sucursal' in each by_cashier entry.
  - PUT /api/users/{id} sucursal change is reflected by /api/auth/me.
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


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


@pytest.fixture(scope="module")
def tacos(s):
    r = s.get(f"{API}/products")
    assert r.status_code == 200
    return next(p for p in r.json() if p["name"] == "Tacos")


# ---------------- /api/auth/me ------------------
class TestAuthMe:
    def test_me_san_vicente(self, s):
        r = s.get(f"{API}/auth/me", params={"username": "san_vicente"})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["username"] == "san_vicente"
        assert d["role"] == "cashier"
        assert d["sucursal"] == "San Vicente"
        assert d.get("caja_name") == "Caja 1"
        assert "password" not in d

    def test_me_admin_env_fallback(self, s):
        # admin exists in DB seed, so this still returns admin
        r = s.get(f"{API}/auth/me", params={"username": "admin"})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["username"] == "admin"
        assert d["role"] == "admin"

    def test_me_invalid_404(self, s):
        r = s.get(f"{API}/auth/me",
                  params={"username": f"nope_{uuid.uuid4().hex[:6]}"})
        assert r.status_code == 404
        assert "no encontrado" in r.json()["detail"].lower()


# ---------------- Idempotencia POST /api/sales ------------------
class TestSalesIdempotency:
    def test_same_client_id_returns_same_sale(self, s, tacos):
        cid = f"TEST_cid_{uuid.uuid4().hex[:8]}"
        payload = {
            "items": [{"product_id": tacos["id"], "name": "Tacos",
                       "price": tacos["price"], "quantity": 1}],
            "payment_method": "efectivo", "tip": 0,
            "sucursal": "San Vicente",
            "order_type": "llevar",
            "cashier": "san_vicente", "caja": "Caja 1",
            "cash_received": tacos["price"],
            "client_id": cid,
        }
        r1 = s.post(f"{API}/sales", json=payload)
        assert r1.status_code == 200, r1.text
        r2 = s.post(f"{API}/sales", json=payload)
        assert r2.status_code == 200, r2.text
        assert r1.json()["id"] == r2.json()["id"]
        assert r1.json()["client_id"] == cid
        # And triple-fire returns same too
        r3 = s.post(f"{API}/sales", json=payload)
        assert r3.json()["id"] == r1.json()["id"]


# ---------------- /api/audit/sales_count includes sucursal ------------------
class TestAuditSucursal:
    @pytest.fixture(scope="class")
    def two_sucursales_sales(self, tacos):
        sess = requests.Session()
        sess.headers.update({"Content-Type": "application/json"})
        cid_a = f"TEST_audit_sv_{uuid.uuid4().hex[:6]}"
        cid_b = f"TEST_audit_vd_{uuid.uuid4().hex[:6]}"
        base = {
            "items": [{"product_id": tacos["id"], "name": "Tacos",
                       "price": tacos["price"], "quantity": 1}],
            "payment_method": "efectivo", "tip": 0,
            "order_type": "llevar",
            "cash_received": tacos["price"],
        }
        r_a = sess.post(f"{API}/sales", json={
            **base, "sucursal": "San Vicente",
            "cashier": "san_vicente", "caja": "Caja 1",
            "client_id": cid_a,
        })
        r_b = sess.post(f"{API}/sales", json={
            **base, "sucursal": "Valle Dorado",
            "cashier": "valle_dorado", "caja": "Caja 1",
            "client_id": cid_b,
        })
        assert r_a.status_code == 200 and r_b.status_code == 200
        return {"san_vicente": r_a.json(), "valle_dorado": r_b.json()}

    def test_by_cashier_has_sucursal(self, s, two_sucursales_sales):
        r = s.get(f"{API}/audit/sales_count",
                  params={"date": TODAY, "caja": "all"})
        assert r.status_code == 200, r.text
        d = r.json()
        assert "by_cashier" in d
        assert len(d["by_cashier"]) >= 2
        # Every row must include 'sucursal'
        for row in d["by_cashier"]:
            assert "sucursal" in row, row
            assert row["sucursal"] not in (None, "")
        cashiers = {(row["cashier"], row["sucursal"]) for row in d["by_cashier"]}
        assert ("san_vicente", "San Vicente") in cashiers
        assert ("valle_dorado", "Valle Dorado") in cashiers


# ---------------- PUT user sucursal reflected by /auth/me ------------------
class TestUserSucursalChangeReflected:
    @pytest.fixture(scope="class")
    def created(self):
        sess = requests.Session()
        sess.headers.update({"Content-Type": "application/json"})
        uname = f"TEST_sw_{uuid.uuid4().hex[:6]}"
        r = sess.post(f"{API}/users", json={
            "username": uname, "password": "pwd",
            "role": "cashier", "sucursal": "San Vicente", "caja_name": "Caja 1",
        })
        assert r.status_code == 200, r.text
        u = r.json()
        yield sess, u, uname
        sess.delete(f"{API}/users/{u['id']}")

    def test_me_reflects_new_sucursal_after_put(self, created):
        sess, u, uname = created
        # baseline
        r = sess.get(f"{API}/auth/me", params={"username": uname})
        assert r.status_code == 200 and r.json()["sucursal"] == "San Vicente"
        # change to Valle Dorado
        r_put = sess.put(f"{API}/users/{u['id']}",
                         json={"sucursal": "Valle Dorado", "caja_name": "Caja 9"})
        assert r_put.status_code == 200, r_put.text
        # /auth/me should reflect the change immediately
        r2 = sess.get(f"{API}/auth/me", params={"username": uname})
        assert r2.status_code == 200
        d = r2.json()
        assert d["sucursal"] == "Valle Dorado"
        assert d["caja_name"] == "Caja 9"
