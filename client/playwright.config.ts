import { defineConfig, devices } from "@playwright/test";

// The local run starts both the API and Vite. Vite proxies /api and
// /socket.io to the API, so no VITE_API_URL override is needed. A remote
// E2E_BASE_URL owns its own backend and starts neither process.
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
    : [
        {
          command: "npm run start",
          cwd: "../server",
          url: "http://localhost:3000/api/health",
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
        {
          command: "npm run dev",
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      ],
});
