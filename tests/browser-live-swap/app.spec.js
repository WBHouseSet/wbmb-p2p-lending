import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "serial" });
const RPC = "http://127.0.0.1:18568";
test.afterEach(async ({ browser }) => {
  for (const context of browser.contexts()) await context.close();
});
// Mock EIP-1193 wallet backed by the unlocked local account `index`.
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
async function trader(browser, index) {
  const page = await browser.newPage();
  await wallet(page, index);
  await open(page);
  await page.locator("#connect").click();
  await expect(page.locator("#account-label")).toHaveText("연결된 지갑");
  await page.locator('[data-tab="swap"]').click();
  return page;
}
async function commit(page, done) {
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-submit").click();
  await expect(page.locator("#status")).toContainText(done, { timeout: 40000 });
}
const deployment = async (page) =>
  (await page.request.get("/deployment.json")).json();

test("the live page offers the trade tab and names the trade contract to check", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  const config = await deployment(page);
  await expect(page.locator('[data-tab="swap"]')).toBeVisible();
  await expect(page.locator("#verify-addresses")).toContainText(
    "직거래 컨트랙트",
  );
  await expect(page.locator("#verify-addresses")).toContainText(
    config.addresses.swap,
  );
  await page.locator('[data-tab="swap"]').click();
  await expect(page.locator("#cards")).toContainText("아직 파는 글이 없습니다");
  expect(errors).toEqual([]);
});

test("one wallet posts WBMB for sale and another buys part of it with the real token code", async ({
  browser,
}) => {
  const seller = await trader(browser, 1);
  await seller.locator("#open-offer").click();
  const form = seller.locator("#swap-form");
  // the form starts from the relayed council price
  await expect(form.locator('[name="tradePrice"]')).toHaveValue("112.3");
  await form.locator('[name="tradeAmount"]').fill("2");
  await form.locator('[name="tradePrice"]').fill("112");
  await form.locator('[type="submit"]').click();
  await expect(seller.locator("#confirm-body")).toContainText(
    "내가 보내는 것: 2 WBMB",
  );
  await commit(seller, "직거래 글 올리기 완료");
  await expect(seller.locator("#wallet-balances")).toContainText("48 WBMB");

  const buyer = await trader(browser, 2);
  await buyer.locator('[data-swap-amount="1"]').fill("1");
  await buyer.locator('[data-action="swapFill"]').click();
  await expect(buyer.locator("#confirm-body")).toContainText(
    "내가 보내는 것: 112 MOVN",
  );
  await commit(buyer, "WBMB 사기 완료");
  await expect(buyer.locator("#wallet-balances")).toContainText(
    "4,888 MOVN · 51 WBMB",
  );
  // the seller received the price less 0.5%
  await seller.locator("#refresh").click();
  await expect(seller.locator("#wallet-balances")).toContainText(
    "5,111.44 MOVN",
  );
});

test("rejects a file whose trade contract address was replaced", async ({
  page,
}) => {
  const config = await deployment(page);
  config.addresses.swap = config.addresses.lending;
  await page.route("**/deployment.json", (route) =>
    route.fulfill({ json: config }),
  );
  await page.goto("/");
  await expect(page.locator("#status")).toContainText(
    "허용되지 않은 배포 설정",
  );
  await expect(page.locator('[data-tab="swap"]')).toBeHidden();
});

test("a file without the trade contract opens the market without the trade tab", async ({
  page,
}) => {
  const config = await deployment(page);
  delete config.addresses.swap;
  await page.route("**/deployment.json", (route) =>
    route.fulfill({ json: config }),
  );
  await open(page);
  await expect(page.locator('[data-tab="swap"]')).toBeHidden();
});
