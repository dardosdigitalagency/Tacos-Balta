import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import POS from "@/pages/POS";
import Login from "@/pages/Login";
import AdminDashboard from "@/pages/AdminDashboard";
import { getSession, isAdmin } from "@/lib/auth";

function RequireAuth({ children }) {
  const s = getSession();
  if (!s) return <Navigate to="/" replace />;
  return children;
}

function RequireAdmin({ children }) {
  if (!isAdmin()) return <Navigate to="/" replace />;
  return children;
}

function RootRedirect() {
  const s = getSession();
  if (!s) return <Login />;
  return <Navigate to={s.user.role === "admin" ? "/admin" : "/pos"} replace />;
}

export default function App() {
  return (
    <div className="App min-h-screen bg-[#F4F4F5]">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route
            path="/pos"
            element={
              <RequireAuth>
                <POS />
              </RequireAuth>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireAdmin>
                <AdminDashboard />
              </RequireAdmin>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      <Toaster
        position="top-center"
        toastOptions={{
          style: {
            fontFamily: "Manrope, sans-serif",
            fontWeight: 700,
            border: "2px solid #006400",
          },
        }}
      />
    </div>
  );
}
