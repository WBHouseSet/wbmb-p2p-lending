import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "serial" });
const RPC = "http://127.0.0.1:18563";
// Mock EIP-1193 wallet backed by an unlocked local account. `index` picks the account.
async function wallet(page, index) {
  await page.addInitScript(
    ({ rpc, index }) => {
      const listeners = {};
      window.ethereum = {
        request: async ({ method, params = [] }) => {
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
    { rpc: RPC, index },
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

test("live council page shows the relayed price and no demo controls", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await expect(page.locator(".demo-banner")).toContainText("실제 자금");
  await expect(page.locator(".lab")).toBeHidden();
  await expect(page.locator("#current-label")).toContainText("카운슬 가격");
  await expect(page.locator("#current-price")).toHaveText("112.3");
  await expect(page.locator("#price-state")).toContainText("유효");
  expect(errors).toEqual([]);
});

test("lender posts, borrower fills at the council price and tops up", async ({
  browser,
}) => {
  const lender = await browser.newPage();
  await wallet(lender, 2);
  await open(lender);
  await connect(lender);
  await lender.locator("#open-offer").click();
  await lender.locator('#offer-form [name="side"]').selectOption("1");
  await lender.locator('#offer-form [name="total"]').fill("673.8");
  await lender.locator('#offer-form [name="minFill"]').fill("10");
  await lender.locator('#offer-form button[type="submit"]').click();
  await commit(lender, "거래 게시 완료");
  const borrower = await browser.newPage();
  await wallet(borrower, 1);
  await open(borrower);
  await connect(borrower);
  await borrower.locator('[data-tab="borrow"]').click();
  await borrower.locator('[data-fill-amount="1"]').fill("673.8");
  await borrower.locator('[data-offer="1"] [data-action="fill"]').click();
  // 673.8 / (112.3 * 0.6) = 10 WBMB
  await expect(borrower.locator("#confirm-body")).toContainText(
    "배정 담보: 10 WBMB",
  );
  await commit(borrower, "부분 체결 완료");
  await borrower.locator('[data-tab="mine"]').click();
  await expect(borrower.locator('[data-loan="1"]')).toContainText("청산 가격");
  await borrower.locator('[data-topup-amount="1"]').fill("1");
  await borrower.locator('[data-loan="1"] [data-action="topup"]').click();
  await commit(borrower, "담보 추가 완료");
});

test("rejects a swapped oracle address", async ({ page }) => {
  await page.route("**/deployment.json", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.addresses.oracle = "0x000000000000000000000000000000000000dEaD";
    await route.fulfill({ response, json });
  });
  await page.goto("/");
  await expect(page.locator("#status")).toContainText(
    "허용되지 않은 배포 설정입니다",
  );
});

// The build decides the market type: a council build refuses a fetched file that
// claims the oracle-free market, whatever else the file says.
for (const [name, edit] of [
  [
    "rejects a file downgraded to the oracle-free market",
    (json) => {
      json.oracleFree = true;
      delete json.policy;
    },
  ],
  [
    "rejects a file that claims both market types",
    (json) => {
      json.oracleFree = true;
      json.policy = "council";
    },
  ],
]) {
  test(name, async ({ page }) => {
    await page.route("**/deployment.json", async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      edit(json);
      await route.fulfill({ response, json });
    });
    await page.goto("/");
    await expect(page.locator("#status")).toContainText(
      "허용되지 않은 배포 설정입니다",
    );
  });
}
