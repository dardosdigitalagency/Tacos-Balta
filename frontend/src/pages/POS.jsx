/**
 * POS – Punto de Venta compacto y mobile-first.
 * - Sesión por cajero (sucursal viene del login).
 * - Panel inferior compacto para maximizar productos visibles.
 * - Nombres completos (no se truncan).
 * - Bebidas con acento azul para distinguirlas de comida.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api, formatMXN, PAYMENT_LABELS } from "@/lib/api";
import { getSession, clearSession } from "@/lib/auth";

const PAYMENTS = ["efectivo", "transferencia", "tarjeta"];

export default function POS() {
  const navigate = useNavigate();
  const session = getSession();
  const sucursal = session?.user?.sucursal || (session?.user?.role === "admin" ? "Valle Dorado" : null);
  const cashier = session?.user?.username;

  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({});
  const [payment, setPayment] = useState("efectivo");
  const [tip, setTip] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [showDetail, setShowDetail] = useState(false);

  useEffect(() => {
    api.get("/products").then((r) => setProducts(r.data)).catch(() => {
      toast.error("No se pudieron cargar los productos");
    });
  }, []);

  const lineItems = useMemo(
    () =>
      products
        .filter((p) => cart[p.id] > 0)
        .map((p) => ({
          product_id: p.id,
          name: p.name,
          price: p.price,
          quantity: cart[p.id],
          subtotal: p.price * cart[p.id],
        })),
    [cart, products]
  );

  const subtotal = lineItems.reduce((s, i) => s + i.subtotal, 0);
  const showTip = payment === "tarjeta" || payment === "transferencia";
  const effectiveTip = showTip ? Number(tip || 0) : 0;
  const total = subtotal + effectiveTip;
  const itemsCount = lineItems.reduce((s, i) => s + i.quantity, 0);

  const setQty = (pid, qty) =>
    setCart((c) => ({ ...c, [pid]: Math.max(0, Math.floor(Number(qty) || 0)) }));
  const inc = (pid) => setQty(pid, (cart[pid] || 0) + 1);
  const dec = (pid) => setQty(pid, (cart[pid] || 0) - 1);

  const logout = () => {
    clearSession();
    navigate("/", { replace: true });
  };

  const handleCharge = async () => {
    if (subtotal <= 0) return toast.error("Agrega productos al carrito");
    if (!sucursal) return toast.error("Sin sucursal asignada");
    setSubmitting(true);
    try {
      await api.post("/sales", {
        items: lineItems.map(({ product_id, name, price, quantity }) => ({
          product_id, name, price, quantity,
        })),
        payment_method: payment,
        tip: effectiveTip,
        sucursal,
        cashier,
      });
      toast.success(`Venta cobrada · ${formatMXN(total)}`);
      setCart({});
      setTip(0);
      setPayment("efectivo");
      setShowDetail(false);
    } catch {
      toast.error("Error al guardar la venta");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Header compacto */}
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

      {/* Lista de productos */}
      <main
        className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5"
        data-testid="product-list"
      >
        {products.map((p) => (
          <ProductRow
            key={p.id}
            product={p}
            qty={cart[p.id] || 0}
            onInc={() => inc(p.id)}
            onDec={() => dec(p.id)}
            onChange={(v) => setQty(p.id, v)}
          />
        ))}
        {products.length === 0 && (
          <div className="text-center text-zinc-500 py-12">Cargando productos…</div>
        )}
        <div className="h-2" />
      </main>

      {/* Cart panel compacto */}
      <CartPanel
        items={lineItems}
        subtotal={subtotal}
        tip={effectiveTip}
        total={total}
        payment={payment}
        setPayment={setPayment}
        showTip={showTip}
        tipInput={tip}
        setTipInput={setTip}
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
// Product Row – nombre completo, color por categoría
// ----------------------------------------------------------------------------
function ProductRow({ product, qty, onInc, onDec, onChange }) {
  const selected = qty > 0;
  const isDrink = product.category === "bebida";
  const accent = isDrink ? "#0369A1" : "#006400";          // blue-700 / verde
  const accentHover = isDrink ? "#0284C7" : "#228B22";
  const tagBg = isDrink ? "bg-sky-50 text-sky-800" : "bg-emerald-50 text-emerald-900";
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
          onMouseDown={(e) => (e.currentTarget.style.backgroundColor = accentHover)}
          onMouseUp={(e) => (e.currentTarget.style.backgroundColor = accent)}
          className="w-11 h-11 sm:w-12 sm:h-12 rounded-md text-white text-2xl font-black tap-scale"
        >
          +
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Cart Panel COMPACTO
// ----------------------------------------------------------------------------
function CartPanel({
  items,
  subtotal,
  tip,
  total,
  payment,
  setPayment,
  showTip,
  tipInput,
  setTipInput,
  onCharge,
  submitting,
  itemsCount,
  showDetail,
  setShowDetail,
}) {
  return (
    <section
      className="bg-white border-t-4 border-[#006400] shadow-[0_-6px_24px_rgba(0,0,0,0.08)]"
      data-testid="cart-panel"
    >
      {/* Detalle expandible (overlay sobre productos) */}
      {showDetail && items.length > 0 && (
        <div
          className="max-h-44 overflow-y-auto px-3 py-2 space-y-1 border-b border-zinc-100"
          data-testid="cart-detail"
        >
          {items.map((i) => (
            <div
              key={i.product_id}
              data-testid={`cart-line-${i.product_id}`}
              className="flex items-center justify-between text-xs sm:text-sm font-medium"
            >
              <span className="break-words mr-2">
                <span className="font-black">{i.quantity}×</span> {i.name}{" "}
                <span className="text-zinc-400">({formatMXN(i.price)})</span>
              </span>
              <span className="font-bold whitespace-nowrap">{formatMXN(i.subtotal)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Fila 1: items + total */}
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
          {tip === 0 && (
            <span className="hidden" data-testid="cart-subtotal">
              {formatMXN(subtotal)}
            </span>
          )}
        </div>
        <p
          className="font-display text-3xl sm:text-4xl font-black text-[#006400] leading-none"
          data-testid="cart-total"
        >
          {formatMXN(total)}
        </p>
      </button>

      {/* Fila 2: métodos de pago */}
      <div className="px-3 py-1.5 grid grid-cols-3 gap-1.5">
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

      {/* Fila 3 condicional: propina */}
      {showTip && (
        <div className="px-3 pb-1.5 flex items-center gap-1.5" data-testid="tip-area">
          <label className="text-[10px] uppercase tracking-widest font-black text-zinc-500 w-14">
            Propina
          </label>
          <input
            data-testid="input-tip"
            type="number"
            inputMode="decimal"
            value={tipInput}
            onChange={(e) => setTipInput(e.target.value)}
            placeholder="0"
            className="flex-1 h-10 px-2 text-base font-black border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
            min="0"
          />
          {[10, 20, 50].map((v) => (
            <button
              key={v}
              data-testid={`tip-preset-${v}`}
              onClick={() => setTipInput(v)}
              className="h-10 w-11 rounded-md bg-zinc-100 text-xs font-black active:bg-zinc-200 tap-scale"
            >
              +{v}
            </button>
          ))}
        </div>
      )}

      {/* Fila 4: botón cobrar */}
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
