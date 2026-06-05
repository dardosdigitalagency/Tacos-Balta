/**
 * Auth helpers para Tacos POS.
 * Sesión almacenada en localStorage (no JWT - app interna pequeña).
 */
import { api } from "@/lib/api";

const KEY = "tacos_session";

export function getSession() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setSession(session) {
  localStorage.setItem(KEY, JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem(KEY);
  // limpieza compatibilidad con sesión vieja
  localStorage.removeItem("tacos_admin_auth");
}

export function isAuthenticated() {
  return !!getSession();
}

export function isAdmin() {
  const s = getSession();
  return !!s && s.user?.role === "admin";
}

export async function login(username, password) {
  const { data } = await api.post("/auth/login", { username, password });
  setSession(data);
  return data;
}
