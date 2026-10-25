import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
};

const setupFiles = [fileURLToPath(new URL("./tests/setup/setup.ts", import.meta.url))];

// Unit and browser (component/integration) suites are discovered separately
// so a unit project can never pull in a DOM-only suite, and so a failing
// browser suite is reported apart from the pure-logic suite.
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "jsdom",
          root: fileURLToPath(new URL("./tests/unit", import.meta.url)),
          setupFiles,
          include: ["**/*.{test,spec}.{ts,tsx}"],
          css: false,
          restoreMocks: true,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "browser",
          environment: "jsdom",
          root: fileURLToPath(new URL("./tests", import.meta.url)),
          setupFiles,
          // Only the DOM-driven suites: unit/ is owned by the unit project.
          include: [
            "components/**/*.{test,spec}.{ts,tsx}",
            "integration/**/*.{test,spec}.{ts,tsx}",
          ],
          css: false,
          restoreMocks: true,
        },
      },
    ],
  },
});
