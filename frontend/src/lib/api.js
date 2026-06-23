import axios from "axios";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API = `${BACKEND_URL}/api`;

// Timeout 20s para evitar peticiones colgadas en red intermitente.
export const api = axios.create({ baseURL: API, timeout: 20000 });

// ---------------------------------------------------------------------------
// Interceptor de reintentos: hasta 3 retries automáticos con backoff
// exponencial (1s, 2s, 4s) para errores de red, timeout y 5xx.
// Los 4xx (validación) NO se reintentan — son errores legítimos.
// ---------------------------------------------------------------------------
const MAX_RETRIES = 3;

api.interceptors.response.use(
  (r) => r,
  async (error) => {
    const cfg = error.config;
    if (!cfg) return Promise.reject(error);
    cfg.__retryCount = cfg.__retryCount || 0;

    const status = error.response?.status;
    const isTimeout = error.code === "ECONNABORTED";
    const isNetwork = !error.response;
    const is5xx = status >= 500 && status < 600;
    const isRetryable = isTimeout || isNetwork || is5xx;

    if (!isRetryable || cfg.__retryCount >= MAX_RETRIES) {
      return Promise.reject(error);
    }
    cfg.__retryCount += 1;
    const delayMs = Math.min(1000 * 2 ** (cfg.__retryCount - 1), 4000);
    await new Promise((res) => setTimeout(res, delayMs));
    return api.request(cfg);
  }
);

// ---------------------------------------------------------------------------
// Health check: indica si el backend está respondiendo.
// Se usa para mostrar el indicador de conexión en el POS.
// ---------------------------------------------------------------------------
export const pingBackend = async () => {
  try {
    // No reintentamos en el ping (queremos ver el estado real al instante).
    const cfg = { __retryCount: MAX_RETRIES, timeout: 5000 };
    await api.get("/health", cfg);
    return true;
  } catch {
    return false;
  }
};

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
