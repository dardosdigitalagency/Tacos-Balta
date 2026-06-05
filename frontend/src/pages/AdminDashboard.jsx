/**
 * Admin Dashboard – Stats del día, gráficas, tabla de ventas, editor de precios.
 * Refresca cada 5s.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import { api, formatMXN, PAYMENT_LABELS } from "@/lib/api";

const POLL_MS = 5000;
const PIE_COLORS = ["#006400", "#228B22", "#84cc16"];

export default function AdminDashboard() {
  const [stats, setStats] = useState(null);
  const [sales, setSales] = useState([]);
  const [products, setProducts] = useState([]);
  const [tab, setTab] = useState("dashboard"); // 'dashboard' | 'sales' | 'products'
  const navigate = useNavigate();

  const fetchAll = async () => {
    try {
      const [s, sl, p] = await Promise.all([
        api.get("/dashboard"),
        api.get("/sales?scope=today"),
        api.get("/products?include_inactive=true"),
      ]);
      setStats(s.data);
      setSales(sl.data);
      setProducts(p.data);
    } catch {
      // silent – next poll will retry
    }
  };

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, POLL_MS);
    return () => clearInterval(t);
  }, []);

  const logout = () => {
    localStorage.removeItem("tacos_admin_auth");
    navigate("/admin/login", { replace: true });
  };

  return (
    <div className="min-h-screen bg-[#F4F4F5] pb-12">
      {/* Header */}
      <header className="bg-white border-b-2 border-[#006400] px-4 py-4 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest font-bold text-zinc-500">
              Panel Administrativo
            </p>
            <h1 className="font-display text-3xl font-black text-[#006400] leading-none">
              ADMIN
            </h1>
          </div>
          <div className="flex gap-2">
            <Link
              to="/"
              data-testid="back-pos"
              className="h-12 px-3 flex items-center text-xs uppercase tracking-widest font-bold border-2 border-[#006400] text-[#006400] rounded-md tap-scale"
            >
              POS
            </Link>
            <button
              data-testid="btn-logout"
              onClick={logout}
              className="h-12 px-3 text-xs uppercase tracking-widest font-bold bg-zinc-900 text-white rounded-md tap-scale"
            >
              Salir
            </button>
          </div>
        </div>
        {/* Tabs */}
        <nav className="max-w-6xl mx-auto mt-4 flex gap-2">
          {[
            ["dashboard", "Dashboard"],
            ["sales", "Ventas"],
            ["products", "Precios"],
          ].map(([k, label]) => (
            <button
              key={k}
              data-testid={`tab-${k}`}
              onClick={() => setTab(k)}
              className={`h-12 px-4 text-xs uppercase tracking-widest font-bold rounded-md border-2 tap-scale ${
                tab === k
                  ? "bg-[#006400] text-white border-[#006400]"
                  : "bg-white text-[#006400] border-[#006400]"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="max-w-6xl mx-auto px-4 pt-6 space-y-6">
        {tab === "dashboard" && <DashboardTab stats={stats} />}
        {tab === "sales" && <SalesTab sales={sales} />}
        {tab === "products" && (
          <ProductsTab products={products} reload={fetchAll} />
        )}
      </main>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Dashboard tab
// ----------------------------------------------------------------------------
function DashboardTab({ stats }) {
  if (!stats) {
    return <div className="text-zinc-500">Cargando…</div>;
  }
  const pieData = Object.entries(stats.by_payment).map(([k, v]) => ({
    name: PAYMENT_LABELS[k] || k,
    value: v.amount,
  }));
  const topData = stats.top_products.slice(0, 8);

  return (
    <div className="space-y-6" data-testid="dashboard-tab">
      {/* Headline KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          label="Total del día"
          value={formatMXN(stats.grand_total)}
          testid="kpi-total"
          primary
        />
        <KpiCard
          label="Productos"
          value={formatMXN(stats.grand_subtotal)}
          testid="kpi-subtotal"
        />
        <KpiCard
          label="Propinas"
          value={formatMXN(stats.grand_tip)}
          testid="kpi-tips"
        />
        <KpiCard
          label="# Ventas"
          value={stats.sales_count}
          testid="kpi-count"
        />
      </div>

      {/* Payment method breakdown */}
      <section className="bg-white border-2 border-zinc-100 rounded-md p-4">
        <h2 className="text-xs uppercase tracking-widest font-bold text-zinc-500 mb-3">
          Por método de pago
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {Object.entries(stats.by_payment).map(([k, v]) => (
            <div
              key={k}
              data-testid={`payment-${k}`}
              className="border-2 border-zinc-100 rounded-md p-4"
            >
              <p className="text-xs uppercase tracking-widest font-bold text-zinc-500">
                {PAYMENT_LABELS[k]}
              </p>
              <p className="font-display text-3xl font-black text-[#006400] leading-none mt-1">
                {formatMXN(v.amount)}
              </p>
              <p className="text-sm text-zinc-600 mt-1">
                {v.count} {v.count === 1 ? "venta" : "ventas"}
              </p>
              {(k === "tarjeta" || k === "transferencia") && (
                <p className="text-xs uppercase tracking-widest font-bold text-zinc-500 mt-2">
                  Propina: <span className="text-zinc-900">{formatMXN(v.tip)}</span>
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Charts */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Productos más vendidos">
          {topData.length === 0 ? (
            <EmptyChart />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={topData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11, fontWeight: 700 }}
                  interval={0}
                  angle={-15}
                  textAnchor="end"
                  height={60}
                />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="quantity" fill="#006400" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Ventas por hora">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={stats.sales_by_hour}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
              <XAxis dataKey="hour" tick={{ fontSize: 10 }} interval={1} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Line
                type="monotone"
                dataKey="total"
                stroke="#006400"
                strokeWidth={3}
                dot={{ r: 3, fill: "#006400" }}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Distribución de pagos" wide>
          {pieData.every((d) => d.value === 0) ? (
            <EmptyChart />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  outerRadius={90}
                  label={({ name, value }) => `${name}: ${formatMXN(value)}`}
                  labelLine={false}
                >
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Legend />
                <Tooltip formatter={(v) => formatMXN(v)} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </section>
    </div>
  );
}

function KpiCard({ label, value, testid, primary }) {
  return (
    <div
      data-testid={testid}
      className={`rounded-md p-4 border-2 ${
        primary
          ? "bg-[#006400] text-white border-[#006400]"
          : "bg-white border-zinc-100"
      }`}
    >
      <p
        className={`text-xs uppercase tracking-widest font-bold ${
          primary ? "text-green-100" : "text-zinc-500"
        }`}
      >
        {label}
      </p>
      <p
        className={`font-display text-3xl md:text-4xl font-black leading-none mt-1 ${
          primary ? "text-white" : "text-zinc-900"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function ChartCard({ title, children, wide }) {
  return (
    <div
      className={`bg-white border-2 border-zinc-100 rounded-md p-4 ${
        wide ? "lg:col-span-2" : ""
      }`}
    >
      <h3 className="text-xs uppercase tracking-widest font-bold text-zinc-500 mb-3">
        {title}
      </h3>
      {children}
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="h-[260px] flex items-center justify-center text-zinc-400 text-sm font-bold uppercase tracking-widest">
      Sin datos todavía
    </div>
  );
}

// ----------------------------------------------------------------------------
// Sales tab – tabla
// ----------------------------------------------------------------------------
function SalesTab({ sales }) {
  if (sales.length === 0) {
    return (
      <div className="bg-white p-6 rounded-md border-2 border-zinc-100 text-zinc-500">
        Aún no hay ventas hoy.
      </div>
    );
  }
  return (
    <div className="bg-white rounded-md border-2 border-zinc-100 overflow-hidden" data-testid="sales-table">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50">
            <tr className="text-left">
              <Th>Hora</Th>
              <Th>Productos</Th>
              <Th>Subtotal</Th>
              <Th>Propina</Th>
              <Th>Total</Th>
              <Th>Pago</Th>
            </tr>
          </thead>
          <tbody>
            {sales.map((s) => (
              <tr key={s.id} className="border-t border-zinc-100" data-testid={`sale-row-${s.id}`}>
                <Td>{fmtTime(s.created_at)}</Td>
                <Td>
                  <ul className="space-y-0.5">
                    {s.items.map((it, i) => (
                      <li key={i}>
                        <span className="font-bold">{it.quantity}×</span> {it.name}
                      </li>
                    ))}
                  </ul>
                </Td>
                <Td className="font-bold">{formatMXN(s.subtotal)}</Td>
                <Td className="font-bold">{s.tip > 0 ? formatMXN(s.tip) : "—"}</Td>
                <Td className="font-display text-lg font-black text-[#006400]">
                  {formatMXN(s.total)}
                </Td>
                <Td>
                  <span className="text-xs uppercase tracking-widest font-bold">
                    {PAYMENT_LABELS[s.payment_method]}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const Th = ({ children }) => (
  <th className="px-3 py-2 text-xs uppercase tracking-widest font-bold text-zinc-500">
    {children}
  </th>
);
const Td = ({ children, className = "" }) => (
  <td className={`px-3 py-3 align-top ${className}`}>{children}</td>
);

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("es-MX", {
      timeZone: "America/Mexico_City",
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short",
    });
  } catch {
    return iso;
  }
}

// ----------------------------------------------------------------------------
// Products tab – editor de precios
// ----------------------------------------------------------------------------
function ProductsTab({ products, reload }) {
  const [edits, setEdits] = useState({}); // id -> {name, price}
  const [savingId, setSavingId] = useState(null);
  const [creating, setCreating] = useState({ name: "", price: "" });

  const setField = (id, field, val) =>
    setEdits((e) => ({
      ...e,
      [id]: { ...(e[id] || {}), [field]: val },
    }));

  const save = async (p) => {
    const e = edits[p.id] || {};
    const payload = {};
    if (e.name !== undefined && e.name !== p.name) payload.name = e.name;
    if (e.price !== undefined && Number(e.price) !== p.price)
      payload.price = Number(e.price);
    if (Object.keys(payload).length === 0) {
      toast.info("Sin cambios");
      return;
    }
    setSavingId(p.id);
    try {
      await api.put(`/products/${p.id}`, payload);
      toast.success("Precio actualizado");
      setEdits((s) => {
        const c = { ...s };
        delete c[p.id];
        return c;
      });
      await reload();
    } catch {
      toast.error("Error al guardar");
    } finally {
      setSavingId(null);
    }
  };

  const toggleActive = async (p) => {
    try {
      await api.put(`/products/${p.id}`, { active: !p.active });
      toast.success(p.active ? "Producto ocultado" : "Producto activado");
      await reload();
    } catch {
      toast.error("Error");
    }
  };

  const create = async () => {
    if (!creating.name || !creating.price) {
      toast.error("Completa nombre y precio");
      return;
    }
    try {
      await api.post("/products", {
        name: creating.name,
        price: Number(creating.price),
        sort_order: 999,
      });
      setCreating({ name: "", price: "" });
      toast.success("Producto creado");
      await reload();
    } catch {
      toast.error("Error al crear");
    }
  };

  return (
    <div className="space-y-4" data-testid="products-tab">
      <div className="bg-white border-2 border-zinc-100 rounded-md p-4">
        <p className="text-xs uppercase tracking-widest font-bold text-zinc-500 mb-2">
          Nuevo producto
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            data-testid="new-product-name"
            value={creating.name}
            onChange={(e) => setCreating((c) => ({ ...c, name: e.target.value }))}
            placeholder="Nombre"
            className="flex-1 h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
          />
          <input
            data-testid="new-product-price"
            type="number"
            value={creating.price}
            onChange={(e) =>
              setCreating((c) => ({ ...c, price: e.target.value }))
            }
            placeholder="Precio"
            className="w-32 h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
          />
          <button
            data-testid="btn-create-product"
            onClick={create}
            className="h-12 px-4 rounded-md bg-[#006400] text-white text-sm uppercase tracking-widest font-bold active:bg-[#228B22] tap-scale"
          >
            Crear
          </button>
        </div>
      </div>

      <div className="bg-white border-2 border-zinc-100 rounded-md divide-y divide-zinc-100">
        {products.map((p) => {
          const e = edits[p.id] || {};
          const nameVal = e.name !== undefined ? e.name : p.name;
          const priceVal = e.price !== undefined ? e.price : p.price;
          return (
            <div
              key={p.id}
              data-testid={`product-edit-${p.id}`}
              className="p-3 flex flex-col sm:flex-row sm:items-center gap-2"
            >
              <input
                value={nameVal}
                onChange={(ev) => setField(p.id, "name", ev.target.value)}
                className="flex-1 h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
                data-testid={`edit-name-${p.id}`}
              />
              <input
                type="number"
                value={priceVal}
                onChange={(ev) => setField(p.id, "price", ev.target.value)}
                className="w-32 h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
                data-testid={`edit-price-${p.id}`}
              />
              <button
                onClick={() => save(p)}
                disabled={savingId === p.id}
                className="h-12 px-4 rounded-md bg-[#006400] text-white text-sm uppercase tracking-widest font-bold active:bg-[#228B22] disabled:bg-zinc-400 tap-scale"
                data-testid={`btn-save-${p.id}`}
              >
                Guardar
              </button>
              <button
                onClick={() => toggleActive(p)}
                className={`h-12 px-4 rounded-md text-sm uppercase tracking-widest font-bold border-2 tap-scale ${
                  p.active
                    ? "border-zinc-300 text-zinc-700 bg-white"
                    : "border-[#006400] text-[#006400] bg-white"
                }`}
                data-testid={`btn-toggle-${p.id}`}
              >
                {p.active ? "Ocultar" : "Activar"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
