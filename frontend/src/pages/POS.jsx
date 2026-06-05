/**
 * POS – Punto de Venta (mobile-first)
 * Lista de productos vertical, carrito sticky abajo, selector de pago + propina, "Cobrar Orden".
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, formatMXN, PAYMENT_LABELS } from "@/lib/api";

const PAYMENTS = ["efectivo", "transferencia", "tarjeta"];

export default function POS() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({}); // { product_id: qty }
  const [payment, setPayment] = useState("efectivo");
  const [tip, setTip] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get("/products").then((r) => setProducts(r.data)).catch(() => {
      toast.error("No se pudieron cargar los productos");
    });
  }, []);

  const lineItems = useMemo(() => {
    return products
      .filter((p) => cart[p.id] > 0)
      .map((p) => ({
        product_id: p.id,
        name: p.name,
        price: p.price,
        quantity: cart[p.id],
        subtotal: p.price * cart[p.id],
      }));
  }, [cart, products]);

  const subtotal = lineItems.reduce((s, i) => s + i.subtotal, 0);
  const showTip = payment === "tarjeta" || payment === "transferencia";
  const effectiveTip = showTip ? Number(tip || 0) : 0;
  const total = subtotal + effectiveTip;
  const itemsCount = lineItems.reduce((s, i) => s + i.quantity, 0);

  const setQty = (pid, qty) => {
    const q = Math.max(0, Math.floor(Number(qty) || 0));
    setCart((c) => ({ ...c, [pid]: q }));
  };
  const inc = (pid) => setQty(pid, (cart[pid] || 0) + 1);
  const dec = (pid) => setQty(pid, (cart[pid] || 0) - 1);

  const handleCharge = async () => {
    if (subtotal <= 0) {
      toast.error("Agrega productos al carrito");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/sales", {
        items: lineItems.map(({ product_id, name, price, quantity }) => ({
          product_id,
          name,
          price,
          quantity,
        })),
        payment_method: payment,
        tip: effectiveTip,
      });
      toast.success(`Venta cobrada · ${formatMXN(total)}`);
      setCart({});
      setTip(0);
      setPayment("efectivo");
    } catch (e) {
      toast.error("Error al guardar la venta");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-4 pt-4 pb-3 bg-white border-b-2 border-[#006400]">
        <div>
          <p className="text-xs uppercase tracking-widest font-bold text-zinc-500">
            Punto de Venta
          </p>
          <h1
            className="font-display text-3xl font-black text-[#006400] leading-none"
            data-testid="pos-title"
          >
            TAQUERÍA
          </h1>
        </div>
        <Link
          to="/admin/login"
          data-testid="admin-link"
          className="h-12 px-4 flex items-center text-sm uppercase tracking-widest font-bold border-2 border-[#006400] text-[#006400] rounded-md tap-scale"
        >
          Admin
        </Link>
      </header>

      {/* Product list */}
      <main
        className="flex-1 overflow-y-auto px-4 py-3 space-y-2"
        style={{ paddingBottom: "1rem" }}
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
        {/* Spacer so last item is reachable above sticky panel */}
        <div className="h-4" />
      </main>

      {/* Cart panel */}
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
      />
    </div>
  );
}

