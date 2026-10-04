import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { relayCouncil } from "../../scripts/relay-council.mjs";

test.describe.configure({ mode: "serial" });
const RPC = "http://127.0.0.1:18563";
// Pages opened with browser.newPage() outlive their test; close them so later tests do not
// run beside a dozen idle pages.
test.afterEach(async ({ browser }) => {
  for (const context of browser.contexts()) await context.close();
});
// Mock EIP-1193 wallet backed by an unlocked local account. `index` picks the account.
// `rejectAfter` ≥ 0: the wallet refuses (code 4001) every eth_sendTransaction after that many.
async function wallet(page, index, { rejectAfter = -1 } = {}) {
  await page.addInitScript(
    ({ rpc, index, rejectAfter }) => {
      const listeners = {};
      let sent = 0;
      window.ethereum = {
        request: async ({ method, params = [] }) => {
          if (
            method === "eth_sendTransaction" &&
            rejectAfter >= 0 &&
            sent++ >= rejectAfter
          )
            throw { code: 4001, message: "User rejected the request." };
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
    { rpc: RPC, index, rejectAfter },
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
  await expectVerifyBlock(page, ["lending", "oracle", "wbmb", "movn"]);
  // MOVN-specific risk: the issuer can pause or blacklist, and the council treats MOVN as $1.
  const risk = page.locator("#movn-risk");
  await expect(risk).toBeVisible();
  await expect(risk).toContainText("MOVN 발행자는 전송을 멈추거나");
  await expect(risk).toContainText("시장 컨트랙트 자체를 막으면");
  await expect(page.locator("#movn-risk-council")).toBeVisible();
  await expect(risk).toContainText("1달러");
  // The verify block links the MOVN token to the explorer, never USDT.
  await expect(page.locator("#verify-addresses")).toContainText("MOVN 토큰");
  await expect(page.locator("#verify-addresses")).not.toContainText("USDT");
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
    "청산 가격: 80.22 MOVN 이하", // 80.2143 shown rounded up
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
  await expect(body).toContainText("종료 부채 56.15 MOVN");
  await expect(body).toContainText("적용 가격 112.3 MOVN · 보너스 10% 포함");
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
  const mine = lender.locator("#cards [data-offer]", { hasText: "33 MOVN" });
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

test("rejects a file whose MOVN address is swapped for USDT", async ({
  page,
}) => {
  await page.route("**/deployment.json", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.addresses.movn = "0x55d398326f99059fF775485246999027B3197955";
    await route.fulfill({ response, json });
  });
  await page.goto("/");
  await expect(page.locator("#status")).toContainText(
    "허용되지 않은 배포 설정입니다",
  );
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

// Wallet says no: the page reports it, unlocks every control and the chain is untouched.
test("a transaction the wallet rejects leaves no stuck state and no half-posted offer", async ({
  page,
}) => {
  await wallet(page, 2, { rejectAfter: 0 });
  await open(page);
  await connect(page);
  const before = await page.locator("#offer-count").textContent();
  await page.locator("#open-offer").click();
  await page.locator('#offer-form [name="side"]').selectOption("1");
  await page.locator('#offer-form [name="total"]').fill("7");
  await page.locator('#offer-form [name="minFill"]').fill("7");
  await page.locator('#offer-form button[type="submit"]').click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-submit").click();
  await expect(page.locator("#status")).toContainText(
    "지갑에서 요청을 취소했습니다",
  );
  await expect(page.locator("#open-offer")).toBeEnabled();
  await expect(page.locator("#offer-count")).toHaveText(before);
});

// Approvals are exact: after a lend post the market's allowance is spent to zero, never unlimited.
test("the page approves exactly the amount it moves, never an unlimited allowance", async ({
  page,
}) => {
  await wallet(page, 2);
  await open(page);
  await connect(page);
  await page.locator("#open-offer").click();
  await page.locator('#offer-form [name="side"]').selectOption("1");
  await page.locator('#offer-form [name="total"]').fill("3");
  await page.locator('#offer-form [name="minFill"]').fill("3");
  await page.locator('#offer-form button[type="submit"]').click();
  await commit(page, "거래 게시 완료");
  const deployment = await (await page.request.get("/deployment.json")).json();
  const accounts = await rpc("eth_accounts");
  const data =
    "0xdd62ed3e" + // allowance(address,address)
    accounts[2].slice(2).padStart(64, "0") +
    deployment.addresses.lending.slice(2).padStart(64, "0");
  const allowance = await rpc("eth_call", [
    { to: deployment.addresses.movn, data },
    "latest",
  ]);
  expect(BigInt(allowance)).toBe(0n);
});

// ---- Every remaining web flow on the MOVN replica: repay, cancel, claims, fee flush,
// ---- price-drop liquidation, top-up rescue, stale-price settlement.
// Offers 1–4 and loans 1–2 exist from the tests above; ids below continue from there.

// Relays `price` with the throwaway reporter the rehearsal wrote; confirmedAt is just
// before the chain clock, so the real relay code accepts it as a fresh council answer.
async function relay(price) {
  const record = JSON.parse(
    fs.readFileSync(".local/rehearsal-5186/bsc-council-movn.json", "utf8"),
  );
  const secret = fs.readFileSync(".local/rehearsal-5186/reporter.key", "utf8");
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  await relayCouncil({
    rpcUrl: RPC,
    policy: record.pricePolicy,
    secret,
    broadcast: true,
    log: () => {},
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        price,
        date: "rehearsal",
        confirmedAt: new Date(
          Number(block.timestamp) * 1000 - 1000,
        ).toISOString(),
      }),
    }),
  });
}
async function post(page, total, { apr, duration } = {}) {
  await page.locator("#open-offer").click();
  await page.locator('#offer-form [name="side"]').selectOption("1");
  await page.locator('#offer-form [name="total"]').fill(total);
  await page.locator('#offer-form [name="minFill"]').fill(total);
  if (apr !== undefined)
    await page.locator('#offer-form [name="apr"]').fill(apr);
  if (duration !== undefined)
    await page.locator('#offer-form [name="duration"]').fill(duration);
  await page.locator('#offer-form button[type="submit"]').click();
  await commit(page, "거래 게시 완료");
}
async function fill(page, offer, amount) {
  await page.locator("#refresh").click();
  await page.locator('[data-tab="borrow"]').click();
  await page.locator(`[data-fill-amount="${offer}"]`).fill(amount);
  await page.locator(`[data-offer="${offer}"] [data-action="fill"]`).click();
  await commit(page, "부분 체결 완료");
}
async function pair(browser) {
  const lender = await browser.newPage();
  await wallet(lender, 2);
  await open(lender);
  await connect(lender);
  const borrower = await browser.newPage();
  await wallet(borrower, 1);
  await open(borrower);
  await connect(borrower);
  return { lender, borrower };
}
// Refresh, then wait until the page has finished re-rendering (#cards carries aria-busy
// while refresh() runs); clicking a card while it is being replaced makes Playwright retry
// the click on the new element, possibly after the test moved the clock.
const settled = (page) =>
  expect(page.locator("#cards")).toHaveAttribute("aria-busy", "false");
const mine = async (page) => {
  await expect(page.locator("#refresh")).toBeEnabled();
  await page.locator("#refresh").click();
  await settled(page);
  await page.locator('[data-tab="mine"]').click();
  await settled(page);
};

test("interest-only, then partial, then full repayment in MOVN; both sides claim; the fee wallet moves the MOVN fee", async ({
  browser,
}) => {
  const { lender, borrower } = await pair(browser);
  // A lender never sees a fill control on their own post.
  await post(lender, "33"); // offer 5
  await lender.locator('[data-tab="borrow"]').click();
  await expect(lender.locator('[data-offer="5"]')).toBeVisible();
  await expect(
    lender.locator('[data-offer="5"] [data-action="fill"]'),
  ).toHaveCount(0);
  await fill(borrower, 5, "33"); // loan 3
  await mine(borrower);
  const loan = borrower.locator('[data-loan="3"]');
  // Interest only: the loan stays open and the principal is untouched.
  await loan.locator('[data-action="interest"]').click();
  await commit(borrower, "이자 납부 완료");
  await expect(loan).toContainText("진행 중");
  // Partial: 13 of 33 back; still open.
  await borrower.locator('[data-repay-amount="3"]').fill("13");
  await loan.locator('[data-action="repay"]').click();
  await commit(borrower, "상환 완료");
  await expect(loan).toContainText("진행 중");
  await expect(loan).toContainText("20");
  // Full: the rest.
  await borrower.locator('[data-repay-amount="3"]').fill("20");
  await loan.locator('[data-action="repay"]').click();
  await commit(borrower, "상환 완료");
  await expect(loan).toContainText("MOVN 상환 완료");
  await borrower.locator('[data-action="claimWBMB"]').click();
  await commit(borrower, "WBMB 수령 완료");
  await expect(borrower.locator('[data-action="claimWBMB"]')).toBeDisabled();
  await mine(lender);
  await expect(lender.locator(".claim-box")).toContainText("33.");
  await lender.locator('[data-action="claimMOVN"]').click();
  await expect(lender.locator("#confirm-body")).toContainText(
    "MOVN을 현재 연결한 지갑으로",
  );
  await commit(lender, "MOVN 수령 완료");
  await expect(lender.locator('[data-action="claimMOVN"]')).toBeDisabled();
  // Fee wallet (account 3): the fee tab shows what accrued and moves it.
  const fee = await browser.newPage();
  await wallet(fee, 3);
  await open(fee);
  await connect(fee);
  await fee.locator('[data-tab="burn"]').click();
  await expect(fee.locator(".burn-stats")).toContainText(
    "컨트랙트에 쌓인 수수료",
  );
  await expect(fee.locator('[data-action="flush"]')).toBeEnabled();
  await fee.locator('[data-action="flush"]').click();
  await commit(fee, "수수료 이동 완료");
  await expect(fee.locator('[data-action="flush"]')).toBeDisabled();
});

test("a lender cancels an unfilled offer and takes the MOVN back; a cancelled offer cannot be filled", async ({
  browser,
}) => {
  const { lender, borrower } = await pair(browser);
  await post(lender, "5"); // offer 6
  await mine(lender);
  await lender.locator('[data-offer="6"] [data-action="close"]').click();
  await commit(lender, "미체결분 회수 완료");
  await lender.locator('[data-action="claimMOVN"]').click();
  await commit(lender, "MOVN 수령 완료");
  await borrower.locator("#refresh").click();
  await borrower.locator('[data-tab="borrow"]').click();
  await expect(
    borrower.locator('[data-offer="6"] [data-action="fill"]'),
  ).toHaveCount(0);
});

test("the council price falls below the line: settlement pays the lender debt + 10%, the fee wallet claims its WBMB", async ({
  browser,
}) => {
  const { lender, borrower } = await pair(browser);
  await post(lender, "50"); // offer 7
  await fill(borrower, 7, "50"); // loan 4: minimum collateral at 112.3, line ≈ 80.21
  await mine(borrower);
  await borrower.locator('[data-loan="4"] [data-action="settle"]').click();
  await expect(borrower.locator("#status")).toContainText(
    "가격 청산 조건에 해당하지 않습니다",
  );
  // The council profile allows one 30% step per day: 112.3 → 78.61, below the line.
  await rpc("evm_increaseTime", [86400 + 60]);
  await rpc("evm_mine");
  await relay(60);
  await mine(borrower);
  await expect(borrower.locator("#current-price")).toHaveText("78.61");
  await expect(
    borrower.locator('[data-loan="4"] [data-liq-price]'),
  ).toContainText("MOVN");
  // The page settles from the loan card (the contract lets anyone call settle; the page
  // only lists cards of loans the viewer is part of).
  await borrower.locator('[data-loan="4"] [data-action="settle"]').click();
  await expect(borrower.locator("#confirm-body")).toContainText(
    "보너스 10% 포함",
  );
  await expect(borrower.locator("#confirm-body")).toContainText(
    "적용 가격 78.61 MOVN",
  );
  await commit(borrower, "WBMB 정산 완료");
  await mine(lender);
  await lender.locator('[data-action="claimWBMB"]').click();
  await commit(lender, "WBMB 수령 완료");
  // The fee wallet (account 3) collects the settlement fee in WBMB.
  const fee = await browser.newPage();
  await wallet(fee, 3);
  await open(fee);
  await connect(fee);
  await fee.locator('[data-tab="mine"]').click();
  await fee.locator('[data-action="claimWBMB"]').click();
  await commit(fee, "WBMB 수령 완료");
});

test("a borrower who tops up before the price falls is not liquidated", async ({
  browser,
}) => {
  const { lender, borrower } = await pair(browser);
  await post(lender, "20"); // offer 8
  await fill(borrower, 8, "20"); // loan 5 at 78.61
  await mine(borrower);
  await borrower.locator('[data-topup-amount="5"]').fill("1");
  await borrower.locator('[data-loan="5"] [data-action="topup"]').click();
  await commit(borrower, "담보 추가 완료");
  await rpc("evm_increaseTime", [86400 + 60]);
  await rpc("evm_mine");
  await relay(60); // 78.61 → 60 (within 30%)
  await mine(borrower);
  await expect(borrower.locator("#current-price")).toHaveText("60");
  await borrower.locator('[data-loan="5"] [data-action="settle"]').click();
  await expect(borrower.locator("#status")).toContainText(
    "가격 청산 조건에 해당하지 않습니다",
  );
  await expect(borrower.locator('[data-loan="5"]')).toContainText("진행 중");
});

test("with the council price expired, a loan past grace settles only after the stale delay", async ({
  browser,
}) => {
  const { lender, borrower } = await pair(browser);
  await post(lender, "10", { apr: "0", duration: "1" }); // offer 9
  await fill(borrower, 9, "10"); // loan 6
  // Past maturity + grace but the price (valid 6 days) is still live: nothing to settle.
  await rpc("evm_increaseTime", [2 * 86400 + 60]);
  await rpc("evm_mine");
  await mine(borrower);
  await expect(borrower.locator("#price-state")).toContainText("유효");
  // Past the price's validity but not yet the 7-day stale delay: refused and explained.
  await rpc("evm_increaseTime", [5 * 86400]);
  await rpc("evm_mine");
  await mine(borrower);
  await expect(borrower.locator("#price-state")).not.toContainText("유효");
  await borrower.locator('[data-loan="6"] [data-action="settle"]').click();
  await expect(borrower.locator("#status")).toContainText("가격이 만료되어");
  // The refused quote leaves the page usable.
  await expect(borrower.locator("#refresh")).toBeEnabled();
  // After the stale delay the loan ends in WBMB at the last price.
  await rpc("evm_increaseTime", [8 * 86400]);
  await rpc("evm_mine");
  await mine(borrower);
  await borrower.locator('[data-loan="6"] [data-action="settle"]').click();
  await commit(borrower, "WBMB 정산 완료");
  await expect(borrower.locator('[data-loan="6"]')).toContainText(
    "WBMB 정산 완료",
  );
  await mine(lender);
  await lender.locator('[data-action="claimWBMB"]').click();
  await commit(lender, "WBMB 수령 완료");
});
