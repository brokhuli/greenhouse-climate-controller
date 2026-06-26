import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive the real SPA in a browser against the running stack (Vite dev server on
 * :5173, proxying /api + the WebSocket to the Go platform on :8080). This catches integration
 * failures the jsdom unit suite can't — e.g. a contract-valid HTTP 200 whose body fails the SPA's
 * Zod schema. Point at a different origin with E2E_BASE_URL (e.g. the nginx build).
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Reuse the dev server if it's already up; otherwise start it. Assumes the backend stack is
  // running (deploy/ compose) — the SPA is a thin client over it.
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
