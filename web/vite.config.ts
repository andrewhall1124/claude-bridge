import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the Vite server proxies API + WebSocket calls to the Bridge server
// (default :8787). In production the Bridge server serves the built assets in
// web/dist directly, so no proxy is involved.
const SERVER_PORT = process.env.BRIDGE_SERVER_PORT ?? "8787";
const target = `http://127.0.0.1:${SERVER_PORT}`;

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: true },
      "/ws": { target, ws: true, changeOrigin: true },
    },
  },
});
