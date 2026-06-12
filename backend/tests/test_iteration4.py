"""Tacos POS Backend tests – Iteration 4.
Covers:
  - GET /api/users?include_passwords=true returns password field; default omits it.
  - GET /api/sucursales returns {sucursales, items}.
  - POST/PUT/DELETE /api/sucursales: create, duplicate=409, rename propagates,
    delete blocked if users assigned.
  - GET /api/dashboard/period?period=week|month: required fields, sucursal filter.
  - GET /api/reports/csv: BOM, header columns, daily rows, TOTAL row,
    Content-Disposition filename.
  - Login regression with original cashier usernames.
"""
import os
import csv
import io
import calendar
from datetime import datetime, timezone, timedelta

import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

MX_TZ = timezone(timedelta(hours=-6))
NOW_MX = datetime.now(MX_TZ)
TODAY = NOW_MX.strftime("%Y-%m-%d")

EXPECTED_SUCURSALES = ["Valle Dorado", "Mezcalitos", "San Vicente", "3.14", "San Jose"]
ORIGINAL_LOGINS = [
    ("valle_dorado", "valle123"),
    ("mezcalitos", "mezca123"),
    ("san_vicente", "vicente123"),
    ("pi", "pi123"),
    ("san_jose", "jose123"),
]


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


# -------------------- Original logins regression -----------------------------
class TestLoginsRestored:
    @pytest.mark.parametrize("u,p", ORIGINAL_LOGINS)
    def test_cashier_login_ok(self, s, u, p):
        r = s.post(f"{API}/auth/login", json={"username": u, "password": p})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["user"]["username"] == u
        assert d["user"]["role"] == "cashier"
        assert "password" not in d["user"]


# -------------------- /api/users?include_passwords ---------------------------
class TestUsersIncludePasswords:
    def test_default_no_password(self, s):
        r = s.get(f"{API}/users")
        assert r.status_code == 200
        users = r.json()
        assert isinstance(users, list) and len(users) > 0
        assert all("password" not in u for u in users), \
            "Default GET /api/users must NOT expose password"

    def test_include_passwords_true(self, s):
        r = s.get(f"{API}/users", params={"include_passwords": "true"})
        assert r.status_code == 200
        users = r.json()
        # All seeded users have plaintext passwords
        admin = next(u for u in users if u["username"] == "admin")
        assert admin.get("password") == "taco123"
        valle = next(u for u in users if u["username"] == "valle_dorado")
        assert valle.get("password") == "valle123"


# -------------------- /api/sucursales list -----------------------------------
class TestSucursalesList:
    def test_list_shape(self, s):
        r = s.get(f"{API}/sucursales")
        assert r.status_code == 200
        d = r.json()
        assert "sucursales" in d and "items" in d
        assert d["sucursales"] == EXPECTED_SUCURSALES
        assert all({"id", "name", "sort_order"} <= set(it.keys()) for it in d["items"])


# -------------------- Sucursales CRUD ----------------------------------------
@pytest.fixture
def temp_sucursal(s):
    """Create a TEST sucursal, yield its dict, and cleanup at end."""
    name = "TEST_Centro_X"
    r = s.post(f"{API}/sucursales", json={"name": name})
    assert r.status_code == 200, r.text
    suc = r.json()
    yield suc
    # Cleanup: try delete (only works if no users)
    s.delete(f"{API}/sucursales/{suc['id']}")


class TestSucursalesCRUD:
    def test_create_and_appears(self, s):
        name = "TEST_Centro_Create"
        # ensure clean state
        cur = s.get(f"{API}/sucursales").json()["items"]
        for it in cur:
            if it["name"] == name:
                s.delete(f"{API}/sucursales/{it['id']}")
        r = s.post(f"{API}/sucursales", json={"name": name})
        assert r.status_code == 200, r.text
        suc = r.json()
        assert suc["name"] == name and "id" in suc
        names = s.get(f"{API}/sucursales").json()["sucursales"]
        assert name in names
        # duplicate -> 409
        r2 = s.post(f"{API}/sucursales", json={"name": name})
        assert r2.status_code == 409
        # cleanup
        s.delete(f"{API}/sucursales/{suc['id']}")

    def test_rename_propagates(self, s, temp_sucursal):
        # Create a user assigned to this sucursal
        u = {
            "username": "TEST_renameuser",
            "password": "x123",
            "role": "cashier",
            "sucursal": temp_sucursal["name"],
            "caja_name": "Caja 1",
        }
        # cleanup possible leftover
        existing = s.get(f"{API}/users").json()
        for ex in existing:
            if ex["username"] == u["username"]:
                s.delete(f"{API}/users/{ex['id']}")
        ru = s.post(f"{API}/users", json=u)
        assert ru.status_code == 200, ru.text
        user_id = ru.json()["id"]

        # Also create a sale on this sucursal
        prods = s.get(f"{API}/products").json()
        tacos = next(p for p in prods if p["name"] == "Tacos")
        sale = {
            "items": [{"product_id": tacos["id"], "name": tacos["name"],
                       "price": tacos["price"], "quantity": 1}],
            "payment_method": "efectivo",
            "sucursal": temp_sucursal["name"],
            "cashier": "TEST_renameuser",
            "caja": "Caja 1",
            "order_type": "llevar",
        }
        rs = s.post(f"{API}/sales", json=sale)
        assert rs.status_code == 200, rs.text
        sale_id = rs.json()["id"]

        # Rename
        new_name = temp_sucursal["name"] + "_RENAMED"
        rp = s.put(f"{API}/sucursales/{temp_sucursal['id']}",
                   json={"name": new_name})
        assert rp.status_code == 200, rp.text
        assert rp.json()["name"] == new_name

        # Verify user updated
        users = s.get(f"{API}/users").json()
        renamed_user = next(x for x in users if x["id"] == user_id)
        assert renamed_user["sucursal"] == new_name

        # Verify sale updated (use scope='all' fallback: get today's range explicitly)
        sales_today = s.get(f"{API}/sales", params={"scope": "today",
                                                   "sucursal": new_name}).json()
        assert any(x["id"] == sale_id for x in sales_today), \
            "Sale should be findable under new sucursal name"

        # Cleanup: delete user then sucursal
        s.delete(f"{API}/users/{user_id}")
        # Sale will remain but we don't have a delete endpoint; that's ok.
        # Update temp_sucursal fixture name so its cleanup uses new id (same id).

    def test_delete_blocked_with_users(self, s, temp_sucursal):
        u = {
            "username": "TEST_blockuser",
            "password": "x",
            "role": "cashier",
            "sucursal": temp_sucursal["name"],
            "caja_name": "Caja 1",
        }
        existing = s.get(f"{API}/users").json()
        for ex in existing:
            if ex["username"] == u["username"]:
                s.delete(f"{API}/users/{ex['id']}")
        ru = s.post(f"{API}/users", json=u)
        assert ru.status_code == 200
        user_id = ru.json()["id"]

        rd = s.delete(f"{API}/sucursales/{temp_sucursal['id']}")
        assert rd.status_code == 400
        assert "No se puede eliminar" in rd.json().get("detail", "")

        # remove user, then delete should succeed
        s.delete(f"{API}/users/{user_id}")
        rd2 = s.delete(f"{API}/sucursales/{temp_sucursal['id']}")
        assert rd2.status_code == 200


