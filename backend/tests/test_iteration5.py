"""Tacos POS Backend tests – Iteration 5.
Covers:
  - Product.pricing_mode 'fixed' (default) | 'variable'
  - Sale.payments[] for both single payment and mixto (split)
  - Validation rules for mixto: at least 2 parts; sum must match subtotal;
    cash_received < amount -> 400; cash_received > amount -> change_given.
  - Dashboard reflects split correctly in by_payment and tip_breakdown.
  - Dashboard/period reflects split correctly.
  - CSV report places efectivo amount in Efectivo column and tarjeta amount
    in Tarjeta column with tip in Propina tarjeta for a mixto sale.
  - Original cashier logins keep working (no rename).
"""
import os
import csv
import io
from datetime import datetime, timezone, timedelta

import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

MX_TZ = timezone(timedelta(hours=-6))
TODAY_MX = datetime.now(MX_TZ).strftime("%Y-%m-%d")

ORIGINAL_LOGINS = [
    ("valle_dorado", "valle123"),
    ("mezcalitos", "mezca123"),
    ("san_vicente", "vicente123"),
    ("pi", "pi123"),
    ("san_jose", "jose123"),
    ("admin", "taco123"),
]


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


@pytest.fixture(scope="module")
def tacos_product(s):
    prods = s.get(f"{API}/products").json()
    return next(p for p in prods if p["name"] == "Tacos")


# -------------------- Original logins still work -----------------------------
class TestLoginsAllOriginal:
    @pytest.mark.parametrize("u,p", ORIGINAL_LOGINS)
    def test_login_ok(self, s, u, p):
        r = s.post(f"{API}/auth/login", json={"username": u, "password": p})
        assert r.status_code == 200, r.text
        assert r.json()["user"]["username"] == u


# -------------------- Pricing mode variable ----------------------------------
class TestProductPricingMode:
    def test_default_is_fixed(self, s):
        prods = s.get(f"{API}/products").json()
        # Pick a default product (not 'Birria') and confirm pricing_mode
        non_birria = [p for p in prods if p["name"] != "Birria"]
        assert non_birria, "Expected default products to exist"
        for p in non_birria[:3]:
            assert p.get("pricing_mode", "fixed") == "fixed", \
                f"{p['name']} should default to 'fixed'"

    def test_create_variable_then_update_back(self, s):
        # Cleanup any leftover
        prods = s.get(f"{API}/products").json()
        for p in prods:
            if p["name"] == "TEST_VariableX":
                s.delete(f"{API}/products/{p['id']}")
        # Create variable product
        body = {"name": "TEST_VariableX", "price": 0, "pricing_mode": "variable"}
        r = s.post(f"{API}/products", json=body)
        assert r.status_code == 200, r.text
        pid = r.json()["id"]
        assert r.json()["pricing_mode"] == "variable"
        # Confirm via GET
        prods2 = s.get(f"{API}/products").json()
        created = next(p for p in prods2 if p["id"] == pid)
        assert created["pricing_mode"] == "variable"
        # Update back to fixed
        ru = s.put(f"{API}/products/{pid}", json={"pricing_mode": "fixed"})
        assert ru.status_code == 200
        assert ru.json()["pricing_mode"] == "fixed"
        # cleanup
        s.delete(f"{API}/products/{pid}")

    def test_birria_is_variable_if_present(self, s):
        prods = s.get(f"{API}/products").json()
        birria = next((p for p in prods if p["name"] == "Birria"), None)
        if birria is not None:
            assert birria.get("pricing_mode") == "variable", \
                "Birria should be 'variable' (seeded by main agent)"


# -------------------- Single-payment writes payments[1] ----------------------
class TestSinglePaymentWritesPayments:
    def test_tarjeta_single_creates_payments(self, s, tacos_product):
        sale = {
            "items": [{"product_id": tacos_product["id"],
                       "name": tacos_product["name"],
                       "price": tacos_product["price"], "quantity": 2}],
            "payment_method": "tarjeta",
            "tip": 10,
            "sucursal": "Valle Dorado",
            "cashier": "valle_dorado",
            "caja": "Caja 1",
            "order_type": "llevar",
        }
        r = s.post(f"{API}/sales", json=sale)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["subtotal"] == 60
        assert d["tip"] == 10
        assert d["total"] == 70
        assert d["payments"] and len(d["payments"]) == 1
        p = d["payments"][0]
        assert p["method"] == "tarjeta"
        assert p["amount"] == 60
        assert p["tip"] == 10


# -------------------- Mixto: valid split -------------------------------------
@pytest.fixture(scope="module")
def mixto_sale_response(s, tacos_product):
    """Create a mixto sale: subtotal=120, ef=60, tarjeta=60 with tip=15.
    Returns the response json once."""
    sale = {
        "items": [{"product_id": tacos_product["id"], "name": tacos_product["name"],
                   "price": tacos_product["price"], "quantity": 4}],
        "payment_method": "mixto",
        "sucursal": "Valle Dorado",
        "cashier": "valle_dorado",
        "caja": "Caja 1",
        "order_type": "llevar",
        "payments": [
            {"method": "efectivo", "amount": 60},
            {"method": "tarjeta", "amount": 60, "tip": 15},
        ],
    }
    r = s.post(f"{API}/sales", json=sale)
    assert r.status_code == 200, r.text
    return r.json()


