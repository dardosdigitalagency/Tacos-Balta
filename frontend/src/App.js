import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import POS from "@/pages/POS";
import AdminLogin from "@/pages/AdminLogin";
import AdminDashboard from "@/pages/AdminDashboard";

function RequireAuth({ children }) {
  const isAuth = localStorage.getItem("tacos_admin_auth") === "1";
  return isAuth ? children : <Navigate to="/admin/login" replace />;
}

export default function App() {
  return (
    <div className="App min-h-screen bg-[#F4F4F5]">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<POS />} />
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route
            path="/admin"
            element={
              <RequireAuth>
                <AdminDashboard />
              </RequireAuth>
            }
          />
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