# -------------------- Dashboard /period --------------------------------------
PERIOD_FIELDS = {
    "period", "start", "end", "grand_total", "avg_daily", "avg_ticket",
    "days_with_sales", "best_day", "best_day_hour", "best_dow",
    "by_day", "by_day_of_week", "by_hour", "by_payment",
    "by_order_type", "by_sucursal", "by_caja", "top_products",
}


class TestDashboardPeriod:
    def test_week_shape(self, s):
        r = s.get(f"{API}/dashboard/period", params={"period": "week"})
        assert r.status_code == 200, r.text
        d = r.json()
        missing = PERIOD_FIELDS - set(d.keys())
        assert not missing, f"Missing fields: {missing}"
        assert d["period"] == "week"
        assert len(d["by_day"]) == 7, f"week must have 7 days, got {len(d['by_day'])}"
        assert len(d["by_day_of_week"]) == 7
        assert len(d["by_hour"]) == 24
        # by_sucursal includes all 5 default sucursales
        for suc in EXPECTED_SUCURSALES:
            assert suc in d["by_sucursal"]

    def test_month_shape(self, s):
        r = s.get(f"{API}/dashboard/period", params={"period": "month"})
        assert r.status_code == 200
        d = r.json()
        last_day = calendar.monthrange(NOW_MX.year, NOW_MX.month)[1]
        assert len(d["by_day"]) == last_day, \
            f"month must have {last_day} entries, got {len(d['by_day'])}"
        assert d["period"] == "month"

    def test_filter_by_sucursal(self, s):
        r = s.get(f"{API}/dashboard/period",
                  params={"period": "week", "sucursal": "Valle Dorado"})
        assert r.status_code == 200
        d = r.json()
        assert d["sucursal"] == "Valle Dorado"
        # Only Valle Dorado should have non-zero (others 0)
        for name, v in d["by_sucursal"].items():
            if name != "Valle Dorado":
                assert v["total"] == 0, f"{name} should be 0 when filtered"


# -------------------- CSV report ---------------------------------------------
class TestReportsCSV:
    def test_csv_week_shape(self, s):
        r = s.get(f"{API}/reports/csv", params={"period": "week"})
        assert r.status_code == 200, r.text
        ct = r.headers.get("content-type", "")
        assert "text/csv" in ct
        cd = r.headers.get("content-disposition", "")
        assert "reporte_week_" in cd and ".csv" in cd
        # BOM
        assert r.content.startswith(b"\xef\xbb\xbf"), "CSV must start with UTF-8 BOM"
        text = r.content.decode("utf-8-sig")
        rows = list(csv.reader(io.StringIO(text)))
        assert len(rows) >= 1
        header = rows[0]
        expected_cols = ["Fecha", "Sucursal", "Ventas", "Total", "Subtotal",
                         "Propinas", "Ticket promedio", "Items vendidos",
                         "Efectivo", "Transferencia", "Tarjeta",
                         "Propina tarjeta", "Propina transferencia",
                         "Mesa (total)", "Mesa (#)", "Llevar (total)",
                         "Llevar (#)", "Domicilio (total)", "Domicilio (#)"]
        assert header == expected_cols, f"Header mismatch: {header}"
        # Look for TOTAL row if there are any sales rows
        data_rows = [r_ for r_ in rows[1:] if r_]
        if data_rows:
            total_rows = [r_ for r_ in data_rows if r_ and r_[0] == "TOTAL"]
            assert total_rows, "Expected TOTAL row at the end when there is data"
