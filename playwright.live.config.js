import { defineConfig } from "@playwright/test";
// Live-mode UI rehearsal: local chain id 56 with real token bytecode and a mock browser wallet.
export default defineConfig({
  testDir: "./tests/browser-live",
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 20000 },
  use: {
    baseURL: "http://127.0.0.1:5184",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/dev-live-rehearsal.mjs",
    url: "http://127.0.0.1:5184",
    timeout: 180000,
    reuseExistingServer: false,
    env: { RPC_PORT: "18557", APP_PORT: "5184" },
  },
});
