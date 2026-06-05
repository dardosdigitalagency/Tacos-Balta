import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";

export default function AdminLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post("/admin/login", { username, password });
      localStorage.setItem("tacos_admin_auth", "1");
      toast.success("Bienvenido");
      navigate("/admin", { replace: true });
    } catch {
      toast.error("Credenciales inválidas");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-[#F4F4F5]">
      <form
        onSubmit={submit}
        className="w-full max-w-md bg-white border-t-4 border-[#006400] rounded-md p-6 space-y-4"
        data-testid="admin-login-form"
      >
        <div>
          <p className="text-xs uppercase tracking-widest font-bold text-zinc-500">
            Acceso
          </p>
          <h1 className="font-display text-4xl font-black text-[#006400]">
            ADMIN
          </h1>
        </div>

        <div>
          <label className="text-xs uppercase tracking-widest font-bold text-zinc-500">
            Usuario
          </label>
          <input
            data-testid="input-username"
            autoFocus
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

        <Link
          to="/"
          data-testid="back-to-pos"
          className="block text-center text-sm uppercase tracking-widest font-bold text-zinc-500"
        >
          ← Volver al POS
        </Link>
      </form>
    </div>
  );
}
