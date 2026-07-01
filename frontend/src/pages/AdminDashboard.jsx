/**
 * Admin Dashboard – v3.
 * Nuevas features:
 *  - Filtro de Caja (dentro de la sucursal seleccionada).
 *  - KPIs adicionales: Ticket promedio, Items por venta, Hora pico.
 *  - Distribución por tipo de orden (Mesa / Llevar / Domicilio).
 *  - Gráfica por caja cuando se selecciona una sucursal específica.
 *  - Tab Usuarios: crear, editar (todo) y eliminar perfiles.
 *  - Se quita el bloque duplicado de "Propinas detalladas" (ya en Por método de pago).
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
const ORDER_TYPE_LABELS = { mesa: "Mesa", llevar: "Llevar", domicilio: "Domicilio" };
const ORDER_TYPE_COLORS = { mesa: "#006400", llevar: "#0369A1", domicilio: "#a16207" };

const fmtDateAPI = (d) => format(d, "yyyy-MM-dd");

export default function AdminDashboard() {
  const navigate = useNavigate();

  const [date, setDate] = useState(new Date());
  const [sucursal, setSucursal] = useState("all");
  const [caja, setCaja] = useState("all");
  const [sucursales, setSucursales] = useState([]);     // ["Valle Dorado", ...]
  const [sucursalItems, setSucursalItems] = useState([]); // [{id, name, sort_order}]
  const [tab, setTab] = useState("dashboard");
  const [periodMode, setPeriodMode] = useState("week"); // "week" | "month" | "custom"
  const [customStart, setCustomStart] = useState(null);
  const [customEnd, setCustomEnd] = useState(null);

  const [stats, setStats] = useState(null);
  const [periodStats, setPeriodStats] = useState(null);
  const [audit, setAudit] = useState(null);
  const [sales, setSales] = useState([]);
  const [products, setProducts] = useState([]);
  const [users, setUsers] = useState([]);
  const [showPasswords, setShowPasswords] = useState(false);
  // Cajas históricas: la lista real de cajas que tuvieron ventas en la fecha
  // y sucursal seleccionadas. Se usa para el dropdown de "Caja" para que
  // refleje quién trabajó ESA FECHA (no las asignaciones actuales del admin).
  const [historicalCashiers, setHistoricalCashiers] = useState([]);

  // cajas disponibles: UNIÓN de (cajas con ventas históricas ese día en esa
  // sucursal) + (cajeros actualmente asignados a la sucursal). Así el admin
  // ve el histórico verdadero al revisar días pasados, y también ve cajas
  // recién asignadas que aún no venden hoy.
  const availableCajas = useMemo(() => {
    if (sucursal === "all") return [];
    const set = new Set();
    // 1) Históricas (verdad para fechas pasadas)
    historicalCashiers
      .filter((c) => c.sucursal === sucursal && c.caja && c.caja !== "—")
      .forEach((c) => set.add(c.caja));
    // 2) Actuales (para cajeros nuevos que aún no venden)
    users
      .filter((u) => u.role === "cashier" && u.sucursal === sucursal && u.caja_name)
      .forEach((u) => set.add(u.caja_name));
    return Array.from(set).sort();
  }, [sucursal, users, historicalCashiers]);

  useEffect(() => {
    api.get("/sucursales").then((r) => {
      setSucursales(r.data.sucursales);
      setSucursalItems(r.data.items || []);
    });
  }, []);

  // Cajas históricas de la fecha seleccionada (independiente del filtro de
  // caja). Necesario para que el dropdown de "Caja" refleje QUIÉN TRABAJÓ ese
  // día en esa sucursal, incluso si hoy ya no está asignado ahí.
  useEffect(() => {
    let cancelled = false;
    const fetchHist = async () => {
      const d = fmtDateAPI(date);
      try {
        // Nota: pasamos caja=all porque queremos TODAS las cajas del día,
        // no solo la seleccionada.
        const r = await api.get(`/audit/sales_count?date=${d}&caja=all`);
        if (!cancelled) setHistoricalCashiers(r.data.by_cashier || []);
      } catch {
        if (!cancelled) setHistoricalCashiers([]);
      }
    };
    fetchHist();
    return () => { cancelled = true; };
  }, [date]);

  useEffect(() => {
    let cancelled = false;
    const fetchAll = async () => {
      const d = fmtDateAPI(date);
      try {
        const passQuery = showPasswords ? "?include_passwords=true" : "";
        const calls = [
          api.get(`/dashboard?date=${d}&sucursal=${sucursal}&caja=${encodeURIComponent(caja)}`),
          api.get(`/sales?scope=date&date=${d}&sucursal=${sucursal}&caja=${encodeURIComponent(caja)}`),
          api.get("/products?include_inactive=true"),
          api.get(`/users${passQuery}`),
          api.get(`/audit/sales_count?date=${d}&sucursal=${sucursal}&caja=${encodeURIComponent(caja)}`),
        ];
        if (tab === "periodo") {
          const periodParams =
            periodMode === "custom"
              ? customStart && customEnd
                ? `period=custom&start_date=${fmtDateAPI(customStart)}&end_date=${fmtDateAPI(customEnd)}`
                : null
              : `period=${periodMode}&date=${d}`;
          if (periodParams) {
            calls.push(
              api.get(`/dashboard/period?${periodParams}&sucursal=${sucursal}&caja=${encodeURIComponent(caja)}`)
            );
          }
        }
        const results = await Promise.all(calls);
        if (cancelled) return;
        setStats(results[0].data);
        setSales(results[1].data);
        setProducts(results[2].data);
        setUsers(results[3].data);
        setAudit(results[4].data);
        if (tab === "periodo" && results[5]) setPeriodStats(results[5].data);
        else if (tab === "periodo") setPeriodStats(null);
      } catch {
        /* silent */
      }
    };
    fetchAll();
    const t = setInterval(fetchAll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [date, sucursal, caja, showPasswords, tab, periodMode, customStart, customEnd]);

  // Forzar refresh manual (después de cambios desde UI)
  const refresh = async () => {
    const d = fmtDateAPI(date);
    try {
      const passQuery = showPasswords ? "?include_passwords=true" : "";
      const [s, sl, p, us] = await Promise.all([
        api.get(`/dashboard?date=${d}&sucursal=${sucursal}&caja=${encodeURIComponent(caja)}`),
        api.get(`/sales?scope=date&date=${d}&sucursal=${sucursal}&caja=${encodeURIComponent(caja)}`),
        api.get("/products?include_inactive=true"),
        api.get(`/users${passQuery}`),
      ]);
      setStats(s.data);
      setSales(sl.data);
      setProducts(p.data);
      setUsers(us.data);
      // refresh sucursales list también
      const sucRes = await api.get("/sucursales");
      setSucursales(sucRes.data.sucursales);
      setSucursalItems(sucRes.data.items || []);
    } catch { /* silent */ }
  };

  const handleSucursalChange = (s) => {
    setSucursal(s);
    setCaja("all");
  };

  const logout = () => {
    clearSession();
    navigate("/", { replace: true });
  };

  const isToday = useMemo(() => fmtDateAPI(date) === fmtDateAPI(new Date()), [date]);

  return (
    <div className="min-h-screen bg-[#F4F4F5] pb-12">
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
          <button
            data-testid="btn-logout"
            onClick={logout}
            className="h-11 px-3 text-xs uppercase tracking-widest font-bold bg-zinc-900 text-white rounded-md tap-scale"
          >
            Salir
          </button>
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
          <SucursalSelect sucursales={sucursales} value={sucursal} onChange={handleSucursalChange} />
        </div>

        {/* Cajas (solo cuando hay sucursal específica) */}
        {sucursal !== "all" && availableCajas.length > 0 && (
          <div
            className="max-w-6xl mx-auto mt-2 flex flex-wrap items-center gap-2"
            data-testid="caja-filter"
          >
            <span className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">
              Caja:
            </span>
            <button
              data-testid="caja-all"
              onClick={() => setCaja("all")}
              className={`h-9 px-3 text-[11px] uppercase tracking-widest font-bold rounded-md border-2 tap-scale whitespace-nowrap ${
                caja === "all"
                  ? "bg-zinc-900 text-white border-zinc-900"
                  : "bg-white text-zinc-900 border-zinc-300"
              }`}
            >
              Todas
            </button>
            {availableCajas.map((c) => (
              <button
                key={c}
                data-testid={`caja-${c}`}
                onClick={() => setCaja(c)}
                className={`h-9 px-3 text-[11px] uppercase tracking-widest font-bold rounded-md border-2 tap-scale whitespace-nowrap ${
                  caja === c
                    ? "bg-[#006400] text-white border-[#006400]"
                    : "bg-white text-[#006400] border-[#006400]"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        )}

        <nav className="max-w-6xl mx-auto mt-3 flex gap-1.5 overflow-x-auto">
          {[
            ["dashboard", "Hoy"],
            ["periodo", "Periodo"],
            ["sales", "Ventas"],
            ["products", "Menú"],
            ["sucursales", "Sucursales"],
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
        {tab === "dashboard" && <DashboardTab stats={stats} audit={audit} sucursal={sucursal} />}
        {tab === "periodo" && (
          <PeriodTab
            stats={periodStats}
            periodMode={periodMode}
            setPeriodMode={setPeriodMode}
            date={date}
            sucursal={sucursal}
            caja={caja}
            customStart={customStart}
            setCustomStart={setCustomStart}
            customEnd={customEnd}
            setCustomEnd={setCustomEnd}
          />
        )}
        {tab === "sales" && <SalesTab sales={sales} />}
        {tab === "products" && <ProductsTab products={products} reload={refresh} />}
        {tab === "sucursales" && (
          <SucursalesTab items={sucursalItems} reload={refresh} />
        )}
        {tab === "users" && (
          <UsersTab
            users={users}
            sucursales={sucursales}
            reload={refresh}
            showPasswords={showPasswords}
            setShowPasswords={setShowPasswords}
          />
        )}
      </main>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Date picker
// ----------------------------------------------------------------------------
function DatePicker({ date, setDate, testid, placeholder }) {
  const [open, setOpen] = useState(false);
  const btnTestId = testid ? `btn-date-${testid}` : "btn-date-picker";
  const lblTestId = testid ? `label-date-${testid}` : "current-date-label";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          data-testid={btnTestId}
          className="h-11 px-3 inline-flex items-center gap-2 text-xs uppercase tracking-widest font-bold border-2 border-[#006400] text-[#006400] bg-white rounded-md tap-scale"
        >
          <span className="text-zinc-500">{placeholder || "Fecha"}</span>
          <span className="text-zinc-900" data-testid={lblTestId}>
            {date ? format(date, "dd MMM yyyy", { locale: es }) : "—"}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0 bg-white border-2 border-zinc-200 rounded-md">
        <Calendar
          mode="single"
          selected={date || undefined}
          onSelect={(d) => { if (d) { setDate(d); setOpen(false); } }}
          disabled={(d) => d > new Date()}
          initialFocus
          locale={es}
        />
      </PopoverContent>
    </Popover>
  );
}

function SucursalSelect({ sucursales, value, onChange }) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto" data-testid="sucursal-filter">
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
function DashboardTab({ stats, audit, sucursal }) {
  if (!stats) return <div className="text-zinc-500">Cargando…</div>;

  const pieData = Object.entries(stats.by_payment).map(([k, v]) => ({
    name: PAYMENT_LABELS[k] || k,
    value: v.amount,
  }));
  const topData = stats.top_products.slice(0, 8);

  const sucursalData = Object.entries(stats.by_sucursal || {}).map(
    ([k, v]) => ({ name: k, total: v.total, count: v.count })
  );

  const cajaData = Object.entries(stats.by_caja || {})
    .filter(([k]) => k !== "—")
    .map(([k, v]) => ({ name: k, total: v.total, count: v.count }));

  const orderTypeData = Object.entries(stats.by_order_type || {}).map(([k, v]) => ({
    key: k, name: ORDER_TYPE_LABELS[k] || k, total: v.total, count: v.count,
    delivery: v.delivery || 0,
  }));

  return (
    <div className="space-y-5" data-testid="dashboard-tab">
      {/* Panel de auditoría: conteo crudo de ventas + última venta + por cajero */}
      {audit && <AuditPanel audit={audit} />}

      {/* KPIs principales: lo esencial para arqueo */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <KpiCard label="Total cobrado" value={formatMXN(stats.grand_total)} testid="kpi-total" primary />
        <KpiCard label="# Ventas" value={stats.sales_count} testid="kpi-count" />
        <KpiCard label="Ticket promedio" value={formatMXN(stats.avg_ticket)} testid="kpi-avg-ticket" />
        <KpiCard
          label="Hora pico"
          value={stats.peak_hour ? stats.peak_hour.hour : "—"}
          sub={stats.peak_hour ? formatMXN(stats.peak_hour.total) : ""}
          testid="kpi-peak-hour"
        />
      </div>
      {/* Desglose del total: Subtotal + Propina + IVA + Envío = Total */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <KpiCard
          label="Productos (neto)"
          value={formatMXN(stats.grand_subtotal)}
          sub={`${stats.total_items} items`}
          testid="kpi-subtotal"
        />
        <KpiCard
          label="Propinas"
          value={formatMXN(stats.grand_tip)}
          testid="kpi-tips"
        />
        <KpiCard
          label="IVA cobrado"
          value={formatMXN(stats.grand_iva || 0)}
          sub={`${stats.invoice_count || 0} factura${(stats.invoice_count || 0) === 1 ? "" : "s"}`}
          testid="kpi-iva"
        />
        <KpiCard
          label="Envíos cobrados"
          value={formatMXN(stats.grand_delivery || 0)}
          testid="kpi-delivery"
        />
      </div>

      {/* Tipo de orden */}
      <section className="bg-white border-2 border-zinc-100 rounded-md p-4" data-testid="order-type-section">
        <h2 className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-3">
          Por tipo de orden
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {orderTypeData.map((o) => (
            <div
              key={o.key}
              data-testid={`ordertype-${o.key}`}
              className="border-2 border-zinc-100 rounded-md p-3"
              style={{ borderLeft: `6px solid ${ORDER_TYPE_COLORS[o.key]}` }}
            >
              <p className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">
                {o.name}
              </p>
              <p
                className="font-display text-2xl sm:text-3xl font-black leading-none mt-1"
                style={{ color: ORDER_TYPE_COLORS[o.key] }}
              >
                {formatMXN(o.total)}
              </p>
              <p className="text-sm text-zinc-600 mt-1">
                {o.count} {o.count === 1 ? "venta" : "ventas"}
              </p>
              {o.key === "domicilio" && (o.delivery || 0) > 0 && (
                <p className="text-xs uppercase tracking-widest font-bold text-amber-700 mt-2" data-testid="ordertype-delivery">
                  Envío cobrado:{" "}
                  <span className="text-amber-900 font-black">
                    {formatMXN(o.delivery)}
                  </span>
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Por método de pago */}
      <section className="bg-white border-2 border-zinc-100 rounded-md p-4">
        <h2 className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-3">
          Por método de pago
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {Object.entries(stats.by_payment).map(([k, v]) => {
            const ivaVal = v.iva || 0;
            const tipVal = v.tip || 0;
            const netoProductos = Math.max(0, (v.amount || 0) - tipVal - ivaVal);
            return (
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
                {/* Desglose dentro del bloque: productos / propina / IVA */}
                <div className="mt-2 space-y-0.5 text-[11px]">
                  <div className="flex justify-between text-zinc-500">
                    <span>Productos</span>
                    <span className="text-zinc-900 font-black" data-testid={`payment-net-${k}`}>
                      {formatMXN(netoProductos)}
                    </span>
                  </div>
                  {tipVal > 0 && (
                    <div className="flex justify-between text-zinc-500">
                      <span>Propina</span>
                      <span className="text-zinc-900 font-black" data-testid={`tip-${k}`}>
                        {formatMXN(tipVal)}
                      </span>
                    </div>
                  )}
                  {ivaVal > 0 && (
                    <div className="flex justify-between text-[#006400]">
                      <span>IVA (factura)</span>
                      <span className="font-black" data-testid={`payment-iva-${k}`}>
                        {formatMXN(ivaVal)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Por sucursal (vista global) */}
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
                  <Cell key={i} fill={SUCURSAL_COLORS[i % SUCURSAL_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </section>
      )}

      {/* Por caja (vista de sucursal) */}
      {sucursal !== "all" && cajaData.length > 0 && (
        <section className="bg-white border-2 border-zinc-100 rounded-md p-4" data-testid="by-caja-section">
          <h2 className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-3">
            Por caja · {sucursal}
          </h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={cajaData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fontWeight: 700 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => formatMXN(v)} />
              <Bar dataKey="total" fill="#006400" radius={[4, 4, 0, 0]} />
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

function KpiCard({ label, value, sub, testid, primary }) {
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
      {sub && <p className="text-xs text-zinc-500 mt-1 font-bold">{sub}</p>}
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
              <Th>Caja</Th>
              <Th>Tipo</Th>
              <Th>Productos</Th>
              <Th>Subtotal</Th>
              <Th>Propina</Th>
              <Th>IVA</Th>
              <Th>Envío</Th>
              <Th>Total</Th>
              <Th>Pago</Th>
            </tr>
          </thead>
          <tbody>
            {sales.map((s) => (
              <tr key={s.id} className="border-t border-zinc-100" data-testid={`sale-row-${s.id}`}>
                <Td>{fmtTime(s.created_at)}</Td>
                <Td className="font-bold">{s.sucursal || "—"}</Td>
                <Td className="text-xs">
                  <div className="font-bold">{s.caja || "—"}</div>
                  <div className="text-zinc-500">{s.cashier || ""}</div>
                </Td>
                <Td className="text-xs uppercase tracking-widest font-bold">
                  {ORDER_TYPE_LABELS[s.order_type] || "—"}
                  {s.order_type === "mesa" && s.mesa_number && (
                    <div className="text-zinc-500">#{s.mesa_number}</div>
                  )}
                </Td>
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
                <Td className="font-bold">
                  {s.iva > 0 ? (
                    <span data-testid={`sale-iva-${s.id}`} className="inline-flex items-center gap-1">
                      {formatMXN(s.iva)}
                      {s.invoice_requested && (
                        <span className="px-1.5 py-0.5 rounded bg-[#006400] text-white text-[9px] uppercase tracking-widest font-black">
                          Factura
                        </span>
                      )}
                    </span>
                  ) : "—"}
                </Td>
                <Td className="font-bold">
                  {s.delivery_fee > 0 ? (
                    <span data-testid={`sale-delivery-${s.id}`} className="text-amber-700">
                      {formatMXN(s.delivery_fee)}
                    </span>
                  ) : "—"}
                </Td>
                <Td className="font-display text-lg font-black text-[#006400]">{formatMXN(s.total)}</Td>
                <Td>
                  <span className="text-xs uppercase tracking-widest font-bold">
                    {PAYMENT_LABELS[s.payment_method]}
                  </span>
                  {s.payment_method === "efectivo" && s.change_given > 0 && (
                    <div className="text-[10px] text-zinc-500">
                      Cambio {formatMXN(s.change_given)}
                    </div>
                  )}
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
  } catch { return iso; }
}

// ----------------------------------------------------------------------------
// Products Tab
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
    if (e.pricing_mode !== undefined && e.pricing_mode !== (p.pricing_mode || "fixed")) payload.pricing_mode = e.pricing_mode;
    if (Object.keys(payload).length === 0) return toast.info("Sin cambios");
    setSavingId(p.id);
    try {
      await api.put(`/products/${p.id}`, payload);
      toast.success("Producto actualizado");
      setEdits((s) => { const c = { ...s }; delete c[p.id]; return c; });
      await reload();
    } catch { toast.error("Error al guardar"); }
    finally { setSavingId(null); }
  };

  const toggleActive = async (p) => {
    try {
      await api.put(`/products/${p.id}`, { active: !p.active });
      toast.success(p.active ? "Producto ocultado" : "Producto activado");
      await reload();
    } catch { toast.error("Error"); }
  };

  const [reordering, setReordering] = useState(false);
  const moveProduct = async (idx, dir) => {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= products.length) return;
    const reordered = [...products];
    [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];
    setReordering(true);
    try {
      await api.post("/products/reorder", { ids: reordered.map((p) => p.id) });
      await reload();
    } catch {
      toast.error("Error al reordenar");
    } finally {
      setReordering(false);
    }
  };

  const create = async () => {
    if (!creating.name) return toast.error("Nombre requerido");
    if (creating.pricing_mode === "fixed" && !creating.price) return toast.error("Precio requerido");
    try {
      await api.post("/products", {
        name: creating.name,
        price: Number(creating.price) || 0,
        category: creating.category,
        pricing_mode: creating.pricing_mode,
        sort_order: 999,
      });
      setCreating({ name: "", price: "", category: "comida", pricing_mode: "fixed" });
      toast.success("Producto creado");
      await reload();
    } catch { toast.error("Error al crear"); }
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
            placeholder={creating.pricing_mode === "variable" ? "Por peso" : "Precio"}
            disabled={creating.pricing_mode === "variable"}
            className="w-32 h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400] disabled:bg-zinc-100 disabled:text-zinc-400"
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
          <select
            data-testid="new-product-pricing-mode"
            value={creating.pricing_mode}
            onChange={(e) => setCreating((c) => ({ ...c, pricing_mode: e.target.value }))}
            className="h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400] bg-white"
          >
            <option value="fixed">Precio fijo</option>
            <option value="variable">Por peso/libre</option>
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
        {products.map((p, idx) => {
          const e = edits[p.id] || {};
          const nameVal = e.name !== undefined ? e.name : p.name;
          const priceVal = e.price !== undefined ? e.price : p.price;
          const catVal = e.category !== undefined ? e.category : (p.category || "comida");
          const pmVal = e.pricing_mode !== undefined ? e.pricing_mode : (p.pricing_mode || "fixed");
          return (
            <div
              key={p.id}
              data-testid={`product-edit-${p.id}`}
              className="p-3 flex flex-col sm:flex-row sm:items-center gap-2"
            >
              {/* Reorder controls */}
              <div className="flex sm:flex-col gap-1 shrink-0">
                <button
                  onClick={() => moveProduct(idx, -1)}
                  disabled={idx === 0 || reordering}
                  className="w-9 h-9 sm:w-7 sm:h-7 rounded-md bg-zinc-100 text-sm font-bold active:bg-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed tap-scale"
                  data-testid={`btn-move-up-${p.id}`}
                  title="Mover arriba"
                >
                  ↑
                </button>
                <button
                  onClick={() => moveProduct(idx, +1)}
                  disabled={idx === products.length - 1 || reordering}
                  className="w-9 h-9 sm:w-7 sm:h-7 rounded-md bg-zinc-100 text-sm font-bold active:bg-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed tap-scale"
                  data-testid={`btn-move-down-${p.id}`}
                  title="Mover abajo"
                >
                  ↓
                </button>
              </div>
              <input
                value={nameVal}
                onChange={(ev) => setField(p.id, "name", ev.target.value)}
                className="flex-1 h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
                data-testid={`edit-name-${p.id}`}
              />
              <input
                type="number"
                value={pmVal === "variable" ? "" : priceVal}
                disabled={pmVal === "variable"}
                onChange={(ev) => setField(p.id, "price", ev.target.value)}
                className="w-28 h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400] disabled:bg-zinc-100 disabled:text-zinc-400"
                placeholder={pmVal === "variable" ? "Por peso" : "Precio"}
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
              <select
                value={pmVal}
                onChange={(ev) => setField(p.id, "pricing_mode", ev.target.value)}
                className="h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400] bg-white"
                data-testid={`edit-pricing-mode-${p.id}`}
              >
                <option value="fixed">Precio fijo</option>
                <option value="variable">Por peso/libre</option>
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
// Users Tab – CRUD completo
// ----------------------------------------------------------------------------
function UsersTab({ users, sucursales, reload, showPasswords, setShowPasswords }) {
  const [creating, setCreating] = useState({
    username: "", password: "", role: "cashier", sucursal: "", caja_name: "",
  });
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(null);
  const defaultSucursal = sucursales[0] || "";
  const effectiveCreatingSucursal = creating.sucursal || defaultSucursal;
  // Si no se especifica caja_name, usar el username (cobrador)
  const effectiveCajaName = creating.caja_name.trim() || creating.username.trim() || "";
  const adminCount = users.filter((u) => u.role === "admin").length;

  const setField = (id, k, v) => setDrafts((d) => ({ ...d, [id]: { ...(d[id] || {}), [k]: v } }));

  const create = async () => {
    if (!creating.username.trim() || !creating.password.trim()) {
      return toast.error("Usuario y contraseña requeridos");
    }
    if (creating.role === "cashier" && !effectiveCreatingSucursal) {
      return toast.error("Selecciona sucursal");
    }
    try {
      await api.post("/users", {
        username: creating.username.trim(),
        password: creating.password,
        role: creating.role,
        sucursal: creating.role === "cashier" ? effectiveCreatingSucursal : null,
        caja_name: effectiveCajaName || creating.username.trim(),
      });
      toast.success(`Usuario "${creating.username}" creado`);
      setCreating({
        username: "", password: "", role: "cashier",
        sucursal: "", caja_name: "",
      });
      await reload();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Error al crear");
    }
  };

  const save = async (u) => {
    const d = drafts[u.id] || {};
    const payload = {};
    if (d.username !== undefined && d.username.trim() !== u.username) payload.username = d.username.trim();
    if (d.password) payload.password = d.password;
    if (d.sucursal !== undefined && d.sucursal !== u.sucursal) payload.sucursal = d.sucursal;
    if (d.caja_name !== undefined && d.caja_name !== u.caja_name) payload.caja_name = d.caja_name;
    if (Object.keys(payload).length === 0) return toast.info("Sin cambios");
    setBusy(u.id);
    try {
      await api.put(`/users/${u.id}`, payload);
      toast.success("Usuario actualizado");
      setDrafts((s) => { const c = { ...s }; delete c[u.id]; return c; });
      await reload();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Error al guardar");
    } finally { setBusy(null); }
  };

  const remove = async (u) => {
    if (!window.confirm(`¿Eliminar al usuario "${u.username}"?`)) return;
    setBusy(u.id);
    try {
      await api.delete(`/users/${u.id}`);
      toast.success("Usuario eliminado");
      await reload();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Error al eliminar");
    } finally { setBusy(null); }
  };

  return (
    <div className="space-y-4" data-testid="users-tab">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">
          {users.length} usuarios
        </p>
        <button
          data-testid="btn-toggle-passwords"
          onClick={() => setShowPasswords((v) => !v)}
          className={`h-10 px-3 text-[11px] uppercase tracking-widest font-bold rounded-md border-2 tap-scale ${
            showPasswords
              ? "bg-[#006400] text-white border-[#006400]"
              : "bg-white text-[#006400] border-[#006400]"
          }`}
        >
          {showPasswords ? "Ocultar contraseñas" : "Mostrar contraseñas"}
        </button>
      </div>

      {/* Crear nuevo */}
      <div className="bg-white border-2 border-zinc-100 rounded-md p-4 space-y-3">
        <p className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">
          Crear nuevo usuario
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2">
          <input
            data-testid="new-user-username"
            value={creating.username}
            onChange={(e) => setCreating((c) => ({ ...c, username: e.target.value }))}
            placeholder="Usuario"
            className="h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
          />
          <input
            data-testid="new-user-password"
            type="text"
            value={creating.password}
            onChange={(e) => setCreating((c) => ({ ...c, password: e.target.value }))}
            placeholder="Contraseña"
            className="h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
          />
          <select
            data-testid="new-user-role"
            value={creating.role}
            onChange={(e) => setCreating((c) => ({ ...c, role: e.target.value }))}
            className="h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400] bg-white"
          >
            <option value="cashier">Cajero</option>
            <option value="admin">Administrador</option>
          </select>
          <select
            data-testid="new-user-sucursal"
            value={effectiveCreatingSucursal}
            onChange={(e) => setCreating((c) => ({ ...c, sucursal: e.target.value }))}
            disabled={creating.role !== "cashier"}
            className="h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400] bg-white disabled:bg-zinc-100 disabled:text-zinc-400"
          >
            {sucursales.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input
            data-testid="new-user-caja"
            value={creating.caja_name}
            onChange={(e) => setCreating((c) => ({ ...c, caja_name: e.target.value }))}
            placeholder={creating.username ? `Cobrador (${creating.username})` : "Cobrador"}
            className="h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
          />
          <button
            data-testid="btn-create-user"
            onClick={create}
            className="h-12 px-4 rounded-md bg-[#006400] text-white text-sm uppercase tracking-widest font-bold active:bg-[#228B22] tap-scale"
          >
            Crear
          </button>
        </div>
      </div>

      {/* Lista de usuarios */}
      <div className="bg-white border-2 border-zinc-100 rounded-md divide-y divide-zinc-100">
        {users.map((u) => {
          const d = drafts[u.id] || {};
          const uname = d.username !== undefined ? d.username : u.username;
          const sucVal = d.sucursal !== undefined ? d.sucursal : (u.sucursal || "");
          const cajaVal = d.caja_name !== undefined ? d.caja_name : (u.caja_name || "Caja 1");
          return (
            <div
              key={u.id}
              className="p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2 items-center"
              data-testid={`user-row-${u.username}`}
            >
              <div>
                <input
                  value={uname}
                  onChange={(e) => setField(u.id, "username", e.target.value)}
                  className="w-full h-11 px-2 text-sm font-black border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
                  data-testid={`edit-username-${u.username}`}
                />
                <p className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 mt-1">
                  {u.role === "admin" ? "Administrador" : "Cajero"}
                </p>
              </div>
              <input
                type="text"
                placeholder="Nueva contraseña"
                value={d.password !== undefined ? d.password : (showPasswords ? (u.password || "") : "")}
                onChange={(e) => setField(u.id, "password", e.target.value)}
                className="h-11 px-2 text-sm font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400] font-mono"
                data-testid={`edit-password-${u.username}`}
              />
              {u.role === "cashier" ? (
                <select
                  value={sucVal}
                  onChange={(e) => setField(u.id, "sucursal", e.target.value)}
                  className="h-11 px-2 text-sm font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400] bg-white"
                  data-testid={`edit-sucursal-${u.username}`}
                >
                  {sucursales.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : <div />}
              <input
                value={cajaVal}
                onChange={(e) => setField(u.id, "caja_name", e.target.value)}
                placeholder="Caja"
                className="h-11 px-2 text-sm font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
                data-testid={`edit-caja-${u.username}`}
              />
              <button
                onClick={() => save(u)}
                disabled={busy === u.id}
                className="h-11 px-3 rounded-md bg-[#006400] text-white text-xs uppercase tracking-widest font-black active:bg-[#228B22] disabled:bg-zinc-400 tap-scale"
                data-testid={`btn-save-user-${u.username}`}
              >
                Guardar
              </button>
              <button
                onClick={() => remove(u)}
                disabled={busy === u.id || (u.role === "admin" && adminCount <= 1)}
                title={u.role === "admin" && adminCount <= 1 ? "No se puede eliminar el único administrador" : ""}
                className="h-11 px-3 rounded-md border-2 border-red-600 text-red-600 text-xs uppercase tracking-widest font-black active:bg-red-50 disabled:opacity-30 disabled:cursor-not-allowed tap-scale"
                data-testid={`btn-delete-user-${u.username}`}
              >
                Eliminar
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ----------------------------------------------------------------------------
// Sucursales Tab – CRUD de sucursales
// ----------------------------------------------------------------------------
function SucursalesTab({ items, reload }) {
  const [newName, setNewName] = useState("");
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(null);

  const create = async () => {
    if (!newName.trim()) return toast.error("Nombre requerido");
    try {
      await api.post("/sucursales", { name: newName.trim() });
      toast.success(`Sucursal "${newName}" creada`);
      setNewName("");
      await reload();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Error al crear");
    }
  };

  const save = async (s) => {
    const d = drafts[s.id] || {};
    if (!d.name || d.name.trim() === s.name) return toast.info("Sin cambios");
    setBusy(s.id);
    try {
      await api.put(`/sucursales/${s.id}`, { name: d.name.trim() });
      toast.success("Sucursal actualizada");
      setDrafts((st) => { const c = { ...st }; delete c[s.id]; return c; });
      await reload();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Error al guardar");
    } finally { setBusy(null); }
  };

  const remove = async (s) => {
    if (!window.confirm(`¿Eliminar la sucursal "${s.name}"?\nDebe no tener usuarios asignados.`)) return;
    setBusy(s.id);
    try {
      await api.delete(`/sucursales/${s.id}`);
      toast.success("Sucursal eliminada");
      await reload();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Error al eliminar");
    } finally { setBusy(null); }
  };

  return (
    <div className="space-y-4" data-testid="sucursales-tab">
      <div className="bg-white border-2 border-zinc-100 rounded-md p-4">
        <p className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-2">
          Nueva sucursal
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            data-testid="new-sucursal-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Ej. Centro"
            className="flex-1 h-12 px-3 text-base font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
          />
          <button
            data-testid="btn-create-sucursal"
            onClick={create}
            className="h-12 px-4 rounded-md bg-[#006400] text-white text-sm uppercase tracking-widest font-bold active:bg-[#228B22] tap-scale"
          >
            Crear
          </button>
        </div>
      </div>

      <div className="bg-white border-2 border-zinc-100 rounded-md divide-y divide-zinc-100">
        {items.map((s) => {
          const d = drafts[s.id] || {};
          const nameVal = d.name !== undefined ? d.name : s.name;
          return (
            <div
              key={s.id}
              data-testid={`sucursal-row-${s.name}`}
              className="p-3 flex flex-col sm:flex-row sm:items-center gap-2"
            >
              <input
                value={nameVal}
                onChange={(e) => setDrafts((st) => ({ ...st, [s.id]: { ...(st[s.id] || {}), name: e.target.value } }))}
                className="flex-1 h-12 px-3 text-base font-black border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
                data-testid={`edit-sucursal-name-${s.name}`}
              />
              <button
                onClick={() => save(s)}
                disabled={busy === s.id}
                className="h-12 px-4 rounded-md bg-[#006400] text-white text-sm uppercase tracking-widest font-bold active:bg-[#228B22] disabled:bg-zinc-400 tap-scale"
                data-testid={`btn-save-sucursal-${s.name}`}
              >
                Guardar
              </button>
              <button
                onClick={() => remove(s)}
                disabled={busy === s.id}
                className="h-12 px-4 rounded-md border-2 border-red-600 text-red-600 text-sm uppercase tracking-widest font-bold active:bg-red-50 disabled:opacity-50 tap-scale"
                data-testid={`btn-delete-sucursal-${s.name}`}
              >
                Eliminar
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Period Tab – Dashboard semanal/mensual + exportar CSV
// ----------------------------------------------------------------------------
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;

function PeriodTab({ stats, periodMode, setPeriodMode, date, sucursal, caja, customStart, setCustomStart, customEnd, setCustomEnd }) {
  const isCustom = periodMode === "custom";
  const customReady = isCustom && customStart && customEnd;

  const downloadCSV = () => {
    let url;
    if (isCustom) {
      if (!customReady) return;
      url = `${BACKEND_URL}/api/reports/csv?period=custom&start_date=${fmtDateAPI(customStart)}&end_date=${fmtDateAPI(customEnd)}&sucursal=${encodeURIComponent(sucursal)}&caja=${encodeURIComponent(caja)}`;
    } else {
      const d = fmtDateAPI(date);
      url = `${BACKEND_URL}/api/reports/csv?period=${periodMode}&date=${d}&sucursal=${encodeURIComponent(sucursal)}&caja=${encodeURIComponent(caja)}`;
    }
    window.open(url, "_blank");
  };

  return (
    <div className="space-y-5" data-testid="period-tab">
      {/* Toggle periodo + CSV */}
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="inline-flex rounded-md border-2 border-[#006400] overflow-hidden" data-testid="period-toggle">
          {[
            ["week", "Semanal"],
            ["month", "Mensual"],
            ["custom", "Personalizado"],
          ].map(([k, label]) => (
            <button
              key={k}
              data-testid={`period-${k}`}
              onClick={() => setPeriodMode(k)}
              className={`h-11 px-4 text-xs uppercase tracking-widest font-black tap-scale ${
                periodMode === k ? "bg-[#006400] text-white" : "bg-white text-[#006400]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {stats && (
            <p className="text-xs uppercase tracking-widest font-bold text-zinc-500" data-testid="period-range">
              {stats.start} → {stats.end}
            </p>
          )}
          <button
            data-testid="btn-export-csv"
            onClick={downloadCSV}
            disabled={isCustom && !customReady}
            className="h-11 px-4 rounded-md bg-zinc-900 text-white text-xs uppercase tracking-widest font-black tap-scale disabled:bg-zinc-300 disabled:cursor-not-allowed"
          >
            Exportar CSV
          </button>
        </div>
      </div>

      {/* Selectores de rango personalizado */}
      {isCustom && (
        <div className="flex flex-wrap items-end gap-3 bg-amber-50 border-2 border-amber-200 rounded-md px-3 py-2" data-testid="custom-range-area">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-widest font-black text-amber-800">Desde</span>
            <DatePicker date={customStart} setDate={setCustomStart} testid="custom-start" placeholder="Inicio" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-widest font-black text-amber-800">Hasta</span>
            <DatePicker date={customEnd} setDate={setCustomEnd} testid="custom-end" placeholder="Fin" />
          </div>
          {!customReady && (
            <p className="text-[11px] font-bold text-amber-700">Selecciona ambas fechas para ver el periodo.</p>
          )}
        </div>
      )}

      {!stats ? (
        <div className="text-zinc-500" data-testid="period-empty">
          {isCustom && !customReady ? "Selecciona un rango de fechas." : "Cargando…"}
        </div>
      ) : (
        <PeriodStatsBody stats={stats} periodMode={periodMode} />
      )}
    </div>
  );
}

function PeriodStatsBody({ stats, periodMode }) {
  const periodLabel =
    periodMode === "week" ? "semanal" : periodMode === "month" ? "mensual" : "rango";
  return (
    <>
      {/* KPIs principales */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <KpiCard label={`Total ${periodLabel}`}
                 value={formatMXN(stats.grand_total)} testid="period-kpi-total" primary />
        <KpiCard label="# Ventas" value={stats.sales_count} testid="period-kpi-count" />
        <KpiCard label="Promedio diario" value={formatMXN(stats.avg_daily)} testid="period-kpi-daily" />
        <KpiCard label="Ticket promedio" value={formatMXN(stats.avg_ticket)} testid="period-kpi-avg-ticket" />
      </div>
      {/* Desglose: Subtotal + Propina + IVA + Envío = Total */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <KpiCard
          label="Productos (neto)"
          value={formatMXN(stats.grand_subtotal || 0)}
          sub={`${stats.total_items} items`}
          testid="period-kpi-subtotal"
        />
        <KpiCard label="Propinas" value={formatMXN(stats.grand_tip)} testid="period-kpi-tips" />
        <KpiCard
          label="IVA cobrado"
          value={formatMXN(stats.grand_iva || 0)}
          sub={`${stats.invoice_count || 0} factura${(stats.invoice_count || 0) === 1 ? "" : "s"}`}
          testid="period-kpi-iva"
        />
        <KpiCard
          label="Envíos cobrados"
          value={formatMXN(stats.grand_delivery || 0)}
          testid="period-kpi-delivery"
        />
      </div>

      {/* Highlights */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="period-highlights">
        <HighlightCard
          label="Día más fuerte"
          value={stats.best_day ? `${stats.best_day.label}` : "—"}
          sub={stats.best_day ? `${formatMXN(stats.best_day.total)} · ${stats.best_day.count} ventas` : ""}
          testid="best-day"
          color="#006400"
        />
        <HighlightCard
          label="Mejor hora"
          value={stats.best_day_hour ? `${stats.best_day_hour.hour}` : "—"}
          sub={stats.best_day_hour ? `${stats.best_day_hour.date} · ${formatMXN(stats.best_day_hour.total)}` : ""}
          testid="best-day-hour"
          color="#0369A1"
        />
        <HighlightCard
          label="Mejor día de semana"
          value={stats.best_dow ? stats.best_dow.name : "—"}
          sub={stats.best_dow ? `${formatMXN(stats.best_dow.total)} · ${stats.best_dow.count} ventas` : ""}
          testid="best-dow"
          color="#a16207"
        />
      </section>

      {/* Ventas por día */}
      <section className="bg-white border-2 border-zinc-100 rounded-md p-4" data-testid="chart-by-day">
        <h3 className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-3">
          Ventas por día
        </h3>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={stats.by_day}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
            <XAxis dataKey="label" tick={{ fontSize: 10, fontWeight: 700 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v) => formatMXN(v)} />
            <Bar dataKey="total" fill="#006400" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </section>

      {/* Por día de la semana */}
      <section className="bg-white border-2 border-zinc-100 rounded-md p-4" data-testid="chart-by-dow">
        <h3 className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-3">
          Por día de la semana
        </h3>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={stats.by_day_of_week}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
            <XAxis dataKey="name" tick={{ fontSize: 11, fontWeight: 700 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v) => formatMXN(v)} />
            <Bar dataKey="total" fill="#228B22" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </section>

      {/* Por hora del día (agregado) */}
      <section className="bg-white border-2 border-zinc-100 rounded-md p-4" data-testid="chart-by-hour">
        <h3 className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-3">
          Distribución por hora del día (agregada)
        </h3>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={stats.by_hour}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
            <XAxis dataKey="hour" tick={{ fontSize: 10 }} interval={1} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v) => formatMXN(v)} />
            <Line type="monotone" dataKey="total" stroke="#006400" strokeWidth={3} dot={{ r: 3, fill: "#006400" }} />
          </LineChart>
        </ResponsiveContainer>
      </section>

      {/* Productos top + por sucursal */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border-2 border-zinc-100 rounded-md p-4">
          <h3 className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-3">
            Productos más vendidos
          </h3>
          {stats.top_products.length === 0 ? (
            <EmptyChart />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={stats.top_products.slice(0, 10)}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
                <XAxis dataKey="name" tick={{ fontSize: 10, fontWeight: 700 }}
                       interval={0} angle={-20} textAnchor="end" height={70} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="quantity" fill="#006400" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="bg-white border-2 border-zinc-100 rounded-md p-4">
          <h3 className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-3">
            Por sucursal · Periodo
          </h3>
          {Object.values(stats.by_sucursal || {}).every((v) => v.total === 0) ? (
            <EmptyChart />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={Object.entries(stats.by_sucursal).map(([k, v]) => ({ name: k, total: v.total }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fontWeight: 700 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => formatMXN(v)} />
                <Bar dataKey="total" radius={[4, 4, 0, 0]}>
                  {Object.keys(stats.by_sucursal).map((_, i) => (
                    <Cell key={i} fill={SUCURSAL_COLORS[i % SUCURSAL_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>
    </>
  );
}

function HighlightCard({ label, value, sub, testid, color }) {
  return (
    <div
      data-testid={testid}
      className="bg-white border-2 border-zinc-100 rounded-md p-4"
      style={{ borderLeft: `6px solid ${color}` }}
    >
      <p className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">{label}</p>
      <p
        className="font-display text-3xl sm:text-4xl font-black leading-none mt-1"
        style={{ color }}
      >
        {value}
      </p>
      {sub && <p className="text-sm text-zinc-600 mt-1">{sub}</p>}
    </div>
  );
}


// ----------------------------------------------------------------------------
// AuditPanel — verificación cruda de ventas registradas, con desglose por
// cajero (caja + cashier) y "última venta hace X". Sirve para reconciliar
// contra el arqueo físico y detectar silencios sospechosos en alguna caja.
// ----------------------------------------------------------------------------
function AuditPanel({ audit }) {
  const lastSale = audit.by_cashier
    .map((c) => c.last_at)
    .filter(Boolean)
    .sort()
    .reverse()[0];

  const minutesSince = (iso) => {
    if (!iso) return null;
    const diffMs = Date.now() - new Date(iso).getTime();
    return Math.max(0, Math.floor(diffMs / 60000));
  };
  const lastMin = minutesSince(lastSale);
  // Si han pasado > 60 min desde la última venta en horario laboral, alerta.
  const isStale = lastMin !== null && lastMin > 60;

  return (
    <section
      data-testid="audit-panel"
      className="bg-white border-2 border-zinc-100 rounded-md p-3 sm:p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div>
          <h3 className="text-[10px] uppercase tracking-widest font-black text-zinc-500">
            Auditoría · conteo crudo de ventas
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            Compara estos números contra tu arqueo físico para detectar diferencias.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest font-black">
          <span
            data-testid="audit-last-sale"
            className={`px-2.5 py-1.5 rounded-md ${
              isStale
                ? "bg-red-50 text-red-700 border border-red-200"
                : "bg-emerald-50 text-emerald-800 border border-emerald-200"
            }`}
          >
            <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                  style={{ background: isStale ? "#dc2626" : "#10b981" }} />
            Última venta:{" "}
            {lastMin === null
              ? "—"
              : lastMin === 0
              ? "hace < 1 min"
              : `hace ${lastMin} min`}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        <div className="bg-zinc-50 rounded-md p-2.5">
          <p className="text-[10px] uppercase tracking-widest font-black text-zinc-500">
            Ventas registradas
          </p>
          <p
            className="font-display text-2xl sm:text-3xl font-black text-[#006400] mt-0.5"
            data-testid="audit-sales-count"
          >
            {audit.sales_count}
          </p>
        </div>
        <div className="bg-zinc-50 rounded-md p-2.5">
          <p className="text-[10px] uppercase tracking-widest font-black text-zinc-500">
            Total cobrado
          </p>
          <p
            className="font-display text-2xl sm:text-3xl font-black text-[#006400] mt-0.5"
            data-testid="audit-grand-total"
          >
            {formatMXN(audit.grand_total)}
          </p>
        </div>
        <div className="bg-zinc-50 rounded-md p-2.5">
          <p className="text-[10px] uppercase tracking-widest font-black text-zinc-500">
            Cajeros activos
          </p>
          <p className="font-display text-2xl sm:text-3xl font-black text-[#006400] mt-0.5">
            {audit.by_cashier.length}
          </p>
        </div>
        <div className="bg-zinc-50 rounded-md p-2.5">
          <p className="text-[10px] uppercase tracking-widest font-black text-zinc-500">
            Fecha
          </p>
          <p className="text-base font-black text-zinc-900 mt-0.5">{audit.date}</p>
        </div>
      </div>

      {audit.by_cashier.length > 0 && (
        <div className="overflow-x-auto" data-testid="audit-by-cashier">
          <table className="w-full text-xs sm:text-sm">
            <thead className="bg-zinc-50">
              <tr className="text-left">
                <th className="px-2.5 py-1.5 text-[10px] uppercase tracking-widest font-black text-zinc-500">Sucursal</th>
                <th className="px-2.5 py-1.5 text-[10px] uppercase tracking-widest font-black text-zinc-500">Caja</th>
                <th className="px-2.5 py-1.5 text-[10px] uppercase tracking-widest font-black text-zinc-500">Cajero</th>
                <th className="px-2.5 py-1.5 text-[10px] uppercase tracking-widest font-black text-zinc-500"># Ventas</th>
                <th className="px-2.5 py-1.5 text-[10px] uppercase tracking-widest font-black text-zinc-500">Total</th>
                <th className="px-2.5 py-1.5 text-[10px] uppercase tracking-widest font-black text-zinc-500">Primera</th>
                <th className="px-2.5 py-1.5 text-[10px] uppercase tracking-widest font-black text-zinc-500">Última</th>
              </tr>
            </thead>
            <tbody>
              {audit.by_cashier.map((c, i) => (
                <tr
                  key={`${c.sucursal}-${c.caja}-${c.cashier}-${i}`}
                  data-testid={`audit-row-${i}`}
                  className="border-t border-zinc-100"
                >
                  <td className="px-2.5 py-1.5 text-zinc-700">{c.sucursal || "—"}</td>
                  <td className="px-2.5 py-1.5 font-black">{c.caja}</td>
                  <td className="px-2.5 py-1.5">{c.cashier}</td>
                  <td className="px-2.5 py-1.5 font-black">{c.count}</td>
                  <td className="px-2.5 py-1.5 font-black">{formatMXN(c.total)}</td>
                  <td className="px-2.5 py-1.5 text-zinc-500">{fmtTime(c.first_at)}</td>
                  <td className="px-2.5 py-1.5 text-zinc-500">{fmtTime(c.last_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
