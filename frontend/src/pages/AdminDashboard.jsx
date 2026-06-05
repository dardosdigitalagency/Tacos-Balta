/**
 * Admin Dashboard
 * - Filtros: sucursal (todas o una de las 5) + selector de fecha (calendario).
 * - KPIs, gráficas, tabla de ventas y editor de precios.
 * - Propina mostrada por separado: tarjeta vs transferencia.
 * - Tab Usuarios para editar contraseñas y sucursales.
 * - Polling cada 5s.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  LineChart, Line, PieChart, Pie, Cell, Legend,
} from "recharts";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { api, formatMXN, PAYMENT_LABELS } from "@/lib/api";
import { clearSession } from "@/lib/auth";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const POLL_MS = 5000;
const PIE_COLORS = ["#006400", "#228B22", "#84cc16"];
const SUCURSAL_COLORS = ["#006400", "#228B22", "#0369A1", "#dc2626", "#a16207"];

const fmtDateAPI = (d) => format(d, "yyyy-MM-dd");

export default function AdminDashboard() {
  const navigate = useNavigate();

  const [date, setDate] = useState(new Date());
  const [sucursal, setSucursal] = useState("all");
  const [sucursales, setSucursales] = useState([]);
  const [tab, setTab] = useState("dashboard");

  const [stats, setStats] = useState(null);
  const [sales, setSales] = useState([]);
  const [products, setProducts] = useState([]);
  const [users, setUsers] = useState([]);

  // cargar sucursales una vez
  useEffect(() => {
    api.get("/sucursales").then((r) => setSucursales(r.data.sucursales));
  }, []);

  const fetchAll = async () => {
    const d = fmtDateAPI(date);
    try {
      const [s, sl, p, us] = await Promise.all([
        api.get(`/dashboard?date=${d}&sucursal=${sucursal}`),
        api.get(`/sales?scope=date&date=${d}&sucursal=${sucursal}`),
        api.get("/products?include_inactive=true"),
        api.get("/users"),
      ]);
      setStats(s.data);
      setSales(sl.data);
      setProducts(p.data);
      setUsers(us.data);
    } catch {
      /* retry on next poll */
    }
  };

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, sucursal]);

  const logout = () => {
    clearSession();
    navigate("/", { replace: true });
  };

  const isToday = useMemo(
    () => fmtDateAPI(date) === fmtDateAPI(new Date()),
    [date]
  );

  return (
    <div className="min-h-screen bg-[#F4F4F5] pb-12">
      {/* Header */}
      <header className="bg-white border-b-2 border-[#006400] px-4 py-3 sticky top-0 z-20">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 leading-none">
              Panel Administrativo
            </p>
            <h1 className="font-display text-2xl sm:text-3xl font-black text-[#006400] leading-none">
              ADMIN
            </h1>
          </div>
          <div className="flex gap-2">
            <button
              data-testid="btn-logout"
              onClick={logout}
              className="h-11 px-3 text-xs uppercase tracking-widest font-bold bg-zinc-900 text-white rounded-md tap-scale"
            >
              Salir
            </button>
          </div>
        </div>

        {/* Filtros */}
        <div className="max-w-6xl mx-auto mt-3 flex flex-wrap items-center gap-2">
          <DatePicker date={date} setDate={setDate} />
          {!isToday && (
            <button
              data-testid="btn-today"
              onClick={() => setDate(new Date())}
              className="h-11 px-3 text-[11px] uppercase tracking-widest font-bold border-2 border-[#006400] text-[#006400] bg-white rounded-md tap-scale"
            >
              Hoy
            </button>
          )}

          <SucursalSelect
            sucursales={sucursales}
            value={sucursal}
            onChange={setSucursal}
          />
        </div>

        {/* Tabs */}
        <nav className="max-w-6xl mx-auto mt-3 flex gap-1.5 overflow-x-auto">
          {[
            ["dashboard", "Dashboard"],
            ["sales", "Ventas"],
            ["products", "Precios"],
            ["users", "Usuarios"],
          ].map(([k, label]) => (
            <button
              key={k}
              data-testid={`tab-${k}`}
              onClick={() => setTab(k)}
              className={`h-10 px-3 text-[11px] uppercase tracking-widest font-bold rounded-md border-2 tap-scale whitespace-nowrap ${
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

      <main className="max-w-6xl mx-auto px-4 pt-5 space-y-5">
        {tab === "dashboard" && (
          <DashboardTab stats={stats} sucursal={sucursal} />
        )}
        {tab === "sales" && <SalesTab sales={sales} />}
        {tab === "products" && (
          <ProductsTab products={products} reload={fetchAll} />
        )}
        {tab === "users" && (
          <UsersTab users={users} sucursales={sucursales} reload={fetchAll} />
        )}
      </main>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Date Picker (shadcn calendar inside popover)
// ----------------------------------------------------------------------------
function DatePicker({ date, setDate }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          data-testid="btn-date-picker"
          className="h-11 px-3 inline-flex items-center gap-2 text-xs uppercase tracking-widest font-bold border-2 border-[#006400] text-[#006400] bg-white rounded-md tap-scale"
        >
          <span className="text-zinc-500">Fecha</span>
          <span className="text-zinc-900" data-testid="current-date-label">
            {format(date, "dd MMM yyyy", { locale: es })}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0 bg-white border-2 border-zinc-200 rounded-md">
        <Calendar
          mode="single"
          selected={date}
          onSelect={(d) => {
            if (d) {
              setDate(d);
              setOpen(false);
            }
          }}
          disabled={(d) => d > new Date()}
          initialFocus
          locale={es}
        />
      </PopoverContent>
    </Popover>
  );
}

// ----------------------------------------------------------------------------
// Sucursal Selector
// ----------------------------------------------------------------------------
function SucursalSelect({ sucursales, value, onChange }) {
  return (
    <div
      className="flex items-center gap-1.5 overflow-x-auto"
      data-testid="sucursal-filter"
    >
      <button
        data-testid="suc-all"
        onClick={() => onChange("all")}
        className={`h-11 px-3 text-[11px] uppercase tracking-widest font-bold rounded-md border-2 tap-scale whitespace-nowrap ${
          value === "all"
            ? "bg-zinc-900 text-white border-zinc-900"
            : "bg-white text-zinc-900 border-zinc-300"
        }`}
      >
        Todas
      </button>
      {sucursales.map((s) => (
        <button
          key={s}
          data-testid={`suc-${s}`}
          onClick={() => onChange(s)}
          className={`h-11 px-3 text-[11px] uppercase tracking-widest font-bold rounded-md border-2 tap-scale whitespace-nowrap ${
            value === s
              ? "bg-[#006400] text-white border-[#006400]"
              : "bg-white text-[#006400] border-[#006400]"
          }`}
        >
          {s}
        </button>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Dashboard Tab
// ----------------------------------------------------------------------------
function DashboardTab({ stats, sucursal }) {
  if (!stats) return <div className="text-zinc-500">Cargando…</div>;

  const pieData = Object.entries(stats.by_payment).map(([k, v]) => ({
    name: PAYMENT_LABELS[k] || k,
    value: v.amount,
  }));
  const topData = stats.top_products.slice(0, 8);

  const sucursalData = Object.entries(stats.by_sucursal || {}).map(
    ([k, v]) => ({ name: k, total: v.total, count: v.count })
  );

  return (
    <div className="space-y-5" data-testid="dashboard-tab">
      {/* KPIs principales */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <KpiCard label="Total" value={formatMXN(stats.grand_total)} testid="kpi-total" primary />
        <KpiCard label="Productos" value={formatMXN(stats.grand_subtotal)} testid="kpi-subtotal" />
        <KpiCard label="Propinas" value={formatMXN(stats.grand_tip)} testid="kpi-tips" />
        <KpiCard label="# Ventas" value={stats.sales_count} testid="kpi-count" />
      </div>

      {/* Desglose por método de pago */}
      <section className="bg-white border-2 border-zinc-100 rounded-md p-4">
        <h2 className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-3">
          Por método de pago
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {Object.entries(stats.by_payment).map(([k, v]) => (
            <div
              key={k}
              data-testid={`payment-${k}`}
              className="border-2 border-zinc-100 rounded-md p-3"
            >
              <p className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">
                {PAYMENT_LABELS[k]}
              </p>
              <p className="font-display text-2xl sm:text-3xl font-black text-[#006400] leading-none mt-1">
                {formatMXN(v.amount)}
              </p>
              <p className="text-sm text-zinc-600 mt-1">
                {v.count} {v.count === 1 ? "venta" : "ventas"}
              </p>
              {(k === "tarjeta" || k === "transferencia") && (
                <p className="text-xs uppercase tracking-widest font-bold text-zinc-500 mt-2">
                  Propina:{" "}
                  <span
                    className="text-zinc-900 font-black"
                    data-testid={`tip-${k}`}
                  >
                    {formatMXN(v.tip)}
                  </span>
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Tarjeta de Propinas separada */}
      <section
        className="bg-white border-2 border-zinc-100 rounded-md p-4"
        data-testid="tip-breakdown"
      >
        <h2 className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-3">
          Propinas detalladas
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <TipBox
            label="Tarjeta"
            amount={stats.tip_breakdown?.tarjeta || 0}
            testid="tipbox-tarjeta"
            accent="#006400"
          />
          <TipBox
            label="Transferencia"
            amount={stats.tip_breakdown?.transferencia || 0}
            testid="tipbox-transferencia"
            accent="#228B22"
          />
          <TipBox
            label="Total propinas"
            amount={stats.grand_tip || 0}
            testid="tipbox-total"
            accent="#0369A1"
            bold
          />
        </div>
      </section>

      {/* Por sucursal (solo cuando se ven todas) */}
      {sucursal === "all" && sucursalData.length > 0 && (
        <section className="bg-white border-2 border-zinc-100 rounded-md p-4">
          <h2 className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-3">
            Por sucursal
          </h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={sucursalData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fontWeight: 700 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => formatMXN(v)} />
              <Bar dataKey="total" radius={[4, 4, 0, 0]}>
                {sucursalData.map((_, i) => (
                  <Cell
                    key={i}
                    fill={SUCURSAL_COLORS[i % SUCURSAL_COLORS.length]}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </section>
      )}

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
                  tick={{ fontSize: 10, fontWeight: 700 }}
                  interval={0}
                  angle={-20}
                  textAnchor="end"
                  height={70}
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
              <Tooltip formatter={(v) => formatMXN(v)} />
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
      className={`rounded-md p-3 border-2 ${
        primary ? "bg-[#006400] text-white border-[#006400]" : "bg-white border-zinc-100"
      }`}
    >
      <p className={`text-[10px] uppercase tracking-widest font-bold ${primary ? "text-green-100" : "text-zinc-500"}`}>
        {label}
      </p>
      <p className={`font-display text-2xl sm:text-3xl font-black leading-none mt-1 ${primary ? "text-white" : "text-zinc-900"}`}>
        {value}
      </p>
    </div>
  );
}

function TipBox({ label, amount, testid, accent, bold }) {
  return (
    <div
      data-testid={testid}
      className="border-2 border-zinc-100 rounded-md p-3"
      style={bold ? { borderColor: accent } : {}}
    >
      <p className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">
        {label}
      </p>
      <p
        className="font-display text-2xl sm:text-3xl font-black leading-none mt-1"
        style={{ color: accent }}
      >
        {formatMXN(amount)}
      </p>
    </div>
  );
}

function ChartCard({ title, children, wide }) {
  return (
    <div className={`bg-white border-2 border-zinc-100 rounded-md p-4 ${wide ? "lg:col-span-2" : ""}`}>
      <h3 className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-3">{title}</h3>
      {children}
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="h-[260px] flex items-center justify-center text-zinc-400 text-sm font-bold uppercase tracking-widest">
      Sin datos
    </div>
  );
}

// ----------------------------------------------------------------------------
// Sales Tab
// ----------------------------------------------------------------------------
function SalesTab({ sales }) {
  if (sales.length === 0) {
    return (
      <div className="bg-white p-6 rounded-md border-2 border-zinc-100 text-zinc-500">
        Sin ventas para los filtros seleccionados.
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
              <Th>Sucursal</Th>
              <Th>Cajero</Th>
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
                <Td className="font-bold">{s.sucursal || "—"}</Td>
                <Td className="text-xs text-zinc-600">{s.cashier || "—"}</Td>
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
                <Td className="font-display text-lg font-black text-[#006400]">{formatMXN(s.total)}</Td>
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
  <th className="px-3 py-2 text-[10px] uppercase tracking-widest font-bold text-zinc-500">
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
      hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short",
    });
  } catch {
    return iso;
  }
}

// ----------------------------------------------------------------------------
// Products Tab – editor de precios + categoría
// ----------------------------------------------------------------------------
function ProductsTab({ products, reload }) {
  const [edits, setEdits] = useState({});
  const [savingId, setSavingId] = useState(null);
  const [creating, setCreating] = useState({ name: "", price: "", category: "comida" });

  const setField = (id, field, val) =>
    setEdits((e) => ({ ...e, [id]: { ...(e[id] || {}), [field]: val } }));

  const save = async (p) => {
    const e = edits[p.id] || {};
    const payload = {};
    if (e.name !== undefined && e.name !== p.name) payload.name = e.name;
    if (e.price !== undefined && Number(e.price) !== p.price) payload.price = Number(e.price);
    if (e.category !== undefined && e.category !== p.category) payload.category = e.category;
    if (Object.keys(payload).length === 0) return toast.info("Sin cambios");
    setSavingId(p.id);
    try {
      await api.put(`/products/${p.id}`, payload);
      toast.success("Producto actualizado");
      setEdits((s) => { const c = { ...s }; delete c[p.id]; return c; });
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
    if (!creating.name || !creating.price) return toast.error("Completa nombre y precio");
    try {
      await api.post("/products", {
        name: creating.name,
        price: Number(creating.price),
        category: creating.category,
        sort_order: 999,
      });
      setCreating({ name: "", price: "", category: "comida" });
      toast.success("Producto creado");
      await reload();
    } catch {
      toast.error("Error al crear");
    }
  };

  return (
    <div className="space-y-4" data-testid="products-tab">
      <div className="bg-white border-2 border-zinc-100 rounded-md p-4">
        <p className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-2">
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
            onChange={(e) => setCreating((c) => ({ ...c, price: e.target.value }))}
            placeholder="Precio"
            className="w-32 h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
          />
          <select
            data-testid="new-product-category"
            value={creating.category}
            onChange={(e) => setCreating((c) => ({ ...c, category: e.target.value }))}
            className="h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400] bg-white"
          >
            <option value="comida">Comida</option>
            <option value="bebida">Bebida</option>
          </select>
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
          const catVal = e.category !== undefined ? e.category : (p.category || "comida");
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
                className="w-28 h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
                data-testid={`edit-price-${p.id}`}
              />
              <select
                value={catVal}
                onChange={(ev) => setField(p.id, "category", ev.target.value)}
                className="h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400] bg-white"
                data-testid={`edit-category-${p.id}`}
              >
                <option value="comida">Comida</option>
                <option value="bebida">Bebida</option>
              </select>
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
                  p.active ? "border-zinc-300 text-zinc-700 bg-white" : "border-[#006400] text-[#006400] bg-white"
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

// ----------------------------------------------------------------------------
// Users Tab – cambiar contraseñas y sucursal
// ----------------------------------------------------------------------------
function UsersTab({ users, sucursales, reload }) {
  const [drafts, setDrafts] = useState({}); // id -> {password, sucursal}
  const [busy, setBusy] = useState(null);

  const setField = (id, k, v) =>
    setDrafts((d) => ({ ...d, [id]: { ...(d[id] || {}), [k]: v } }));

  const save = async (u) => {
    const d = drafts[u.id] || {};
    const payload = {};
    if (d.password) payload.password = d.password;
    if (d.sucursal !== undefined && d.sucursal !== u.sucursal) payload.sucursal = d.sucursal;
    if (Object.keys(payload).length === 0) return toast.info("Sin cambios");
    setBusy(u.id);
    try {
      await api.put(`/users/${u.id}`, payload);
      toast.success("Usuario actualizado");
      setDrafts((s) => { const c = { ...s }; delete c[u.id]; return c; });
      await reload();
    } catch {
      toast.error("Error al guardar");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-white border-2 border-zinc-100 rounded-md divide-y divide-zinc-100" data-testid="users-tab">
      {users.map((u) => {
        const d = drafts[u.id] || {};
        const sucVal = d.sucursal !== undefined ? d.sucursal : (u.sucursal || "");
        return (
          <div key={u.id} className="p-3 flex flex-col sm:flex-row sm:items-center gap-2" data-testid={`user-row-${u.username}`}>
            <div className="flex-1 min-w-0">
              <p className="font-black text-lg leading-none">{u.username}</p>
              <p className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 mt-1">
                {u.role === "admin" ? "Administrador" : `Cajero · ${u.sucursal || "—"}`}
              </p>
            </div>
            <input
              type="text"
              placeholder="Nueva contraseña"
              value={d.password || ""}
              onChange={(e) => setField(u.id, "password", e.target.value)}
              className="h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400] w-full sm:w-48"
              data-testid={`edit-password-${u.username}`}
            />
            {u.role === "cashier" && (
              <select
                value={sucVal}
                onChange={(e) => setField(u.id, "sucursal", e.target.value)}
                className="h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400] bg-white"
                data-testid={`edit-sucursal-${u.username}`}
              >
                {sucursales.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            )}
            <button
              onClick={() => save(u)}
              disabled={busy === u.id}
              className="h-12 px-4 rounded-md bg-[#006400] text-white text-sm uppercase tracking-widest font-bold active:bg-[#228B22] disabled:bg-zinc-400 tap-scale"
              data-testid={`btn-save-user-${u.username}`}
            >
              Guardar
            </button>
          </div>
        );
      })}
    </div>
  );
}
