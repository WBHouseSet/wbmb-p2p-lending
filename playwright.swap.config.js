import { defineConfig } from "@playwright/test";
// WBMB/MOVN trade board UI against its own local council-market chain with mock tokens.
export default defineConfig({
  testDir: "./tests/browser-swap",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: {
    baseURL: "http://127.0.0.1:5189",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/dev.mjs",
    url: "http://127.0.0.1:5189",
    timeout: 120000,
    reuseExistingServer: false,
    env: { RPC_PORT: "18566", APP_PORT: "5189", MARKET: "council" },
  },
});
