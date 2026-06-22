/**
 * Cola local de ventas pendientes de sincronizar.
 * - Si una venta falla al enviarse al backend, se guarda en localStorage.
 * - Al volver a abrir POS o cada cierto tiempo, se reintenta enviarla.
 * - El client_id garantiza idempotencia: si el backend ya la guardó,
 *   reintentarla simplemente devuelve la misma venta sin duplicar.
 */
import { api } from "./api";

const KEY = "pos_pending_sales_v1";

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
  } catch { /* quota o privacidad */ }
};

export const getPendingCount = () => readQueue().length;
export const getPending = () => readQueue();

export const enqueueSale = (payload) => {
  const arr = readQueue();
  arr.push({ payload, queued_at: new Date().toISOString(), attempts: 0 });
  writeQueue(arr);
};

export const removeByClientId = (clientId) => {
  const arr = readQueue().filter((it) => it.payload?.client_id !== clientId);
  writeQueue(arr);
};

/**
 * Intenta sincronizar todas las ventas pendientes.
 * Devuelve {synced, remaining}.
 */
export const flushQueue = async () => {
  const arr = readQueue();
  if (!arr.length) return { synced: 0, remaining: 0 };
  let synced = 0;
  const stillPending = [];
  for (const item of arr) {
    try {
      const res = await api.post("/sales", item.payload);
      if (res?.data?.id) {
        synced += 1;
      } else {
        // respuesta inesperada → mantener
        stillPending.push({ ...item, attempts: (item.attempts || 0) + 1 });
      }
    } catch {
      stillPending.push({ ...item, attempts: (item.attempts || 0) + 1 });
    }
  }
  writeQueue(stillPending);
  return { synced, remaining: stillPending.length };
};
