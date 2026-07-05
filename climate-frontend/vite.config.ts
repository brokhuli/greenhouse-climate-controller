import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import checker from "vite-plugin-checker";

// The Go API (Phase 2a backend) listens on :8080. In dev, Vite proxies REST (`/api`)
// and the WebSocket fan-out (`/api/stream`) to it; in production the SPA is served by
// nginx at the same origin, so no base URL is hardcoded (see src/api/client.ts).
// Overridable via VITE_API_TARGET (e.g. http://127.0.0.1:8080 where `localhost` resolves to
// an IPv6 address the API isn't reachable on).
const API_TARGET = process.env.VITE_API_TARGET ?? "http://localhost:8080";

export default defineConfig(({ command }) => {
  // Type-check in the dev server only; `npm run build` runs `tsc --noEmit` explicitly,
  // and Vitest does its own thing — running the checker there just adds noise.
  const useChecker = command === "serve" && process.env.VITEST !== "true";

  return {
    plugins: [react(), tailwindcss(), ...(useChecker ? [checker({ typescript: true })] : [])],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: {
      proxy: {
        "/api": { target: API_TARGET, changeOrigin: true, ws: true },
      },
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./tests/setup.ts"],
      include: ["tests/**/*.test.{ts,tsx}"],
    },
  };
});
