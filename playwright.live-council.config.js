import { defineConfig } from "@playwright/test";
// Live-mode UI rehearsal of the council-price market: local chain id 56 with real token bytecode and a mock browser wallet.
export default defineConfig({
  testDir: "./tests/browser-live-council",
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 20000 },
  use: {
    baseURL: "http://127.0.0.1:5186",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/dev-live-rehearsal.mjs",
    url: "http://127.0.0.1:5186",
    timeout: 180000,
    reuseExistingServer: false,
    env: { RPC_PORT: "18563", APP_PORT: "5186", MARKET: "council" },
  },
});
