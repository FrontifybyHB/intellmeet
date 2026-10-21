import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Documented local backend (see server/.env.example: PORT=5000).
const DEFAULT_PROXY_TARGET = "http://localhost:5000";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "VITE_");
  const proxyTarget = env.VITE_PROXY_TARGET?.trim() || DEFAULT_PROXY_TARGET;

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      port: 5173,
      strictPort: false,
      // The browser only ever talks to one origin in development: API and
      // Socket.IO traffic is proxied to the backend. That keeps requests
      // same-origin (no CORS workarounds) and the HttpOnly auth cookies
      // first-party, which the server's SameSite=lax default expects.
      proxy: {
        "/api": { target: proxyTarget },
        // Socket.IO handshake + websocket upgrade share the API origin.
        "/socket.io": { target: proxyTarget, ws: true },
        // The backend's protected dev-only contract lab. Exact path only:
        // a bare "/dev" prefix would swallow the app's own /dev/* routes.
        "/dev/meeting-lab": { target: proxyTarget },
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      css: false,
      restoreMocks: true,
    },
  };
});
