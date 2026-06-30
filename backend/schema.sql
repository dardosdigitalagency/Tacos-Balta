-- ============================================================================
-- Tacos POS — Schema PostgreSQL
-- Mantiene paridad con la versión MongoDB previa. Items y payments se
-- almacenan como JSONB para preservar la flexibilidad y simplificar la
-- migración (cada doc de Mongo se mapea 1:1 a una fila en sales).
-- ============================================================================

-- ---------- Tablas catálogo ----------
CREATE TABLE IF NOT EXISTS sucursales (
    id          TEXT PRIMARY KEY,
    name        TEXT UNIQUE NOT NULL,
    sort_order  INT  NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sucursales_sort ON sucursales (sort_order);

CREATE TABLE IF NOT EXISTS products (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    price         NUMERIC(12, 2) NOT NULL DEFAULT 0,
    category      TEXT NOT NULL DEFAULT 'comida',
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order    INT NOT NULL DEFAULT 0,
    pricing_mode  TEXT NOT NULL DEFAULT 'fixed',  -- 'fixed' | 'variable'
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_sort ON products (sort_order);
CREATE INDEX IF NOT EXISTS idx_products_active ON products (active);

CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    username       TEXT UNIQUE NOT NULL,
    password_hash  TEXT NOT NULL,
    sucursal       TEXT,
    role           TEXT NOT NULL DEFAULT 'cashier',  -- 'admin' | 'cashier'
    caja_name      TEXT,
    active         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

-- ---------- Ventas (con items y payments JSONB) ----------
CREATE TABLE IF NOT EXISTS sales (
    id                  TEXT PRIMARY KEY,
    client_id           TEXT,                 -- idempotencia desde el POS
    sucursal            TEXT NOT NULL,
    cashier             TEXT,
    caja                TEXT,
    order_type          TEXT NOT NULL DEFAULT 'mesa',
    mesa_number         TEXT,
    subtotal            NUMERIC(12, 2) NOT NULL DEFAULT 0,
    tip                 NUMERIC(12, 2) NOT NULL DEFAULT 0,
    iva                 NUMERIC(12, 2) NOT NULL DEFAULT 0,
    invoice_requested   BOOLEAN NOT NULL DEFAULT FALSE,
    delivery_fee        NUMERIC(12, 2) NOT NULL DEFAULT 0,
    total               NUMERIC(12, 2) NOT NULL DEFAULT 0,
    payment_method      TEXT NOT NULL,        -- 'efectivo'|'transferencia'|'tarjeta'|'mixto'
    cash_received       NUMERIC(12, 2),
    change_given        NUMERIC(12, 2),
    items               JSONB NOT NULL DEFAULT '[]'::jsonb,
    payments            JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotencia: una venta única por client_id (cuando viene)
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_client_id
    ON sales (client_id) WHERE client_id IS NOT NULL;

-- Índices para queries del dashboard / sales list
CREATE INDEX IF NOT EXISTS idx_sales_created_at      ON sales (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_sucursal_date   ON sales (sucursal, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_caja_date       ON sales (caja, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_payment_method  ON sales (payment_method);
CREATE INDEX IF NOT EXISTS idx_sales_order_type      ON sales (order_type);
