import { defineConfig } from "@playwright/test";
// Browser check of a built page against a real chain with real keys (tests/browser-real).
// No webServer: WEB_URL must already be served, and RPC_URL, KEY_FILE, RECORD must be set.
export default defineConfig({
  testDir: "./tests/browser-real",
  fullyParallel: false,
  workers: 1,
  timeout: 600000,
  expect: { timeout: 60000 },
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
