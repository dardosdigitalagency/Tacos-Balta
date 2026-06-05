/**
 * Pantalla de login unificada.
 * Si rol = admin -> redirige a /admin
 * Si rol = cashier -> redirige a /pos
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { login } from "@/lib/auth";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const session = await login(username.trim(), password);
      toast.success(`Hola, ${session.user.username}`);
      if (session.user.role === "admin") {
        navigate("/admin", { replace: true });
      } else {
        navigate("/pos", { replace: true });
      }
    } catch {
      toast.error("Usuario o contraseña incorrectos");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-[#F4F4F5]">
      <form
        onSubmit={submit}
        className="w-full max-w-md bg-white border-t-4 border-[#006400] rounded-md p-6 space-y-4"
        data-testid="login-form"
      >
        <div>
          <p className="text-xs uppercase tracking-widest font-bold text-zinc-500">
            Punto de Venta
          </p>
          <h1 className="font-display text-5xl font-black text-[#006400] leading-none">
            TAQUERÍA
          </h1>
          <p className="text-sm text-zinc-500 mt-2">Inicia sesión para continuar</p>
        </div>

        <div>
          <label className="text-xs uppercase tracking-widest font-bold text-zinc-500">
            Usuario
          </label>
          <input
            data-testid="input-username"
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1 w-full h-14 px-3 text-lg font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
          />
        </div>

        <div>
          <label className="text-xs uppercase tracking-widest font-bold text-zinc-500">
            Contraseña
          </label>
          <input
            data-testid="input-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full h-14 px-3 text-lg font-bold border-2 border-zinc-200 rounded-md outline-none focus:border-[#006400]"
          />
        </div>

        <button
          data-testid="btn-login"
          type="submit"
          disabled={loading}
          className="w-full h-16 rounded-md bg-[#006400] text-white font-display text-2xl font-black uppercase tracking-wider active:bg-[#228B22] disabled:bg-zinc-400 tap-scale"
        >
          {loading ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </div>
  );
}