// ----------------------------------------------------------------------------
// Product Row
// ----------------------------------------------------------------------------
function ProductRow({ product, qty, onInc, onDec, onChange }) {
  const selected = qty > 0;
  return (
    <div
      data-testid={`product-row-${product.id}`}
      className={`bg-white rounded-md border-2 ${
        selected ? "border-[#006400]" : "border-transparent"
      } px-3 py-3 flex items-center justify-between gap-3`}
    >
      <div className="flex-1 min-w-0">
        <p className="font-bold text-lg leading-tight text-zinc-900 truncate">
          {product.name}
        </p>
        <p className="font-display text-2xl font-black text-[#006400] leading-none mt-1">
          {formatMXN(product.price)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          data-testid={`btn-dec-${product.id}`}
          onClick={onDec}
          aria-label={`Restar ${product.name}`}
          className="w-14 h-14 rounded-md bg-zinc-100 text-3xl font-black text-zinc-900 active:bg-zinc-300 tap-scale"
        >
          −
        </button>
        <input
          data-testid={`input-qty-${product.id}`}
          type="number"
          inputMode="numeric"
          value={qty}
          onChange={(e) => onChange(e.target.value)}
          className="w-16 h-14 text-center text-2xl font-black border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
          min="0"
        />
        <button
          data-testid={`btn-inc-${product.id}`}
          onClick={onInc}
          aria-label={`Sumar ${product.name}`}
          className="w-14 h-14 rounded-md bg-[#006400] text-white text-3xl font-black active:bg-[#228B22] tap-scale"
        >
          +
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Cart Panel (sticky bottom sheet style)
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
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section
      className="bg-white border-t-4 border-[#006400] shadow-[0_-10px_40px_rgba(0,0,0,0.1)]"
      data-testid="cart-panel"
    >
      {/* Expandable items list */}
      {items.length > 0 && (
        <button
          onClick={() => setExpanded((v) => !v)}
          data-testid="cart-toggle"
          className="w-full px-4 py-2 flex items-center justify-between text-xs uppercase tracking-widest font-bold text-zinc-500 border-b border-zinc-100"
        >
          <span>
            {itemsCount} {itemsCount === 1 ? "producto" : "productos"}
          </span>
          <span>{expanded ? "Ocultar ▼" : "Ver detalle ▲"}</span>
        </button>
      )}
      {expanded && items.length > 0 && (
        <div className="max-h-44 overflow-y-auto px-4 py-2 space-y-1 border-b border-zinc-100">
          {items.map((i) => (
            <div
              key={i.product_id}
              data-testid={`cart-line-${i.product_id}`}
              className="flex items-center justify-between text-sm font-medium"
            >
              <span className="truncate">
                {i.quantity} × {i.name}{" "}
                <span className="text-zinc-400">({formatMXN(i.price)})</span>
              </span>
              <span className="font-bold">{formatMXN(i.subtotal)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="px-4 pt-3 pb-2 flex items-baseline justify-between">
        <p className="text-xs uppercase tracking-widest font-bold text-zinc-500">
          Subtotal
        </p>
        <p
          className="font-display text-2xl font-black text-zinc-900"
          data-testid="cart-subtotal"
        >
          {formatMXN(subtotal)}
        </p>
      </div>

      {/* Payment selector */}
      <div className="px-4 pb-2 grid grid-cols-3 gap-2">
        {PAYMENTS.map((p) => {
          const active = payment === p;
          return (
            <button
              key={p}
              data-testid={`btn-payment-${p}`}
              onClick={() => setPayment(p)}
              className={`h-14 rounded-md text-sm uppercase tracking-wider font-bold border-2 tap-scale ${
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

      {/* Tip */}
      {showTip && (
        <div className="px-4 pb-2 flex items-center gap-2" data-testid="tip-area">
          <label className="text-xs uppercase tracking-widest font-bold text-zinc-500 w-20">
            Propina
          </label>
          <input
            data-testid="input-tip"
            type="number"
            inputMode="decimal"
            value={tipInput}
            onChange={(e) => setTipInput(e.target.value)}
            placeholder="0"
            className="flex-1 h-14 px-3 text-xl font-black border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
            min="0"
          />
          <div className="flex gap-1">
            {[10, 20, 50].map((v) => (
              <button
                key={v}
                data-testid={`tip-preset-${v}`}
                onClick={() => setTipInput(v)}
                className="h-14 px-3 rounded-md bg-zinc-100 text-sm font-bold active:bg-zinc-200 tap-scale"
              >
                +{v}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Total + charge */}
      <div className="px-4 pb-4 pt-2 border-t-2 border-zinc-100">
        <div className="flex items-baseline justify-between mb-2">
          <p className="text-sm uppercase tracking-widest font-bold text-zinc-700">
            Total
          </p>
          <p
            className="font-display text-5xl font-black text-[#006400] leading-none"
            data-testid="cart-total"
          >
            {formatMXN(total)}
          </p>
        </div>
        <button
          data-testid="btn-charge"
          onClick={onCharge}
          disabled={submitting || subtotal <= 0}
          className="w-full h-20 rounded-md bg-[#006400] text-white font-display text-3xl font-black uppercase tracking-wider active:bg-[#228B22] disabled:bg-zinc-300 disabled:text-zinc-500 tap-scale"
        >
          {submitting ? "Cobrando…" : "Cobrar Orden"}
        </button>
      </div>
    </section>
  );
}
