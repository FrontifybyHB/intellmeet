import { defineConfig, devices } from "@playwright/test";

// Prerequisites (not started by this spec): the API must already be running
// (default http://localhost:3000 — see server/.env PORT=3000). The
// client dev server is started below unless E2E_BASE_URL targets a deployed
// app. The dev server proxies /api and /socket.io to the API, so no
// VITE_API_URL override is needed.
const baseURL = process.env.E2E_BASE_URL || "http://localhost:5173";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
