import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Service worker: register ONLY in production builds. In dev (Vite, HMR) a
// cached app shell would serve stale assets and break hot reload, so we skip
// registration and proactively tear down any SW/caches left over from a
// previously-installed dev build.
if ("serviceWorker" in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.warn("SW registration failed", err);
      });
    });
  } else {
    void navigator.serviceWorker
      .getRegistrations()
      .then((regs) => regs.forEach((r) => void r.unregister()));
    if (typeof caches !== "undefined") {
      void caches.keys().then((keys) => keys.forEach((k) => void caches.delete(k)));
    }
  }
}