class TestMixtoValid:
    def test_subtotal_tip_total(self, mixto_sale_response):
        d = mixto_sale_response
        assert d["subtotal"] == 120
        assert d["tip"] == 15
        assert d["total"] == 135

    def test_payments_array_returned(self, mixto_sale_response):
        d = mixto_sale_response
        assert d["payments"] and len(d["payments"]) == 2
        methods = sorted(p["method"] for p in d["payments"])
        assert methods == ["efectivo", "tarjeta"]
        tarjeta = next(p for p in d["payments"] if p["method"] == "tarjeta")
        assert tarjeta["amount"] == 60
        assert tarjeta["tip"] == 15
        efectivo = next(p for p in d["payments"] if p["method"] == "efectivo")
        assert efectivo["amount"] == 60
        assert efectivo["tip"] == 0

    def test_cash_received_greater_computes_change(self, s, tacos_product):
        sale = {
            "items": [{"product_id": tacos_product["id"],
                       "name": tacos_product["name"],
                       "price": tacos_product["price"], "quantity": 3}],
            "payment_method": "mixto",
            "sucursal": "Valle Dorado",
            "order_type": "llevar",
            "payments": [
                {"method": "efectivo", "amount": 50, "cash_received": 100},
                {"method": "tarjeta", "amount": 40, "tip": 5},
            ],
        }
        r = s.post(f"{API}/sales", json=sale)
        assert r.status_code == 200, r.text
        d = r.json()
        ef = next(p for p in d["payments"] if p["method"] == "efectivo")
        assert ef["cash_received"] == 100
        assert ef["change_given"] == 50  # 100 - 50


# -------------------- Mixto: error paths -------------------------------------
class TestMixtoErrors:
    def test_sum_mismatch_400(self, s, tacos_product):
        sale = {
            "items": [{"product_id": tacos_product["id"], "name": "Tacos",
                       "price": 30, "quantity": 4}],
            "payment_method": "mixto",
            "sucursal": "Valle Dorado",
            "order_type": "llevar",
            "payments": [
                {"method": "efectivo", "amount": 60},
                {"method": "tarjeta", "amount": 50, "tip": 0},
            ],
        }
        r = s.post(f"{API}/sales", json=sale)
        assert r.status_code == 400
        assert "deben sumar el subtotal" in r.json().get("detail", "")

    def test_only_one_part_400(self, s, tacos_product):
        sale = {
            "items": [{"product_id": tacos_product["id"], "name": "Tacos",
                       "price": 30, "quantity": 4}],
            "payment_method": "mixto",
            "sucursal": "Valle Dorado",
            "order_type": "llevar",
            "payments": [
                {"method": "efectivo", "amount": 120},
            ],
        }
        r = s.post(f"{API}/sales", json=sale)
        assert r.status_code == 400
        assert "al menos 2 partes" in r.json().get("detail", "")

    def test_cash_received_less_than_amount_400(self, s, tacos_product):
        sale = {
            "items": [{"product_id": tacos_product["id"], "name": "Tacos",
                       "price": 30, "quantity": 4}],
            "payment_method": "mixto",
            "sucursal": "Valle Dorado",
            "order_type": "llevar",
            "payments": [
                {"method": "efectivo", "amount": 60, "cash_received": 40},
                {"method": "tarjeta", "amount": 60, "tip": 0},
            ],
        }
        r = s.post(f"{API}/sales", json=sale)
        assert r.status_code == 400
        assert "menor" in r.json().get("detail", "").lower()


# -------------------- Dashboard reflects split -------------------------------
class TestDashboardReflectsSplit:
    def test_dashboard_today_reflects_split(self, s, mixto_sale_response):
        # mixto_sale_response is fixture-scoped (module) so it ran exactly once.
        r = s.get(f"{API}/dashboard", params={"date": TODAY_MX})
        assert r.status_code == 200, r.text
        d = r.json()
        bp = d["by_payment"]
        # The split should have +60 efectivo and +60 tarjeta and +15 tarjeta tip
        # Other tests may have added more so we only ensure presence and that
        # mixto contributions are accounted, by checking minimums.
        assert bp["efectivo"]["amount"] >= 60
        assert bp["tarjeta"]["amount"] >= 60
        assert bp["tarjeta"]["tip"] >= 15
        # tip_breakdown
        assert d["tip_breakdown"]["tarjeta"] >= 15

    def test_dashboard_period_week_reflects_split(self, s, mixto_sale_response):
        r = s.get(f"{API}/dashboard/period", params={"period": "week"})
        assert r.status_code == 200, r.text
        d = r.json()
        bp = d["by_payment"]
        assert bp["efectivo"]["amount"] >= 60
        assert bp["tarjeta"]["amount"] >= 60
        assert bp["tarjeta"]["tip"] >= 15


# -------------------- CSV report places split correctly ----------------------
class TestCSVReflectsSplit:
    def test_csv_week_efectivo_and_tarjeta_columns(self, s, mixto_sale_response):
        r = s.get(f"{API}/reports/csv", params={"period": "week",
                                                 "sucursal": "Valle Dorado"})
        assert r.status_code == 200, r.text
        text = r.content.decode("utf-8-sig")
        rows = list(csv.reader(io.StringIO(text)))
        header = rows[0]
        idx = {col: i for i, col in enumerate(header)}
        # Find today's row for Valle Dorado
        day_rows = [r_ for r_ in rows[1:]
                    if r_ and r_[0] == TODAY_MX and r_[1] == "Valle Dorado"]
        assert day_rows, "Expected at least one row for today/Valle Dorado"
        row = day_rows[0]
        efectivo = float(row[idx["Efectivo"]])
        tarjeta = float(row[idx["Tarjeta"]])
        tip_tarj = float(row[idx["Propina tarjeta"]])
        assert efectivo >= 60, f"Efectivo column should include split's $60, got {efectivo}"
        assert tarjeta >= 60, f"Tarjeta column should include split's $60, got {tarjeta}"
        assert tip_tarj >= 15, f"Propina tarjeta should include $15, got {tip_tarj}"
