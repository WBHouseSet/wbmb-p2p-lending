import { defineConfig } from "@playwright/test";
// Oracle-free market UI (the one intended for mainnet) against a local chain with mock tokens.
export default defineConfig({
  testDir: "./tests/browser-fixed",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: {
    baseURL: "http://127.0.0.1:5183",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/dev.mjs",
    url: "http://127.0.0.1:5183",
    timeout: 120000,
    reuseExistingServer: false,
    env: { RPC_PORT: "18548", APP_PORT: "5183", MARKET: "fixed" },
  },
});
