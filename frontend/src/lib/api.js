import axios from "axios";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API = `${BACKEND_URL}/api`;

// Timeout 20s para evitar peticiones colgadas en red intermitente.
export const api = axios.create({ baseURL: API, timeout: 20000 });

export const formatMXN = (n) =>
  new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Number(n || 0));

export const PAYMENT_LABELS = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  tarjeta: "Tarjeta",
};

// UUID v4 robusto. Usa crypto.randomUUID si está, fallback manual.
export const newClientId = () => {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch { /* ignore */ }
  return "cid-" + Date.now().toString(36) + "-" +
    Math.random().toString(36).slice(2, 10) + "-" +
    Math.random().toString(36).slice(2, 10);
};
