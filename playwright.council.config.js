import { defineConfig } from "@playwright/test";
// Council-price market UI against a local chain with mock tokens.
export default defineConfig({
  testDir: "./tests/browser-council",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: {
    baseURL: "http://127.0.0.1:5185",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/dev.mjs",
    url: "http://127.0.0.1:5185",
    timeout: 120000,
    reuseExistingServer: false,
    env: { RPC_PORT: "18562", APP_PORT: "5185", MARKET: "council" },
  },
});
