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
// A raw call to the suite's local chain, for moving its clock.
async function rpc(method, params = []) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

// The "check it yourself" block: every address the page uses, linked to the explorer.
async function expectVerifyBlock(page, keys) {
  const config = await (await page.request.get("/deployment.json")).json();
  const block = page.locator("#verify");
  await expect(block).toBeVisible();
  for (const key of keys) {
    const address = config.addresses[key];
    const link = block.locator(
      `a[href="https://bscscan.com/address/${address}"]`,
    );
    await expect(link).toHaveText(address);
  }
  await expect(block.locator("#verify-addresses a")).toHaveCount(keys.length);
  await expect(block.locator("#verify-source")).toHaveAttribute(
    "href",
    `https://repo.sourcify.dev/56/${config.addresses.lending}`,
  );
  await expect(block.locator("#verify-repo")).toHaveAttribute(
    "href",
    "https://github.com/WBHouseSet/wbmb-p2p-lending",
  );
  await expect(block.locator("#verify-contact")).toHaveAttribute(
    "href",
    "https://github.com/WBHouseSet/wbmb-p2p-lending/issues",
  );
  await expect(block).toContainText("시드 문구나 개인키를 묻지 않습니다");
  await expect(block).toContainText("WBHouseSet");
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
  await expectVerifyBlock(page, ["lending", "oracle", "wbmb", "usdt"]);
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
  await lender.locator('#offer-form [name="total"]').fill("561.5");
  await lender.locator('#offer-form [name="minFill"]').fill("10");
  await lender.locator('#offer-form button[type="submit"]').click();
  await commit(lender, "거래 게시 완료");
  const borrower = await browser.newPage();
  await wallet(borrower, 1);
  await open(borrower);
  await connect(borrower);
  await borrower.locator('[data-tab="borrow"]').click();
  await borrower.locator('[data-fill-amount="1"]').fill("561.5");
  await borrower.locator('[data-offer="1"] [data-action="fill"]').click();
  // 561.5 / (112.3 * 0.5) = 10 WBMB
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

test("past maturity and grace the loan settles: the lender gets debt plus the bonus, the borrower the rest", async ({
  browser,
}) => {
  const lender = await browser.newPage();
  await wallet(lender, 2);
  await open(lender);
  await connect(lender);
  await lender.locator("#open-offer").click();
  await lender.locator('#offer-form [name="side"]').selectOption("1");
  await lender.locator('#offer-form [name="total"]').fill("56.15");
  await lender.locator('#offer-form [name="minFill"]').fill("10");
  await lender.locator('#offer-form [name="apr"]').fill("0");
  await lender.locator('#offer-form [name="duration"]').fill("1");
  await lender.locator('#offer-form button[type="submit"]').click();
  await commit(lender, "거래 게시 완료");
  const borrower = await browser.newPage();
  await wallet(borrower, 1);
  await open(borrower);
  await connect(borrower);
  await borrower.locator('[data-tab="borrow"]').click();
  await borrower.locator('[data-fill-amount="2"]').fill("56.15");
  await borrower.locator('[data-offer="2"] [data-action="fill"]').click();
  // 56.15 / (112.3 * 0.5) = 1 WBMB, liquidated at 56.15 / (1 * 0.7) = 80.2143
  await expect(borrower.locator("#confirm-body")).toContainText(
    "배정 담보: 1 WBMB",
  );
  await expect(borrower.locator("#confirm-body")).toContainText(
    "청산 가격: 80.22 USDT 이하", // 80.2143 shown rounded up
  );
  await commit(borrower, "부분 체결 완료");
  // One day to maturity, one day of grace. The relayed price stays valid for six days.
  await rpc("evm_increaseTime", [2 * 86400 + 60]);
  await rpc("evm_mine");
  await borrower.locator("#refresh").click();
  await expect(borrower.locator("#price-state")).toContainText("유효");
  await borrower.locator('[data-tab="mine"]').click();
  await borrower.locator('[data-loan="2"] [data-action="settle"]').click();
  // No interest (APR 0): 56.15 * 1.1 / 112.3 = 0.55 WBMB to the lender, 0.45 back.
  const body = borrower.locator("#confirm-body");
  await expect(body).toContainText("대출자 귀속 0.55 WBMB");
  await expect(body).toContainText("차입자 반환 0.45 WBMB");
  await expect(body).toContainText("종료 부채 56.15 USDT");
  await expect(body).toContainText("적용 가격 112.3 USDT · 보너스 10% 포함");
  await commit(borrower, "WBMB 정산 완료");
  await expect(borrower.locator(".claim-box")).toContainText("0.45 WBMB");
  await lender.locator("#refresh").click();
  await lender.locator('[data-tab="mine"]').click();
  await expect(lender.locator(".claim-box")).toContainText("0.55 WBMB");
});

// A reload must not look like the post was lost: the wallet and the open tab come back.
test("a reload keeps the wallet and the open tab, so my post stays in view; disconnecting is remembered too", async ({
  browser,
}) => {
  const lender = await browser.newPage();
  await wallet(lender, 2);
  await open(lender);
  await connect(lender);
  await lender.locator("#open-offer").click();
  await lender.locator('#offer-form [name="side"]').selectOption("1");
  await lender.locator('#offer-form [name="total"]').fill("33");
  await lender.locator('#offer-form [name="minFill"]').fill("10");
  await lender.locator('#offer-form button[type="submit"]').click();
  await commit(lender, "거래 게시 완료");
  await lender.locator('[data-tab="mine"]').click();
  const mine = lender.locator("#cards [data-offer]", { hasText: "33 USDT" });
  await expect(mine).toBeVisible();
  await lender.reload();
  await expect(lender.locator("#account-label")).toHaveText("연결된 지갑");
  await expect(lender.locator('[data-tab="mine"]')).toHaveClass(/active/);
  await expect(mine).toBeVisible();
  await lender.locator("#disconnect").click();
  await lender.reload();
  await expect(lender.locator("#status")).toContainText(
    "BNB Smart Chain 연결 완료",
  );
  await expect(lender.locator("#wallet-panel")).toBeHidden();
  await expect(lender.locator("#connect")).toHaveText("지갑 연결");
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

// The read endpoint is compiled into the build as well: a file that keeps every address
// but sends the page's reads elsewhere is refused before anything is fetched from it.
test("rejects a file whose RPC endpoint was rewritten", async ({ page }) => {
  await page.route("**/deployment.json", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.rpcUrl = json.rpcUrl.replace("127.0.0.1", "localhost");
    await route.fulfill({ response, json });
  });
  await page.goto("/");
  await expect(page.locator("#status")).toContainText(
    "허용되지 않은 배포 설정입니다",
  );
});
