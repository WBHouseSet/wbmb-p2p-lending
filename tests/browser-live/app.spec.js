import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "serial" });
const RPC = "http://127.0.0.1:18557";
// Mock EIP-1193 wallet backed by an unlocked local account. `index` picks the account.
async function wallet(page, index, chainId = null) {
  await page.addInitScript(
    ({ rpc, index, chainId }) => {
      const listeners = {};
      window.ethereum = {
        request: async ({ method, params = [] }) => {
          if (chainId && method === "eth_chainId") return chainId;
          if (chainId && method.startsWith("wallet_"))
            throw Object.assign(new Error("user rejected"), { code: 4001 });
          const actual =
            method === "eth_requestAccounts" ? "eth_accounts" : method;
          const r = await fetch(rpc, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: actual,
              params,
            }),
          });
          const data = await r.json();
          if (data.error) throw data.error;
          return actual === "eth_accounts" ? [data.result[index]] : data.result;
        },
        on: (name, fn) => (listeners[name] = fn),
        removeListener: (name) => delete listeners[name],
      };
    },
    { rpc: RPC, index, chainId },
  );
}
async function open(page) {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText(
    "BNB Smart Chain 연결 완료",
  );
}
async function connect(page) {
  await page.locator("#connect").click();
  await expect(page.locator("#account-label")).toHaveText("연결된 지갑");
}
async function commit(page, done) {
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-submit").click();
  await expect(page.locator("#status")).toContainText(done, { timeout: 40000 });
}

test("live page warns about real funds and hides every demo control", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await expect(page.locator(".demo-banner")).toContainText("실제 자금");
  await expect(page.locator(".demo-banner")).toContainText("감사받지 않은");
  await expect(page.locator("#demo-account")).toBeHidden();
  await expect(page.locator(".lab")).toBeHidden();
  await expect(page.locator("#week-price")).toBeHidden();
  await expect(page.locator("#cards")).toContainText(
    "아직 열린 거래가 없습니다",
  );
  expect(errors).toEqual([]);
});

test("a wallet on the wrong network is not connected", async ({ page }) => {
  await wallet(page, 1, "0x1");
  await open(page);
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toContainText("취소");
  await expect(page.locator("#wallet-panel")).not.toBeVisible();
});

test("borrower posts a request with real-token bytecode through a browser wallet", async ({
  page,
}) => {
  await wallet(page, 1);
  await open(page);
  await connect(page);
  await expect(page.locator("#wallet-balances")).toContainText(
    "5,000 USDT · 50 WBMB",
  );
  await page.locator("#open-offer").click();
  await page.locator('input[name="total"]').fill("90");
  await page.locator('input[name="collateral"]').fill("1");
  await page.locator('#offer-form button[type="submit"]').click();
  await commit(page, "거래 게시 완료");
  await page.locator('[data-tab="lend"]').click();
  await expect(page.locator('[data-offer="1"]')).toContainText(
    "1 WBMB당 90 USDT",
  );
  await expect(page.locator("#wallet-balances")).toContainText("49 WBMB");
});

test("lender funds it, borrower repays in full and takes the collateral back", async ({
  page,
  browser,
}) => {
  await wallet(page, 2);
  await open(page);
  await connect(page);
  await page.locator('[data-tab="lend"]').click();
  await page.locator('[data-fill-amount="1"]').fill("90");
  await page.locator('[data-offer="1"] [data-action="fill"]').click();
  await commit(page, "부분 체결 완료");
  await expect(page.locator("#wallet-balances")).toContainText("4,910 USDT");

  const ctx = await browser.newContext();
  const b = await ctx.newPage();
  await wallet(b, 1);
  await open(b);
  await connect(b);
  await expect(b.locator("#wallet-balances")).toContainText("5,090 USDT");
  await b.locator('[data-tab="mine"]').click();
  await b.locator('[data-loan="1"] [data-action="repay"]').click();
  await commit(b, "상환 완료");
  await b.locator('[data-action="claimWBMB"]').click();
  await commit(b, "WBMB 수령 완료");
  await expect(b.locator("#wallet-balances")).toContainText("50 WBMB");
  await ctx.close();

  await page.locator('[data-tab="mine"]').click();
  await page.locator("#refresh").click();
  await page.locator('[data-action="claimUSDT"]').click();
  await commit(page, "USDT 수령 완료");
  await page.locator('[data-tab="burn"]').click();
  await expect(page.locator("#cards")).toContainText("수수료 지갑");
});
