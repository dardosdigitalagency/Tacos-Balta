import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@/index.css";
import App from "@/App";

// Eliminar badge "Made with Emergent" inyectado por la plantilla
const removeEmergentBadge = () => {
  const el = document.getElementById("emergent-badge");
  if (el) el.remove();
};
removeEmergentBadge();
// Watch en caso de que se inyecte después
new MutationObserver(removeEmergentBadge).observe(document.body, {
  childList: true,
  subtree: false,
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  },
});

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
