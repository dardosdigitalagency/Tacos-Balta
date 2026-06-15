/**
 * POS – Punto de Venta v4
 * Cambios v4:
 *  - inc/dec con functional setState (bug de suma corregido).
 *  - Productos VARIABLES (peso/precio libre, ej. Birria): se ingresa el monto.
 *  - Pago dividido (efectivo + tarjeta / efectivo + transferencia).
 *  - Botones rápidos B1/B2/B3 para mesa (sólo Valle Dorado).
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api, formatMXN, PAYMENT_LABELS } from "@/lib/api";
import { getSession, clearSession } from "@/lib/auth";

const PAYMENTS = ["efectivo", "transferencia", "tarjeta"];
const ORDER_TYPES = [
  { value: "mesa", label: "Mesa" },
  { value: "llevar", label: "Llevar" },
  { value: "domicilio", label: "Domicilio" },
];
const TIP_PERCENTS = [5, 10, 15, 20];
const VALLE_BARRAS = ["B1", "B2", "B3"];

export default function POS() {
  const navigate = useNavigate();
  const session = getSession();
  const sucursal =
    session?.user?.sucursal ||
    (session?.user?.role === "admin" ? "Valle Dorado" : null);
  const cashier = session?.user?.username;
  const caja = session?.user?.caja_name || cashier || "Caja 1";

  const [products, setProducts] = useState([]);
  // Cart fixed: { product_id: qty }
  const [cart, setCart] = useState({});
  // Cart variable: array de líneas independientes
  const [varItems, setVarItems] = useState([]);
  const [payment, setPayment] = useState("efectivo");
  const [tipPercent, setTipPercent] = useState(null);
  const [tipManual, setTipManual] = useState("");
  const [orderType, setOrderType] = useState("mesa");
  const [mesaNumber, setMesaNumber] = useState("");
  const [cashReceived, setCashReceived] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showDetail, setShowDetail] = useState(false);

  // Split payment state
  const [splitMode, setSplitMode] = useState(false);
  const [splitDigital, setSplitDigital] = useState("tarjeta"); // segundo método
  const [splitCashAmount, setSplitCashAmount] = useState("");
  const [splitDigitalTip, setSplitDigitalTip] = useState("");
  const [splitCashReceived, setSplitCashReceived] = useState("");

  useEffect(() => {
    const loadProducts = () =>
      api
        .get("/products")
        .then((r) => setProducts(r.data))
        .catch(() => toast.error("No se pudieron cargar los productos"));
    loadProducts();
    // refrescar productos cada 30s para tomar cambios de precios desde admin
    const t = setInterval(loadProducts, 30000);
    return () => clearInterval(t);
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

  // --- Pago dividido ---
  const splitCashNum = Number(splitCashAmount) || 0;
  const splitDigitalAmount = Math.max(0, subtotal - splitCashNum);
  const splitTipNum = Number(splitDigitalTip) || 0;
  const splitCashReceivedNum = Number(splitCashReceived) || 0;
  const splitCashChange =
    splitCashReceivedNum >= splitCashNum && splitCashNum > 0
      ? splitCashReceivedNum - splitCashNum
      : 0;

  // --- Pago único ---
  const showTipSingle = !splitMode && (payment === "tarjeta" || payment === "transferencia");
  const singleTip = useMemo(() => {
    if (!showTipSingle) return 0;
    if (tipPercent !== null) return Math.round(subtotal * (tipPercent / 100));
    return Number(tipManual || 0);
  }, [showTipSingle, tipPercent, tipManual, subtotal]);

  const effectiveTip = splitMode ? splitTipNum : singleTip;
  const total = subtotal + effectiveTip;
  const itemsCount = lineItems.reduce((s, i) => s + i.quantity, 0);

  const isCashSingle = !splitMode && payment === "efectivo";
  const cashNum = Number(cashReceived || 0);
  const change =
    isCashSingle && cashNum >= total && total > 0 ? cashNum - total : 0;

  // ---- Acciones de carrito (FUNCTIONAL setState - corrige bug de suma) ----
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

  const reset = () => {
    setCart({});
    setVarItems([]);
    setTipPercent(null);
    setTipManual("");
    setPayment("efectivo");
    setOrderType("mesa");
    setMesaNumber("");
    setCashReceived("");
    setShowDetail(false);
    setSplitMode(false);
    setSplitDigital("tarjeta");
    setSplitCashAmount("");
    setSplitDigitalTip("");
    setSplitCashReceived("");
  };

  const handleCharge = async () => {
    if (subtotal <= 0) return toast.error("Agrega productos al carrito");
    if (!sucursal) return toast.error("Sin sucursal asignada");
    if (!orderType) return toast.error("Selecciona tipo de orden");
    if (orderType === "mesa" && !mesaNumber.trim()) {
      return toast.error("Ingresa el número/mesa");
    }

    // Construir payload según modo
    let payload = {
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
    };

    if (splitMode) {
      if (splitCashNum <= 0 || splitDigitalAmount <= 0) {
        return toast.error("Ambas partes deben ser mayores a 0");
      }
      if (Math.abs(splitCashNum + splitDigitalAmount - subtotal) > 0.01) {
        return toast.error("Las partes deben sumar el subtotal");
      }
      if (
        splitCashReceived !== "" &&
        splitCashReceivedNum < splitCashNum
      ) {
        return toast.error("Dinero recibido en efectivo es menor a su parte");
      }
      payload = {
        ...payload,
        payment_method: "mixto",
        payments: [
          {
            method: "efectivo",
            amount: splitCashNum,
            tip: 0,
            cash_received:
              splitCashReceived !== "" ? splitCashReceivedNum : null,
          },
          {
            method: splitDigital,
            amount: splitDigitalAmount,
            tip: splitTipNum,
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
      await api.post("/sales", payload);
      let msg = `Venta cobrada ${formatMXN(total)}`;
      if (!splitMode && change > 0) msg += ` · Cambio ${formatMXN(change)}`;
      if (splitMode && splitCashChange > 0)
        msg += ` · Cambio ${formatMXN(splitCashChange)}`;
      toast.success(msg);
      reset();
    } catch (e) {
      const detail = e?.response?.data?.detail || "Error al guardar la venta";
      toast.error(typeof detail === "string" ? detail : "Error al guardar la venta");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Header */}
      <header
        className="flex items-center justify-between px-3 py-2 bg-white border-b-2 border-[#006400]"
        data-testid="pos-header"
      >
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 leading-none">
            {cashier}
          </p>
          <h1
            className="font-display text-xl font-black text-[#006400] leading-tight truncate"
            data-testid="pos-sucursal"
          >
            {sucursal || "—"}
          </h1>
        </div>
        <button
          data-testid="btn-logout"
          onClick={logout}
          className="h-10 px-3 text-[11px] uppercase tracking-widest font-bold border-2 border-zinc-300 text-zinc-700 rounded-md tap-scale"
        >
          Salir
        </button>
      </header>

      {/* Productos */}
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
              onChange={(v) => setQty(p.id, v)}
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
        total={total}
        onRemoveVar={removeVarItem}
        payment={payment}
        setPayment={(p) => {
          setPayment(p);
          if (p === "efectivo") {
            setTipPercent(null);
            setTipManual("");
          } else {
            setCashReceived("");
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
        setOrderType={setOrderType}
        mesaNumber={mesaNumber}
        setMesaNumber={setMesaNumber}
        splitMode={splitMode}
        setSplitMode={(v) => {
          setSplitMode(v);
          if (v) {
            setPayment("efectivo");
            setTipPercent(null);
            setTipManual("");
            setCashReceived("");
            setSplitDigital("tarjeta");
            setSplitCashAmount("");
            setSplitDigitalTip("");
            setSplitCashReceived("");
          }
        }}
        splitDigital={splitDigital}
        setSplitDigital={setSplitDigital}
        splitCashAmount={splitCashAmount}
        setSplitCashAmount={setSplitCashAmount}
        splitDigitalAmount={splitDigitalAmount}
        splitDigitalTip={splitDigitalTip}
        setSplitDigitalTip={setSplitDigitalTip}
        splitCashReceived={splitCashReceived}
        setSplitCashReceived={setSplitCashReceived}
        splitCashChange={splitCashChange}
        onCharge={handleCharge}
        submitting={submitting}
        itemsCount={itemsCount}
        showDetail={showDetail}
        setShowDetail={setShowDetail}
      />
    </div>
  );
}

// ----------------------------------------------------------------------------
// Product Row (fixed)
// ----------------------------------------------------------------------------
function ProductRow({ product, qty, onInc, onDec, onChange }) {
  const selected = qty > 0;
  const isDrink = product.category === "bebida";
  const accent = isDrink ? "#0369A1" : "#006400";
  const tagBg = isDrink
    ? "bg-sky-50 text-sky-800"
    : "bg-emerald-50 text-emerald-900";
  const tagText = isDrink ? "BEBIDA" : "COMIDA";

  return (
    <div
      data-testid={`product-row-${product.id}`}
      style={{ borderColor: selected ? accent : "transparent" }}
      className="bg-white rounded-md border-2 px-3 py-2 flex items-center justify-between gap-2"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`text-[9px] uppercase tracking-widest font-black px-1.5 py-0.5 rounded ${tagBg}`}
          >
            {tagText}
          </span>
          <p
            className="font-bold text-base sm:text-lg leading-tight text-zinc-900 break-words"
            style={{ wordBreak: "break-word" }}
          >
            {product.name}
          </p>
        </div>
        <p
          className="font-display text-xl sm:text-2xl font-black leading-none mt-0.5"
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
          className="w-11 h-11 sm:w-12 sm:h-12 rounded-md bg-zinc-100 text-2xl font-black text-zinc-900 active:bg-zinc-300 tap-scale"
        >
          −
        </button>
        <input
          data-testid={`input-qty-${product.id}`}
          type="number"
          inputMode="numeric"
          value={qty}
          onChange={(e) => onChange(e.target.value)}
          className="w-12 sm:w-14 h-11 sm:h-12 text-center text-xl font-black border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
          min="0"
        />
        <button
          data-testid={`btn-inc-${product.id}`}
          onClick={onInc}
          aria-label={`Sumar ${product.name}`}
          style={{ backgroundColor: accent }}
          className="w-11 h-11 sm:w-12 sm:h-12 rounded-md text-white text-2xl font-black tap-scale"
        >
          +
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Variable Product Row (precio se ingresa al cobrar — ej. Birria por peso)
// ----------------------------------------------------------------------------
function VariableProductRow({ product, onAdd }) {
  const [amount, setAmount] = useState("");
  const accent = "#a16207"; // ámbar
  const handleAdd = () => {
    if (onAdd(amount)) setAmount("");
  };
  return (
    <div
      data-testid={`variable-product-${product.id}`}
      className="bg-white rounded-md border-2 border-amber-200 px-3 py-2 flex items-center justify-between gap-2"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[9px] uppercase tracking-widest font-black px-1.5 py-0.5 rounded bg-amber-100 text-amber-900">
            POR PESO
          </span>
          <p
            className="font-bold text-base sm:text-lg leading-tight text-zinc-900 break-words"
            style={{ wordBreak: "break-word" }}
          >
            {product.name}
          </p>
        </div>
        <p
          className="text-xs sm:text-sm text-zinc-500 leading-none mt-1"
          style={{ color: accent }}
        >
          Ingresa el monto en pesos
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
            className="w-24 sm:w-28 h-11 sm:h-12 pl-6 pr-2 text-lg font-black border-2 border-zinc-200 rounded-md outline-none focus:border-amber-500"
            min="0"
          />
        </div>
        <button
          data-testid={`btn-add-var-${product.id}`}
          onClick={handleAdd}
          style={{ backgroundColor: accent }}
          className="h-11 sm:h-12 px-3 rounded-md text-white text-xs uppercase tracking-wider font-black tap-scale"
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
  items, subtotal, tip, total, onRemoveVar,
  payment, setPayment,
  showTipSingle, tipPercent, setTipPercent, tipManual, setTipManual,
  isCashSingle, cashReceived, setCashReceived, change,
  orderType, setOrderType, mesaNumber, setMesaNumber,
  splitMode, setSplitMode, splitDigital, setSplitDigital,
  splitCashAmount, setSplitCashAmount, splitDigitalAmount,
  splitDigitalTip, setSplitDigitalTip,
  splitCashReceived, setSplitCashReceived, splitCashChange,
  onCharge, submitting, itemsCount, showDetail, setShowDetail,
}) {
  const isValleDorado = sucursal === "Valle Dorado";

  return (
    <section
      className="bg-white border-t-4 border-[#006400] shadow-[0_-6px_24px_rgba(0,0,0,0.08)] max-h-[75vh] overflow-y-auto"
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
          {tip > 0 && (
            <p
              className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 leading-none mt-0.5"
              data-testid="cart-subtotal"
            >
              Subtotal {formatMXN(subtotal)} · Propina {formatMXN(tip)}
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
                className={`h-10 rounded-md text-[11px] uppercase tracking-widest font-black border-2 tap-scale ${
                  active
                    ? "bg-zinc-900 text-white border-zinc-900"
                    : "bg-white text-zinc-900 border-zinc-300"
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        {orderType === "mesa" && (
          <div className="mt-1.5 space-y-1.5" data-testid="mesa-area">
            <div className="flex items-center gap-2">
              <label className="text-[10px] uppercase tracking-widest font-black text-zinc-500 w-14">
                Mesa
              </label>
              <input
                data-testid="input-mesa"
                type="text"
                value={mesaNumber}
                onChange={(e) => setMesaNumber(e.target.value)}
                placeholder="Ej. 5"
                className="flex-1 h-10 px-2 text-base font-black border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
              />
            </div>
            {isValleDorado && (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-widest font-black text-zinc-400 w-14">
                  Barra
                </span>
                {VALLE_BARRAS.map((b) => {
                  const active = mesaNumber === b;
                  return (
                    <button
                      key={b}
                      data-testid={`btn-mesa-${b}`}
                      onClick={() => setMesaNumber(b)}
                      className={`h-9 px-3 rounded-md text-xs uppercase tracking-widest font-black border-2 tap-scale ${
                        active
                          ? "bg-[#006400] text-white border-[#006400]"
                          : "bg-white text-[#006400] border-[#006400]"
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
          {splitMode ? "↓ Pago dividido activo · cambiar a pago único" : "+ Dividir pago (efectivo + tarjeta/transf.)"}
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
              className="flex-1 h-10 px-2 text-base font-black border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
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
                  className={`h-9 rounded-md text-xs font-black border-2 tap-scale ${
                    active
                      ? "bg-[#006400] text-white border-[#006400]"
                      : "bg-white text-[#006400] border-[#006400]"
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
              className="flex-1 h-10 px-2 text-base font-black border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
              min="0"
            />
          </div>
          {change > 0 && (
            <div
              className="flex items-center justify-between bg-emerald-50 border-2 border-emerald-200 rounded-md px-3 py-1.5"
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
          {/* Selector método digital */}
          <div className="grid grid-cols-2 gap-1.5">
            {["tarjeta", "transferencia"].map((m) => {
              const active = splitDigital === m;
              return (
                <button
                  key={m}
                  data-testid={`split-digital-${m}`}
                  onClick={() => setSplitDigital(m)}
                  className={`h-9 rounded-md text-[11px] uppercase tracking-widest font-black border-2 tap-scale ${
                    active
                      ? "bg-[#006400] text-white border-[#006400]"
                      : "bg-white text-[#006400] border-[#006400]"
                  }`}
                >
                  Efectivo + {PAYMENT_LABELS[m]}
                </button>
              );
            })}
          </div>

          {/* Monto efectivo */}
          <div className="bg-zinc-50 border-2 border-zinc-200 rounded-md p-2 space-y-1.5">
            <p className="text-[10px] uppercase tracking-widest font-black text-zinc-700">
              💵 Parte en efectivo
            </p>
            <div className="flex items-center gap-1.5">
              <span className="text-zinc-400 font-black w-4">$</span>
              <input
                data-testid="split-cash-amount"
                type="number"
                inputMode="decimal"
                value={splitCashAmount}
                onChange={(e) => setSplitCashAmount(e.target.value)}
                placeholder="0"
                className="flex-1 h-10 px-2 text-base font-black border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
                min="0"
              />
              <button
                onClick={() => setSplitCashAmount(String(Math.round(subtotal / 2)))}
                className="h-10 px-2 rounded-md bg-white border-2 border-zinc-300 text-[10px] uppercase font-black active:bg-zinc-100 tap-scale"
                data-testid="split-cash-half"
              >
                Mitad
              </button>
            </div>
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
          </div>

          {/* Parte digital */}
          <div className="bg-zinc-50 border-2 border-zinc-200 rounded-md p-2 space-y-1.5">
            <p className="text-[10px] uppercase tracking-widest font-black text-zinc-700">
              💳 Parte en {PAYMENT_LABELS[splitDigital]}
            </p>
            <div
              className="flex items-center justify-between bg-white border-2 border-zinc-200 rounded-md px-2 h-10"
              data-testid="split-digital-amount"
            >
              <span className="text-[10px] uppercase tracking-widest font-black text-zinc-500">
                Monto
              </span>
              <span className="font-display text-xl font-black text-[#006400]">
                {formatMXN(splitDigitalAmount)}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-widest font-black text-zinc-500 w-14">
                Propina
              </span>
              <input
                data-testid="split-digital-tip"
                type="number"
                inputMode="decimal"
                value={splitDigitalTip}
                onChange={(e) => setSplitDigitalTip(e.target.value)}
                placeholder="0"
                className="flex-1 h-9 px-2 text-sm font-black border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
                min="0"
              />
            </div>
          </div>
        </div>
      )}

      {/* Cobrar */}
      <div className="px-3 pb-3 pt-1">
        <button
          data-testid="btn-charge"
          onClick={onCharge}
          disabled={submitting || subtotal <= 0}
          className="w-full h-14 sm:h-16 rounded-md bg-[#006400] text-white font-display text-xl sm:text-2xl font-black uppercase tracking-wider active:bg-[#228B22] disabled:bg-zinc-300 disabled:text-zinc-500 tap-scale"
        >
          {submitting ? "Cobrando…" : "Cobrar Orden"}
        </button>
      </div>
    </section>
  );
}
