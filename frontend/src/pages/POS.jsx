/**
 * POS – Punto de Venta v5
 * Cambios v5:
 *  - Toggle "Factura (+16% IVA)" cuando el pago involucra tarjeta.
 *  - Input "Envío" cuando el tipo de orden es Domicilio (suma al total).
 *  - 3 opciones de pago dividido: Efectivo+Tarjeta, Efectivo+Transf., Tarjeta+Transf.
 *  - Pago dividido envía amounts cuya suma == total (subtotal+tip+iva+envío).
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api, formatMXN, PAYMENT_LABELS, newClientId, pingBackend, fetchMe } from "@/lib/api";
import {
  enqueueSale,
  flushQueue,
  getPendingCount,
  getQueueDetails,
  startAutoFlush,
} from "@/lib/salesQueue";
import { getSession, setSession, clearSession } from "@/lib/auth";

const PAYMENTS = ["efectivo", "transferencia", "tarjeta"];
const ORDER_TYPES = [
  { value: "mesa", label: "Mesa" },
  { value: "llevar", label: "Llevar" },
  { value: "domicilio", label: "Domicilio" },
];
const TIP_PERCENTS = [5, 10, 15, 20];
const VALLE_BARRAS = ["B1", "B2", "B3"];

const SPLIT_TYPES = [
  { value: "cash-card", methods: ["efectivo", "tarjeta"], label: "Efectivo + Tarjeta" },
  { value: "cash-transfer", methods: ["efectivo", "transferencia"], label: "Efectivo + Transferencia" },
  { value: "card-transfer", methods: ["tarjeta", "transferencia"], label: "Tarjeta + Transferencia" },
];

export default function POS() {
  const navigate = useNavigate();
  const session = getSession();
  const sucursal =
    session?.user?.sucursal ||
    (session?.user?.role === "admin" ? "Valle Dorado" : null);
  const cashier = session?.user?.username;
  const caja = session?.user?.caja_name || cashier || "Caja 1";

  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({});
  const [varItems, setVarItems] = useState([]);
  const [payment, setPayment] = useState("efectivo");
  const [tipPercent, setTipPercent] = useState(null);
  const [tipManual, setTipManual] = useState("");
  const [orderType, setOrderType] = useState("mesa");
  const [mesaNumber, setMesaNumber] = useState("");
  const [cashReceived, setCashReceived] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showDetail, setShowDetail] = useState(true);

  // Nuevos: factura y envío
  const [requiresInvoice, setRequiresInvoice] = useState(false);
  const [deliveryFee, setDeliveryFee] = useState("");

  // Split payment state
  const [splitMode, setSplitMode] = useState(false);
  const [splitType, setSplitType] = useState("cash-card");
  const [splitAmountA, setSplitAmountA] = useState("");
  const [splitTip, setSplitTip] = useState("");
  const [splitCashReceived, setSplitCashReceived] = useState("");

  // Ventas pendientes de sincronizar (red intermitente)
  const [pendingCount, setPendingCount] = useState(getPendingCount());
  const [showPending, setShowPending] = useState(false);
  // Estado de conexión: "online" | "offline" | "checking"
  const [connStatus, setConnStatus] = useState("checking");
  // Caché desde localStorage (si el backend está caído, mostramos lo último bueno)
  const [usingCache, setUsingCache] = useState(false);

  useEffect(() => {
    // Cola de ventas pendientes: reintentos automáticos con backoff, online, visibility.
    const stop = startAutoFlush(({ pending, synced }) => {
      setPendingCount(pending);
      if (synced > 0) {
        toast.success(`Sincronizadas ${synced} venta${synced === 1 ? "" : "s"} pendiente${synced === 1 ? "" : "s"}`);
      }
    });
    return stop;
  }, []);

  // Refresco periódico del usuario: si el admin cambia la sucursal/caja del cajero,
  // el POS se entera sin necesidad de re-login (cada 60s + al montar + al volver a visible).
  useEffect(() => {
    if (!cashier) return;
    let mounted = true;
    const syncUser = async () => {
      const fresh = await fetchMe(cashier);
      if (!mounted || !fresh) return;
      const s = getSession();
      if (!s?.user) return;
      const oldSuc = s.user.sucursal;
      const oldCaja = s.user.caja_name;
      const newSuc = fresh.sucursal ?? null;
      const newCaja = fresh.caja_name ?? "Caja 1";
      const changed = oldSuc !== newSuc || oldCaja !== newCaja;
      if (!changed) return;
      // Guardamos sesión actualizada y avisamos al cajero.
      setSession({ ...s, user: { ...s.user, ...fresh } });
      if (oldSuc !== newSuc) {
        toast.info(`Tu sucursal cambió a: ${newSuc || "—"}`, { duration: 6000 });
      }
      if (oldCaja !== newCaja && oldSuc === newSuc) {
        toast.info(`Tu caja cambió a: ${newCaja}`, { duration: 6000 });
      }
      // Recargamos para que TODA la UI (header, envío al backend, filtros) tome
      // los nuevos valores desde la fuente única (session).
      setTimeout(() => window.location.reload(), 800);
    };
    syncUser();
    const t = setInterval(syncUser, 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") syncUser(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [cashier]);

  useEffect(() => {
    // Carga de productos con caché de respaldo:
    // - Éxito → guarda en localStorage como "última versión buena"
    // - Falla → si hay caché, la usa; si no, muestra error
    const PRODUCTS_KEY = "pos_products_cache_v1";
    const loadProducts = async () => {
      try {
        const r = await api.get("/products");
        setProducts(r.data);
        setUsingCache(false);
        setConnStatus("online");
        try { localStorage.setItem(PRODUCTS_KEY, JSON.stringify(r.data)); } catch { /* quota */ }
        // Limpia el carrito de IDs de productos que ya no existen (renombrados
        // o borrados por el admin). Evita "totales fantasma" que no se ven
        // en los contadores pero sí en el total.
        const validIds = new Set(r.data.map((p) => p.id));
        setCart((c) => {
          const cleaned = {};
          let dropped = 0;
          for (const [pid, qty] of Object.entries(c || {})) {
            if (validIds.has(pid) && Number(qty) > 0) cleaned[pid] = qty;
            else if (Number(qty) > 0) dropped += 1;
          }
          if (dropped > 0) {
            toast.warning(
              `Se limpiaron ${dropped} producto(s) obsoletos del carrito`,
              { duration: 4000 },
            );
          }
          return cleaned;
        });
      } catch {
        setConnStatus("offline");
        try {
          const raw = localStorage.getItem(PRODUCTS_KEY);
          if (raw) {
            const cached = JSON.parse(raw);
            setProducts(cached);
            setUsingCache(true);
          } else {
            toast.error("No se pudieron cargar los productos");
          }
        } catch {
          toast.error("No se pudieron cargar los productos");
        }
      }
    };
    loadProducts();
    const t = setInterval(loadProducts, 30000);
    return () => clearInterval(t);
  }, []);

  // Health check independiente para el indicador de conexión.
  useEffect(() => {
    let mounted = true;
    const check = async () => {
      const ok = await pingBackend();
      if (!mounted) return;
      setConnStatus(ok ? "online" : "offline");
    };
    check();
    const t = setInterval(check, 15000);
    return () => { mounted = false; clearInterval(t); };
  }, []);

  const lineItems = useMemo(() => {
    const fixed = products
      .filter((p) => p.pricing_mode !== "variable" && (cart[p.id] || 0) > 0)
      .map((p) => ({
        product_id: p.id,
        name: p.name,
        price: p.price,
        quantity: cart[p.id],
        subtotal: p.price * cart[p.id],
        kind: "fixed",
      }));
    const variable = varItems.map((v) => ({
      line_id: v.line_id,
      product_id: v.product_id,
      name: v.name,
      price: v.price,
      quantity: 1,
      subtotal: v.price,
      kind: "variable",
    }));
    return [...fixed, ...variable];
  }, [cart, products, varItems]);

  const subtotal = lineItems.reduce((s, i) => s + i.subtotal, 0);

  // Métodos del split actual
  const splitMethods = useMemo(
    () => SPLIT_TYPES.find((s) => s.value === splitType)?.methods || ["efectivo", "tarjeta"],
    [splitType]
  );
  const splitHasCash = splitMethods.includes("efectivo");
  const splitHasCard = splitMethods.includes("tarjeta");

  // ¿Pago involucra tarjeta? (controla visibilidad de la opción Factura)
  const cardInvolved = splitMode ? splitHasCard : payment === "tarjeta";

  // Envío
  const deliveryNum =
    orderType === "domicilio" ? Math.max(0, Number(deliveryFee) || 0) : 0;

  // --- Pago único ---
  const showTipSingle = !splitMode && (payment === "tarjeta" || payment === "transferencia");
  const singleTip = useMemo(() => {
    if (!showTipSingle) return 0;
    if (tipPercent !== null) return Math.round(subtotal * (tipPercent / 100));
    return Number(tipManual || 0);
  }, [showTipSingle, tipPercent, tipManual, subtotal]);

  // --- Pago dividido ---
  const splitAmountANum = Number(splitAmountA) || 0;
  const splitTipNum = Number(splitTip) || 0;
  const splitCashReceivedNum = Number(splitCashReceived) || 0;

  const effectiveTip = splitMode ? splitTipNum : singleTip;
  // IVA aplica solo si tarjeta involucrada y se solicitó factura
  const iva = requiresInvoice && cardInvolved ? Math.round(subtotal * 0.16 * 100) / 100 : 0;
  const total = subtotal + effectiveTip + iva + deliveryNum;

  // En split: amount A = entrada, amount B = total - A
  const splitAmountB = Math.max(0, total - splitAmountANum);
  const splitCashAmount = splitHasCash ? splitAmountANum : 0;
  const splitCashChange =
    splitHasCash && splitCashReceivedNum >= splitCashAmount && splitCashAmount > 0
      ? splitCashReceivedNum - splitCashAmount
      : 0;

  const itemsCount = lineItems.reduce((s, i) => s + i.quantity, 0);

  const isCashSingle = !splitMode && payment === "efectivo";
  const cashNum = Number(cashReceived || 0);
  const change =
    isCashSingle && cashNum >= total && total > 0 ? cashNum - total : 0;

  // ---- Acciones de carrito ----
  const inc = (pid) =>
    setCart((c) => ({ ...c, [pid]: (Number(c[pid]) || 0) + 1 }));
  const dec = (pid) =>
    setCart((c) => ({ ...c, [pid]: Math.max(0, (Number(c[pid]) || 0) - 1) }));
  const setQty = (pid, qty) => {
    const n = Math.max(0, Math.floor(Number(qty) || 0));
    setCart((c) => ({ ...c, [pid]: isNaN(n) ? 0 : n }));
  };
  const addVariable = (product, amount) => {
    const amt = Math.max(0, Number(amount) || 0);
    if (amt <= 0) {
      toast.error("Ingresa un monto válido");
      return false;
    }
    setVarItems((items) => [
      ...items,
      {
        line_id: `v-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        product_id: product.id,
        name: product.name,
        price: amt,
      },
    ]);
    return true;
  };
  const removeVarItem = (line_id) =>
    setVarItems((items) => items.filter((i) => i.line_id !== line_id));

  const logout = () => {
    clearSession();
    navigate("/", { replace: true });
  };

  // Refresh duro: limpia todos los cachés del navegador y recarga desde
  // servidor. Útil cuando un dispositivo se quedó con un bundle viejo o el
  // carrito quedó en un estado raro. NO borra la cola de ventas pendientes.
  const hardRefresh = async () => {
    try {
      // Preservar la cola de ventas y la sesión — el resto se limpia.
      const queueBackup = localStorage.getItem("pos_pending_sales_v1");
      const sessionBackup = localStorage.getItem("tacos_session");
      localStorage.clear();
      if (queueBackup) localStorage.setItem("pos_pending_sales_v1", queueBackup);
      if (sessionBackup) localStorage.setItem("tacos_session", sessionBackup);
      if ("caches" in window) {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      }
    } catch { /* ignore */ }
    // Bust con timestamp para forzar bypass de caché HTTP
    const bust = `?_v=${Date.now()}`;
    window.location.replace(window.location.pathname + bust);
  };

  const reset = () => {
    setCart({});
    setVarItems([]);
    setTipPercent(null);
    setTipManual("");
    setPayment("efectivo");
    setOrderType("mesa");
    setMesaNumber("");
    setCashReceived("");
    setShowDetail(true);
    setRequiresInvoice(false);
    setDeliveryFee("");
    setSplitMode(false);
    setSplitType("cash-card");
    setSplitAmountA("");
    setSplitTip("");
    setSplitCashReceived("");
  };

  const handleCharge = async () => {
    if (subtotal <= 0) return toast.error("Agrega productos al carrito");
    if (!sucursal) return toast.error("Sin sucursal asignada");
    if (!orderType) return toast.error("Selecciona tipo de orden");
    if (orderType === "mesa" && !mesaNumber.trim()) {
      return toast.error("Ingresa el número/mesa");
    }

    // client_id estable para idempotencia. Si la red falla y reintentamos,
    // el backend reconoce este ID y devuelve la misma venta (no duplica).
    const clientId = newClientId();

    let payload = {
      client_id: clientId,
      items: lineItems.map(({ product_id, name, price, quantity }) => ({
        product_id,
        name,
        price,
        quantity,
      })),
      sucursal,
      cashier,
      caja,
      order_type: orderType,
      mesa_number: orderType === "mesa" ? mesaNumber.trim() : null,
      delivery_fee: deliveryNum,
      invoice_requested: requiresInvoice && cardInvolved,
      iva: requiresInvoice && cardInvolved ? iva : 0,
    };

    if (splitMode) {
      if (splitAmountANum <= 0 || splitAmountB <= 0) {
        return toast.error("Ambas partes deben ser mayores a 0");
      }
      if (Math.abs(splitAmountANum + splitAmountB - total) > 0.02) {
        return toast.error("Las partes deben sumar el total");
      }
      if (splitHasCash) {
        if (splitCashReceived !== "" && splitCashReceivedNum < splitCashAmount) {
          return toast.error("Dinero recibido en efectivo es menor a su parte");
        }
      }
      const [methodA, methodB] = splitMethods;
      const tipOnA = methodA === "efectivo" ? 0 : splitTipNum;
      const tipOnB = methodA === "efectivo" ? splitTipNum : 0;
      payload = {
        ...payload,
        payment_method: "mixto",
        payments: [
          {
            method: methodA,
            amount: splitAmountANum,
            tip: tipOnA,
            ...(methodA === "efectivo" && splitCashReceived !== ""
              ? { cash_received: splitCashReceivedNum }
              : {}),
          },
          {
            method: methodB,
            amount: splitAmountB,
            tip: tipOnB,
          },
        ],
      };
    } else {
      if (isCashSingle && cashReceived !== "" && cashNum < total) {
        return toast.error("Dinero recibido es menor al total");
      }
      payload = {
        ...payload,
        payment_method: payment,
        tip: effectiveTip,
        cash_received:
          isCashSingle && cashReceived !== "" ? cashNum : null,
      };
    }

    setSubmitting(true);
    try {
      const res = await api.post("/sales", payload);
      // Validación dura: solo aceptamos éxito si el backend devolvió un sale.id.
      if (!res?.data?.id) {
        throw new Error("Respuesta inválida del servidor (sin id de venta)");
      }
      let msg = `Venta cobrada ${formatMXN(total)}`;
      if (!splitMode && change > 0) msg += ` · Cambio ${formatMXN(change)}`;
      if (splitMode && splitCashChange > 0)
        msg += ` · Cambio ${formatMXN(splitCashChange)}`;
      toast.success(msg);
      reset();
    } catch (e) {
      // Fallo de red / timeout / 5xx / respuesta inválida →
      // encolamos para reintento automático. La idempotencia (client_id) garantiza
      // que aunque el backend haya guardado y se reintente, no se duplique.
      const detail = e?.response?.data?.detail;
      if (typeof detail === "string") {
        // Error con respuesta del backend (validación). No encolamos: hay que arreglar el carrito.
        toast.error(`Error: ${detail}`);
      } else {
        // Error de red / timeout → encolamos y reseteamos. Se reintenta automático.
        enqueueSale(payload);
        setPendingCount(getPendingCount());
        toast.success(
          `Venta de ${formatMXN(total)} guardada — se enviará al servidor al volver la red.`,
          { duration: 6000 }
        );
        reset();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Header */}
      <header
        className="flex items-center justify-between px-4 py-3 bg-white shadow-sm"
        data-testid="pos-header"
      >
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <span
            data-testid="conn-indicator"
            title={
              connStatus === "online"
                ? "Conectado al servidor"
                : connStatus === "offline"
                ? "Sin conexión — las ventas se guardan local y se envían al volver la red"
                : "Verificando conexión…"
            }
            className={`inline-block w-2.5 h-2.5 rounded-full ${
              connStatus === "online"
                ? "bg-emerald-500"
                : connStatus === "offline"
                ? "bg-red-500 animate-pulse"
                : "bg-amber-400 animate-pulse"
            }`}
          />
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-widest font-bold text-zinc-400 leading-none">
              {cashier}
            </p>
            <h1
              className="font-display text-xl font-black text-[#006400] leading-tight truncate mt-0.5"
              data-testid="pos-sucursal"
            >
              {sucursal || "—"}
            </h1>
          </div>
        </div>
        {pendingCount > 0 && (
          <button
            data-testid="pending-badge"
            onClick={() => setShowPending(true)}
            title="Ver detalle de ventas guardadas localmente"
            className="mr-2 px-2.5 h-9 rounded-lg bg-amber-500 text-white text-[10px] uppercase tracking-widest font-black flex items-center gap-1.5 active:bg-amber-600 tap-scale"
          >
            <span className="inline-block w-2 h-2 rounded-full bg-white animate-pulse" />
            <span>{pendingCount} sin enviar</span>
          </button>
        )}
        <button
          data-testid="btn-refresh-app"
          onClick={hardRefresh}
          title="Actualizar la app (limpia caché del navegador)"
          className="h-10 w-10 mr-1 flex items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 active:bg-zinc-200 tap-scale transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6M4 10a8 8 0 0114.93-3M20 14a8 8 0 01-14.93 3" />
          </svg>
        </button>
        <button
          data-testid="btn-logout"
          onClick={logout}
          className="h-10 px-3 text-[11px] uppercase tracking-widest font-bold text-zinc-500 rounded-lg hover:bg-zinc-100 active:bg-zinc-200 tap-scale transition-colors"
        >
          Salir
        </button>
      </header>

      {/* Productos */}
      {usingCache && (
        <div
          className="px-4 py-2 bg-amber-50 border-b-2 border-amber-200 text-[11px] uppercase tracking-widest font-black text-amber-900 text-center"
          data-testid="cache-banner"
        >
          ⚠ Sin conexión — productos en caché. Las ventas se guardan localmente.
        </div>
      )}
      <main
        className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5"
        data-testid="product-list"
      >
        {products.map((p) =>
          p.pricing_mode === "variable" ? (
            <VariableProductRow
              key={p.id}
              product={p}
              onAdd={(amt) => addVariable(p, amt)}
            />
          ) : (
            <ProductRow
              key={p.id}
              product={p}
              qty={cart[p.id] || 0}
              onInc={() => inc(p.id)}
              onDec={() => dec(p.id)}
            />
          )
        )}
        {products.length === 0 && (
          <div className="text-center text-zinc-500 py-12">Cargando productos…</div>
        )}
        <div className="h-2" />
      </main>

      <CartPanel
        sucursal={sucursal}
        items={lineItems}
        subtotal={subtotal}
        tip={effectiveTip}
        iva={iva}
        deliveryNum={deliveryNum}
        total={total}
        onRemoveVar={removeVarItem}
        payment={payment}
        setPayment={(p) => {
          setPayment(p);
          if (p === "efectivo") {
            setTipPercent(null);
            setTipManual("");
            setRequiresInvoice(false);
          } else {
            setCashReceived("");
            if (p !== "tarjeta") setRequiresInvoice(false);
          }
        }}
        showTipSingle={showTipSingle}
        tipPercent={tipPercent}
        setTipPercent={setTipPercent}
        tipManual={tipManual}
        setTipManual={setTipManual}
        isCashSingle={isCashSingle}
        cashReceived={cashReceived}
        setCashReceived={setCashReceived}
        change={change}
        orderType={orderType}
        setOrderType={(t) => {
          setOrderType(t);
          if (t !== "domicilio") setDeliveryFee("");
        }}
        mesaNumber={mesaNumber}
        setMesaNumber={setMesaNumber}
        deliveryFee={deliveryFee}
        setDeliveryFee={setDeliveryFee}
        requiresInvoice={requiresInvoice}
        setRequiresInvoice={setRequiresInvoice}
        cardInvolved={cardInvolved}
        splitMode={splitMode}
        setSplitMode={(v) => {
          setSplitMode(v);
          if (v) {
            setPayment("efectivo");
            setTipPercent(null);
            setTipManual("");
            setCashReceived("");
            setSplitType("cash-card");
            setSplitAmountA("");
            setSplitTip("");
            setSplitCashReceived("");
          }
        }}
        splitType={splitType}
        setSplitType={(t) => {
          setSplitType(t);
          // Reset cash received si el nuevo tipo no incluye efectivo
          if (!SPLIT_TYPES.find((s) => s.value === t)?.methods.includes("efectivo")) {
            setSplitCashReceived("");
          }
        }}
        splitMethods={splitMethods}
        splitHasCash={splitHasCash}
        splitAmountA={splitAmountA}
        setSplitAmountA={setSplitAmountA}
        splitAmountB={splitAmountB}
        splitTip={splitTip}
        setSplitTip={setSplitTip}
        splitCashReceived={splitCashReceived}
        setSplitCashReceived={setSplitCashReceived}
        splitCashChange={splitCashChange}
        onCharge={handleCharge}
        submitting={submitting}
        itemsCount={itemsCount}
        showDetail={showDetail}
        setShowDetail={setShowDetail}
      />

      {showPending && (
        <PendingSalesModal
          onClose={() => setShowPending(false)}
          onRefresh={() => setPendingCount(getPendingCount())}
        />
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Product Row (fixed) - diseño limpio sin etiqueta, color por barra lateral
// ----------------------------------------------------------------------------
function ProductRow({ product, qty, onInc, onDec }) {
  const selected = qty > 0;
  const isDrink = product.category === "bebida";
  const accent = isDrink ? "#0369A1" : "#006400";

  return (
    <div
      data-testid={`product-row-${product.id}`}
      style={{
        boxShadow: selected
          ? `inset 4px 0 0 0 ${accent}, 0 1px 2px rgba(0,0,0,0.04)`
          : `inset 4px 0 0 0 ${isDrink ? "#bae6fd" : "#bbf7d0"}, 0 1px 2px rgba(0,0,0,0.04)`,
        transition: "box-shadow 0.18s ease",
      }}
      className="bg-white rounded-xl pl-4 pr-3 py-2.5 flex items-center justify-between gap-2"
    >
      <div className="flex-1 min-w-0">
        <p
          className="font-bold text-base sm:text-lg leading-tight text-zinc-900 break-words"
          style={{ wordBreak: "break-word" }}
        >
          {product.name}
        </p>
        <p
          className="font-display text-xl sm:text-2xl font-black leading-none mt-1"
          style={{ color: accent }}
        >
          {formatMXN(product.price)}
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          data-testid={`btn-dec-${product.id}`}
          onClick={onDec}
          aria-label={`Restar ${product.name}`}
          className="w-11 h-11 sm:w-12 sm:h-12 rounded-full bg-zinc-100 text-2xl font-black text-zinc-900 active:bg-zinc-200 tap-scale transition-colors"
        >
          −
        </button>
        {/* Display-only quantity (no input field to prevent accidental edits on mobile) */}
        <div
          data-testid={`qty-display-${product.id}`}
          aria-label={`Cantidad ${qty}`}
          className="w-12 sm:w-14 h-11 sm:h-12 flex items-center justify-center text-xl font-black border border-zinc-200 rounded-lg bg-white select-none pointer-events-none"
        >
          {qty}
        </div>
        <button
          data-testid={`btn-inc-${product.id}`}
          onClick={onInc}
          aria-label={`Sumar ${product.name}`}
          style={{ backgroundColor: accent }}
          className="w-11 h-11 sm:w-12 sm:h-12 rounded-full text-white text-2xl font-black tap-scale shadow-sm active:shadow-inner transition-shadow"
        >
          +
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Variable Product Row
// ----------------------------------------------------------------------------
function VariableProductRow({ product, onAdd }) {
  const [amount, setAmount] = useState("");
  const accent = "#a16207";
  const handleAdd = () => {
    if (onAdd(amount)) setAmount("");
  };
  return (
    <div
      data-testid={`variable-product-${product.id}`}
      style={{
        boxShadow: "inset 4px 0 0 0 #fcd34d, 0 1px 2px rgba(0,0,0,0.04)",
      }}
      className="bg-white rounded-xl pl-4 pr-3 py-2.5 flex items-center justify-between gap-2"
    >
      <div className="flex-1 min-w-0">
        <p
          className="font-bold text-base sm:text-lg leading-tight text-zinc-900 break-words"
          style={{ wordBreak: "break-word" }}
        >
          {product.name}
        </p>
        <p
          className="text-[11px] sm:text-xs leading-none mt-1 font-semibold"
          style={{ color: accent }}
        >
          ✏ Precio libre
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <div className="relative">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400 font-black">
            $
          </span>
          <input
            data-testid={`var-amount-${product.id}`}
            type="number"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
            placeholder="100"
            className="w-24 sm:w-28 h-11 sm:h-12 pl-6 pr-2 text-lg font-black border border-zinc-200 rounded-lg outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20"
            min="0"
          />
        </div>
        <button
          data-testid={`btn-add-var-${product.id}`}
          onClick={handleAdd}
          style={{ backgroundColor: accent }}
          className="h-11 sm:h-12 px-4 rounded-lg text-white text-xs uppercase tracking-wider font-black tap-scale shadow-sm"
        >
          Agregar
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Cart Panel
// ----------------------------------------------------------------------------
function CartPanel({
  sucursal,
  items, subtotal, tip, iva, deliveryNum, total, onRemoveVar,
  payment, setPayment,
  showTipSingle, tipPercent, setTipPercent, tipManual, setTipManual,
  isCashSingle, cashReceived, setCashReceived, change,
  orderType, setOrderType, mesaNumber, setMesaNumber,
  deliveryFee, setDeliveryFee,
  requiresInvoice, setRequiresInvoice, cardInvolved,
  splitMode, setSplitMode,
  splitType, setSplitType, splitMethods, splitHasCash,
  splitAmountA, setSplitAmountA, splitAmountB,
  splitTip, setSplitTip,
  splitCashReceived, setSplitCashReceived, splitCashChange,
  onCharge, submitting, itemsCount, showDetail, setShowDetail,
}) {
  const isValleDorado = sucursal === "Valle Dorado";
  const summaryExtras = [];
  if (tip > 0) summaryExtras.push(`Propina ${formatMXN(tip)}`);
  if (iva > 0) summaryExtras.push(`IVA ${formatMXN(iva)}`);
  if (deliveryNum > 0) summaryExtras.push(`Envío ${formatMXN(deliveryNum)}`);

  return (
    <section
      className="bg-white rounded-t-2xl shadow-[0_-8px_32px_rgba(0,0,0,0.08)] max-h-[75vh] overflow-y-auto"
      data-testid="cart-panel"
    >
      {/* Detalle items */}
      {showDetail && items.length > 0 && (
        <div
          className="max-h-40 overflow-y-auto px-3 py-2 space-y-1 border-b border-zinc-100"
          data-testid="cart-detail"
        >
          {items.map((i, idx) => (
            <div
              key={i.line_id || i.product_id || idx}
              data-testid={`cart-line-${i.line_id || i.product_id}`}
              className="flex items-center justify-between text-xs sm:text-sm font-medium"
            >
              <span className="break-words mr-2">
                <span className="font-black">{i.quantity}×</span> {i.name}{" "}
                <span className="text-zinc-400">({formatMXN(i.price)})</span>
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-bold whitespace-nowrap">
                  {formatMXN(i.subtotal)}
                </span>
                {i.kind === "variable" && (
                  <button
                    onClick={() => onRemoveVar(i.line_id)}
                    data-testid={`remove-var-${i.line_id}`}
                    className="w-6 h-6 rounded bg-red-50 text-red-700 text-sm font-black active:bg-red-100"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Resumen + Total */}
      <button
        onClick={() => items.length > 0 && setShowDetail((v) => !v)}
        data-testid="cart-toggle"
        className="w-full px-3 pt-2 pb-1 flex items-center justify-between"
      >
        <div className="text-left">
          <p className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 leading-none">
            {itemsCount} {itemsCount === 1 ? "producto" : "productos"}
            {items.length > 0 && (
              <span className="text-zinc-400 ml-1">
                {showDetail ? "▼" : "▲"}
              </span>
            )}
          </p>
          {summaryExtras.length > 0 && (
            <p
              className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 leading-none mt-0.5"
              data-testid="cart-subtotal"
            >
              Subtotal {formatMXN(subtotal)} · {summaryExtras.join(" · ")}
            </p>
          )}
        </div>
        <p
          className="font-display text-3xl sm:text-4xl font-black text-[#006400] leading-none"
          data-testid="cart-total"
        >
          {formatMXN(total)}
        </p>
      </button>

      {/* Tipo de orden */}
      <div className="px-3 py-1.5">
        <div className="grid grid-cols-3 gap-1.5" data-testid="order-type-row">
          {ORDER_TYPES.map((o) => {
            const active = orderType === o.value;
            return (
              <button
                key={o.value}
                data-testid={`btn-ordertype-${o.value}`}
                onClick={() => setOrderType(o.value)}
                className={`h-10 rounded-lg text-[11px] uppercase tracking-widest font-black tap-scale transition-all ${
                  active
                    ? "bg-zinc-900 text-white shadow-sm"
                    : "bg-zinc-100 text-zinc-700 active:bg-zinc-200"
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        {orderType === "mesa" && (
          <div className="mt-1.5 flex items-center gap-1.5" data-testid="mesa-area">
            <label className="text-[10px] uppercase tracking-widest font-black text-zinc-500 w-10">
              Mesa
            </label>
            <input
              data-testid="input-mesa"
              type="text"
              value={mesaNumber}
              onChange={(e) => setMesaNumber(e.target.value)}
              placeholder="Ej. 5"
              className="w-20 h-10 px-2 text-base font-black border border-zinc-200 rounded-lg outline-none focus:border-[#006400] focus:ring-2 focus:ring-[#006400]/20 text-center"
            />
            {isValleDorado && (
              <div className="flex items-center gap-1 ml-auto">
                {VALLE_BARRAS.map((b) => {
                  const active = mesaNumber === b;
                  return (
                    <button
                      key={b}
                      data-testid={`btn-mesa-${b}`}
                      onClick={() => setMesaNumber(b)}
                      className={`h-10 px-3 rounded-lg text-xs uppercase tracking-widest font-black tap-scale transition-all ${
                        active
                          ? "bg-[#006400] text-white shadow-sm"
                          : "bg-zinc-100 text-zinc-700 active:bg-zinc-200"
                      }`}
                    >
                      {b}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {/* Input Envío (sólo Domicilio) */}
        {orderType === "domicilio" && (
          <div className="mt-1.5 flex items-center gap-1.5" data-testid="delivery-area">
            <label className="text-[10px] uppercase tracking-widest font-black text-amber-700 w-14">
              Envío
            </label>
            <div className="relative flex-1">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400 font-black">
                $
              </span>
              <input
                data-testid="input-delivery"
                type="number"
                inputMode="decimal"
                value={deliveryFee}
                onChange={(e) => setDeliveryFee(e.target.value)}
                placeholder="0"
                className="w-full h-10 pl-6 pr-2 text-base font-black border-2 border-amber-200 rounded-lg outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 bg-amber-50/40"
                min="0"
              />
            </div>
          </div>
        )}
      </div>

      {/* Toggle split */}
      <div className="px-3 pt-1 pb-1.5">
        <button
          data-testid="btn-toggle-split"
          onClick={() => setSplitMode(!splitMode)}
          className={`w-full h-10 rounded-md text-[11px] uppercase tracking-widest font-black border-2 tap-scale ${
            splitMode
              ? "bg-amber-500 text-white border-amber-500"
              : "bg-white text-amber-700 border-amber-300"
          }`}
        >
          {splitMode ? "↓ Pago dividido activo · cambiar a pago único" : "+ Dividir pago"}
        </button>
      </div>

      {/* Métodos pago único */}
      {!splitMode && (
        <div className="px-3 pb-1.5 grid grid-cols-3 gap-1.5">
          {PAYMENTS.map((p) => {
            const active = payment === p;
            return (
              <button
                key={p}
                data-testid={`btn-payment-${p}`}
                onClick={() => setPayment(p)}
                className={`h-10 rounded-md text-[11px] sm:text-xs uppercase tracking-wider font-black border-2 tap-scale ${
                  active
                    ? "bg-[#006400] text-white border-[#006400]"
                    : "bg-white text-[#006400] border-[#006400]"
                }`}
              >
                {PAYMENT_LABELS[p]}
              </button>
            );
          })}
        </div>
      )}

      {/* Toggle Factura (+16% IVA) - solo si tarjeta involucrada */}
      {cardInvolved && (
        <div className="px-3 pb-1.5">
          <button
            data-testid="btn-invoice"
            onClick={() => setRequiresInvoice(!requiresInvoice)}
            className={`w-full h-11 rounded-md text-[11px] uppercase tracking-widest font-black border-2 tap-scale flex items-center justify-between px-3 ${
              requiresInvoice
                ? "bg-[#006400] text-white border-[#006400]"
                : "bg-white text-[#006400] border-[#006400]"
            }`}
          >
            <span>{requiresInvoice ? "✓" : "○"} Factura (+16% IVA)</span>
            {requiresInvoice && (
              <span className="font-display text-base" data-testid="iva-value">
                +{formatMXN(iva)}
              </span>
            )}
          </button>
        </div>
      )}

      {/* Propina pago único */}
      {showTipSingle && (
        <div className="px-3 pb-1.5 space-y-1.5" data-testid="tip-area">
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] uppercase tracking-widest font-black text-zinc-500 w-14">
              Propina
            </label>
            <input
              data-testid="input-tip"
              type="number"
              inputMode="decimal"
              value={
                tipPercent !== null
                  ? Math.round((subtotal * tipPercent) / 100)
                  : tipManual
              }
              onChange={(e) => {
                setTipPercent(null);
                setTipManual(e.target.value);
              }}
              placeholder="0"
              className="flex-1 h-10 px-3 text-base font-black border border-zinc-200 rounded-lg outline-none focus:border-[#006400] focus:ring-2 focus:ring-[#006400]/20"
              min="0"
            />
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {TIP_PERCENTS.map((p) => {
              const active = tipPercent === p;
              return (
                <button
                  key={p}
                  data-testid={`tip-percent-${p}`}
                  onClick={() => {
                    setTipManual("");
                    setTipPercent(active ? null : p);
                  }}
                  className={`h-9 rounded-lg text-xs font-black tap-scale transition-all ${
                    active
                      ? "bg-[#006400] text-white shadow-sm"
                      : "bg-zinc-100 text-zinc-700 active:bg-zinc-200"
                  }`}
                >
                  {p}%
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Efectivo único */}
      {isCashSingle && (
        <div className="px-3 pb-1.5 space-y-1.5" data-testid="cash-area">
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] uppercase tracking-widest font-black text-zinc-500 w-14">
              Recibido
            </label>
            <input
              data-testid="input-cash-received"
              type="number"
              inputMode="decimal"
              value={cashReceived}
              onChange={(e) => setCashReceived(e.target.value)}
              placeholder={total > 0 ? formatMXN(total) : "0"}
              className="flex-1 h-10 px-3 text-base font-black border border-zinc-200 rounded-lg outline-none focus:border-[#006400] focus:ring-2 focus:ring-[#006400]/20"
              min="0"
            />
          </div>
          {change > 0 && (
            <div
              className="flex items-center justify-between bg-emerald-50 rounded-lg px-3 py-2"
              data-testid="change-display"
            >
              <span className="text-[10px] uppercase tracking-widest font-black text-emerald-900">
                Cambio
              </span>
              <span className="font-display text-2xl font-black text-emerald-700 leading-none">
                {formatMXN(change)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* PAGO DIVIDIDO */}
      {splitMode && (
        <div className="px-3 pb-2 space-y-2" data-testid="split-area">
          {/* Selector tipo de split */}
          <div className="grid grid-cols-1 gap-1.5">
            {SPLIT_TYPES.map((s) => {
              const active = splitType === s.value;
              return (
                <button
                  key={s.value}
                  data-testid={`split-type-${s.value}`}
                  onClick={() => setSplitType(s.value)}
                  className={`h-9 rounded-md text-[11px] uppercase tracking-widest font-black border-2 tap-scale ${
                    active
                      ? "bg-[#006400] text-white border-[#006400]"
                      : "bg-white text-[#006400] border-[#006400]"
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>

          {/* Parte A */}
          <div className="bg-zinc-50 border-2 border-zinc-200 rounded-md p-2 space-y-1.5">
            <p className="text-[10px] uppercase tracking-widest font-black text-zinc-700">
              {splitMethods[0] === "efectivo" ? "💵" : "💳"} Parte en {PAYMENT_LABELS[splitMethods[0]]}
            </p>
            <div className="flex items-center gap-1.5">
              <span className="text-zinc-400 font-black w-4">$</span>
              <input
                data-testid="split-amount-a"
                type="number"
                inputMode="decimal"
                value={splitAmountA}
                onChange={(e) => setSplitAmountA(e.target.value)}
                placeholder="0"
                className="flex-1 h-10 px-2 text-base font-black border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
                min="0"
              />
              <button
                onClick={() => setSplitAmountA(String(Math.round((total / 2) * 100) / 100))}
                className="h-10 px-2 rounded-md bg-white border-2 border-zinc-300 text-[10px] uppercase font-black active:bg-zinc-100 tap-scale"
                data-testid="split-half"
              >
                Mitad
              </button>
            </div>
            {splitHasCash && splitMethods[0] === "efectivo" && (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-widest font-black text-zinc-500 w-14">
                    Recibido
                  </span>
                  <input
                    data-testid="split-cash-received"
                    type="number"
                    inputMode="decimal"
                    value={splitCashReceived}
                    onChange={(e) => setSplitCashReceived(e.target.value)}
                    placeholder="Opcional"
                    className="flex-1 h-9 px-2 text-sm font-black border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
                    min="0"
                  />
                </div>
                {splitCashChange > 0 && (
                  <div
                    className="flex items-center justify-between bg-emerald-50 border border-emerald-200 rounded-md px-2 py-1"
                    data-testid="split-change"
                  >
                    <span className="text-[10px] uppercase tracking-widest font-black text-emerald-900">
                      Cambio
                    </span>
                    <span className="font-display text-lg font-black text-emerald-700 leading-none">
                      {formatMXN(splitCashChange)}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Parte B */}
          <div className="bg-zinc-50 border-2 border-zinc-200 rounded-md p-2 space-y-1.5">
            <p className="text-[10px] uppercase tracking-widest font-black text-zinc-700">
              {splitMethods[1] === "efectivo" ? "💵" : "💳"} Parte en {PAYMENT_LABELS[splitMethods[1]]}
            </p>
            <div
              className="flex items-center justify-between bg-white border-2 border-zinc-200 rounded-md px-2 h-10"
              data-testid="split-amount-b"
            >
              <span className="text-[10px] uppercase tracking-widest font-black text-zinc-500">
                Monto
              </span>
              <span className="font-display text-xl font-black text-[#006400]">
                {formatMXN(splitAmountB)}
              </span>
            </div>
            {/* Tip input: si parte B es digital, va aquí; si A es digital (card-transfer), también va en A. Único campo. */}
          </div>

          {/* Propina (única para el split) */}
          {(splitMethods[0] !== "efectivo" || splitMethods[1] !== "efectivo") && (
            <div className="flex items-center gap-1.5 px-1" data-testid="split-tip-area">
              <span className="text-[10px] uppercase tracking-widest font-black text-zinc-500 w-14">
                Propina
              </span>
              <input
                data-testid="split-tip"
                type="number"
                inputMode="decimal"
                value={splitTip}
                onChange={(e) => setSplitTip(e.target.value)}
                placeholder="0"
                className="flex-1 h-9 px-2 text-sm font-black border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
                min="0"
              />
            </div>
          )}
        </div>
      )}

      {/* Cobrar */}
      <div className="px-3 pb-3 pt-1.5">
        <button
          data-testid="btn-charge"
          onClick={onCharge}
          disabled={submitting || subtotal <= 0}
          className="w-full h-14 sm:h-16 rounded-xl bg-[#006400] text-white font-display text-xl sm:text-2xl font-black uppercase tracking-wider active:bg-[#228B22] disabled:bg-zinc-200 disabled:text-zinc-400 tap-scale shadow-md disabled:shadow-none transition-all"
        >
          {submitting ? "Cobrando…" : "Cobrar Orden"}
        </button>
      </div>
    </section>
  );
}

// ----------------------------------------------------------------------------
// PendingSalesModal – lista de ventas guardadas localmente esperando red.
// Permite al cajero VER que sus ventas están seguras aunque no se hayan enviado
// aún, y forzar un reintento inmediato.
// ----------------------------------------------------------------------------

function PendingSalesModal({ onClose, onRefresh }) {
  const [items, setItems] = useState(() => getQueueDetails());
  const [busy, setBusy] = useState(false);

  const reload = () => {
    setItems(getQueueDetails());
    onRefresh?.();
  };

  const retryNow = async () => {
    setBusy(true);
    try {
      const { synced, remaining } = await flushQueue();
      reload();
      if (synced > 0) {
        toast.success(`Sincronizadas ${synced} venta${synced === 1 ? "" : "s"}. Quedan ${remaining}.`);
      } else if (remaining > 0) {
        toast.error(`Sin conexión al servidor. ${remaining} venta${remaining === 1 ? " sigue" : "s siguen"} pendiente${remaining === 1 ? "" : "s"}.`);
      }
    } finally {
      setBusy(false);
    }
  };

  const fmt = (iso) => {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toLocaleString("es-MX", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" });
    } catch { return iso; }
  };

  return (
    <div
      data-testid="pending-modal"
      className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-3"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-t-2xl sm:rounded-2xl w-full max-w-md max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-zinc-100 px-4 py-3 flex items-center justify-between">
          <div>
            <h3 className="font-display text-lg font-black text-[#006400]">Ventas guardadas</h3>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              {items.length === 0 ? "Ninguna pendiente" : `${items.length} esperando enviarse`}
            </p>
          </div>
          <button
            data-testid="pending-close"
            onClick={onClose}
            className="w-9 h-9 rounded-lg text-zinc-500 hover:bg-zinc-100 active:bg-zinc-200 text-xl font-black"
          >
            ×
          </button>
        </div>

        {items.length === 0 ? (
          <div className="p-6 text-center text-zinc-500 text-sm">
            No hay ventas pendientes. Todo sincronizado ✓
          </div>
        ) : (
          <>
            <div className="px-3 py-2 bg-amber-50 border-b border-amber-100 text-[11px] text-amber-900">
              Estas ventas ya están cobradas y guardadas en este dispositivo.
              Se reintentarán automáticamente cuando vuelva la red.
            </div>
            <ul className="divide-y divide-zinc-100">
              {items.map((it, i) => (
                <li key={it.client_id || i} className="px-4 py-3" data-testid={`pending-row-${i}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-display text-lg font-black text-zinc-900">
                      {formatMXN(it.total)}
                    </span>
                    <span className="text-[10px] uppercase tracking-widest font-black text-zinc-400">
                      {fmt(it.queued_at)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-zinc-500">
                      {it.sucursal} · {it.cashier}
                    </span>
                    <span className={`text-[10px] uppercase tracking-widest font-black ${
                      it.attempts > 3 ? "text-red-700" : "text-amber-700"
                    }`}>
                      {it.attempts} intento{it.attempts === 1 ? "" : "s"}
                    </span>
                  </div>
                  {it.last_error && (
                    <p className="text-[11px] text-red-700 mt-1 font-mono">{it.last_error}</p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="sticky bottom-0 bg-white border-t border-zinc-100 p-3 flex gap-2">
          <button
            data-testid="pending-retry-now"
            onClick={retryNow}
            disabled={busy || items.length === 0}
            className="flex-1 h-11 rounded-lg bg-[#006400] text-white font-black text-sm uppercase tracking-widest disabled:bg-zinc-200 disabled:text-zinc-400 tap-scale"
          >
            {busy ? "Enviando…" : "Reintentar ahora"}
          </button>
          <button
            onClick={onClose}
            className="h-11 px-4 rounded-lg bg-zinc-100 text-zinc-700 font-black text-sm uppercase tracking-widest tap-scale"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

