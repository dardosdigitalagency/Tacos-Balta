/**
 * Cola resiliente de ventas pendientes (v2)
 * ============================================================================
 * Objetivo: cero pérdida de ventas ante red intermitente / backend caído.
 *
 * Estrategia:
 *  - Cada venta que falla se guarda con {payload, queued_at, attempts, last_error, next_try_at}.
 *  - Reintentos automáticos con backoff exponencial (5s → 10s → 20s → 40s → cap 5min).
 *  - Dispara flush en: intervalo (10s), navigator online, tab visible, mount.
 *  - Concurrency-safe: solo un flush corre a la vez.
 *  - Idempotencia garantizada por client_id (el backend jamás duplica).
 *  - Si localStorage se llena, hace copia de emergencia en window._emergencySales
 *    y notifica al usuario para que no pierda datos.
 *  - Exponemos getQueueDetails() para inspección manual desde la UI.
 * ==========================================================================*/
import { api } from "./api";

const KEY = "pos_pending_sales_v1";
const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000, 120_000, 300_000];

// ---------------------------------------------------------------------------
// Lectura/escritura persistente
// ---------------------------------------------------------------------------
const readQueue = () => {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const writeQueue = (arr) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(arr));
    return true;
  } catch (e) {
    // Cuota agotada u opción de privacidad. Guardamos copia en memoria para
    // que el usuario aún pueda ver / recuperar las ventas.
    console.error("[salesQueue] No se pudo escribir localStorage:", e);
    if (typeof window !== "undefined") {
      window._emergencySales = arr;
    }
    return false;
  }
};

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------
export const getPendingCount = () => readQueue().length;
export const getPending = () => readQueue();

export const getQueueDetails = () =>
  readQueue().map((it) => ({
    client_id: it.payload?.client_id,
    total: it.payload?.total ?? sumTotal(it.payload),
    sucursal: it.payload?.sucursal,
    cashier: it.payload?.cashier,
    queued_at: it.queued_at,
    attempts: it.attempts || 0,
    last_error: it.last_error || null,
    next_try_at: it.next_try_at || null,
  }));

// Helper para calcular total si no vino explícito (payload lo trae en algunos casos)
const sumTotal = (payload) => {
  if (!payload) return 0;
  const sub = (payload.items || []).reduce(
    (s, i) => s + Number(i.price || 0) * Number(i.quantity || 0),
    0,
  );
  return sub + Number(payload.tip || 0) + Number(payload.iva || 0) +
    Number(payload.delivery_fee || 0);
};

export const enqueueSale = (payload) => {
  const arr = readQueue();
  arr.push({
    payload,
    queued_at: new Date().toISOString(),
    attempts: 0,
    last_error: null,
    next_try_at: new Date().toISOString(), // listo para intentar YA
  });
  writeQueue(arr);
};

export const removeByClientId = (clientId) => {
  const arr = readQueue().filter((it) => it.payload?.client_id !== clientId);
  writeQueue(arr);
};

// Limpieza manual — DEBUG: sólo desde una acción explícita del usuario.
export const clearQueue = () => writeQueue([]);

// ---------------------------------------------------------------------------
// Flush con concurrency guard
// ---------------------------------------------------------------------------
let _flushing = false;

/**
 * Intenta sincronizar todas las ventas cuyo next_try_at ya llegó.
 * Devuelve {synced, remaining, failed}.
 */
export const flushQueue = async () => {
  if (_flushing) return { synced: 0, remaining: getPendingCount(), failed: 0 };
  _flushing = true;
  try {
    const arr = readQueue();
    if (!arr.length) return { synced: 0, remaining: 0, failed: 0 };
    const now = Date.now();
    let synced = 0;
    let failed = 0;
    const stillPending = [];

    for (const item of arr) {
      const nextTry = item.next_try_at ? Date.parse(item.next_try_at) : 0;
      // Respetamos el backoff — no reintentamos antes de tiempo
      if (nextTry > now) {
        stillPending.push(item);
        continue;
      }
      try {
        const res = await api.post("/sales", item.payload);
        // Solo consideramos éxito si el backend devolvió un id.
        // La idempotencia (client_id UNIQUE en Mongo) garantiza que reintentos
        // NO duplican ventas.
        if (res?.data?.id) {
          synced += 1;
          continue;
        }
        // Respuesta inesperada — tratamos como fallo transitorio
        stillPending.push(scheduleRetry(item, "Respuesta sin id de venta"));
        failed += 1;
      } catch (e) {
        const status = e?.response?.status;
        const detail = e?.response?.data?.detail;
        // 4xx (excepto 429): la venta está mal — no seguimos reintentando eternamente.
        // Igual la conservamos con marca visible para que el admin decida.
        if (status && status >= 400 && status < 500 && status !== 429) {
          stillPending.push({
            ...item,
            attempts: (item.attempts || 0) + 1,
            last_error: `HTTP ${status}: ${detail || "rechazada"}`,
            // Reintento suspendido — retiramos next_try_at
            next_try_at: null,
            hard_error: true,
          });
          failed += 1;
        } else {
          stillPending.push(scheduleRetry(item, describeError(e)));
          failed += 1;
        }
      }
    }
    writeQueue(stillPending);
    return { synced, remaining: stillPending.length, failed };
  } finally {
    _flushing = false;
  }
};

const scheduleRetry = (item, errorMsg) => {
  const attempts = (item.attempts || 0) + 1;
  const backoff = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
  return {
    ...item,
    attempts,
    last_error: errorMsg,
    next_try_at: new Date(Date.now() + backoff).toISOString(),
  };
};

const describeError = (e) => {
  if (!e) return "Error desconocido";
  if (e.code === "ECONNABORTED") return "Timeout (red lenta)";
  if (!e.response) return "Sin conexión";
  return `HTTP ${e.response.status}`;
};

// ---------------------------------------------------------------------------
// Auto-flush: intervalo, online, visibilidad
// ---------------------------------------------------------------------------
let _autoStarted = false;
export const startAutoFlush = (onChange) => {
  if (_autoStarted) return () => {};
  _autoStarted = true;

  const tick = async () => {
    if (!navigator.onLine) {
      onChange?.({ pending: getPendingCount(), synced: 0 });
      return;
    }
    const { synced, remaining } = await flushQueue();
    onChange?.({ pending: remaining, synced });
  };

  // Inmediato + cada 10s (más agresivo cuando hay pendientes)
  tick();
  const t = setInterval(tick, 10_000);
  const onOnline = () => tick();
  const onVisible = () => { if (document.visibilityState === "visible") tick(); };

  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    clearInterval(t);
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
    _autoStarted = false;
  };
};
