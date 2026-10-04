import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "serial" });
async function ready(page) {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("로컬 체인 준비 완료");
}
async function account(page, n) {
  await page.locator("#demo-account").selectOption(String(n));
  await expect(page.locator("#account-label")).toHaveText(`체험 지갑 ${n}`);
  await expect(page.locator("#wallet-balances")).toContainText("WBMB");
}
async function commit(page, done) {
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-submit").click();
  await expect(page.locator("#status")).toContainText(done);
  await expect(page.locator("#confirm-dialog")).not.toBeVisible();
}
test("read-only marketplace and mobile layout do not require wallet or private key", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  // The live-only MOVN risk note and the phone-wallet QR stay hidden on the local demo.
  await expect(page.locator("#movn-risk")).toBeHidden();
  await expect(page.locator("#open-on-phone")).toBeHidden();
  await expect(page.locator("#wallet-choice")).toBeHidden();
  await expect(page.locator("h1")).toContainText("조건은 우리가");
  await expect(page.locator("#verify")).toBeHidden();
  await expect(page.locator("[data-offer='2']")).toContainText("빌려드려요");
  await page.locator("#open-offer").click();
  await expect(page.locator("#status")).toContainText("먼저");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/mobile-market.png",
    fullPage: true,
  });
  expect(await page.locator('input[type="password"]').count()).toBe(0);
  expect(errors).toEqual([]);
});
test("borrower fills lender offer, adds collateral, pays interest and repays, lender claims", async ({
  page,
}) => {
  await ready(page);
  await account(page, 1);
  await page.locator('[data-fill-amount="2"]').fill("90");
  await page.locator('[data-offer="2"] [data-action="fill"]').click();
  await commit(page, "부분 체결 완료");
  await page.locator('[data-tab="mine"]').click();
  await expect(page.locator('[data-loan="1"]')).toContainText("진행 중");
  await page.locator('[data-topup-amount="1"]').fill("0.2");
  await page.locator('[data-loan="1"] [data-action="topup"]').click();
  await commit(page, "담보 추가 완료");
  await expect(page.locator('[data-loan="1"]')).toContainText("1.2 WBMB");
  await page.locator(".lab summary").click();
  await page.locator("#advance-day").click();
  await expect(page.locator("#status")).toContainText("1일이 경과");
  await page.locator('[data-loan="1"] [data-action="interest"]').click();
  await commit(page, "이자 납부 완료");
  await page.locator('[data-loan="1"] [data-action="repay"]').click();
  await commit(page, "상환 완료");
  await expect(page.locator('[data-loan="1"]')).toContainText("MOVN 상환 완료");
  await page.locator('[data-action="claimWBMB"]').click();
  await commit(page, "WBMB 수령 완료");
  await expect(page.locator('[data-action="claimWBMB"]')).toBeDisabled();
  await account(page, 2);
  await page.locator('[data-action="claimMOVN"]').click();
  await commit(page, "MOVN 수령 완료");
  await expect(page.locator('[data-action="claimMOVN"]')).toBeDisabled();
});
test("lender partially funds borrower, price drop settles in WBMB, fee burn remains separate", async ({
  page,
}) => {
  await ready(page);
  await account(page, 2);
  await page.locator('[data-tab="lend"]').click();
  await page.locator('[data-fill-amount="1"]').fill("90");
  await page.locator('[data-offer="1"] [data-action="fill"]').click();
  await commit(page, "부분 체결 완료");
  await page.locator('[data-tab="mine"]').click();
  await page.locator(".lab summary").click();
  await expect(page.locator("#price-state")).toContainText("서명 2/3");
  const round = Number(
    (await page.locator("#price-state").textContent()).match(/round (\d+)/)[1],
  );
  await page.locator("#lab-price").fill("94");
  await page.locator("#set-price").click();
  await expect(page.locator("#status")).toContainText("모의 가격을 반영");
  await expect(page.locator("#price-state")).toContainText(
    `round ${round + 1}`,
  );
  await expect(page.locator("#current-price")).toContainText("94");
  await page.locator('[data-loan="2"] [data-action="settle"]').click();
  await expect(page.locator("#confirm-body")).toContainText(
    "MOVN이 지급되는 것이 아니며",
  );
  await commit(page, "WBMB 정산 완료");
  await page.locator('[data-action="claimWBMB"]').click();
  await commit(page, "WBMB 수령 완료");
  await page.locator('[data-tab="burn"]').click();
  await page.locator('[data-action="flush"]').click();
  await commit(page, "수수료 이동 완료");
  await page.locator('[data-action="burn"]').click();
  await commit(page, "모의 매입·소각 완료");
  await expect(page.locator("#cards")).toContainText("실제 Uniswap 매입");
});
test("new proposal, confirmation cancellation and unfilled escrow withdrawal", async ({
  page,
}) => {
  await ready(page);
  await account(page, 3);
  await page.locator("#open-offer").click();
  await page.locator('[name="mode"]').selectOption("1");
  await expect(page.locator("#mode-warning")).toBeVisible();
  await page.locator('[name="side"]').selectOption("1");
  await expect(page.locator("#collateral-field")).not.toBeVisible();
  await page.locator('#offer-form button[type="submit"]').click();
  await page.locator("#confirm-cancel").click();
  await expect(page.locator("#status")).toContainText("거래를 취소");
  await page.locator("#open-offer").click();
  await page.locator('#offer-form button[type="submit"]').click();
  await commit(page, "거래 게시 완료");
  await page.locator('[data-tab="mine"]').click();
  await page.locator('[data-offer="3"] [data-action="close"]').click();
  await commit(page, "미체결분 회수 완료");
  await page.locator('[data-action="claimMOVN"]').click();
  await commit(page, "MOVN 수령 완료");
});
test("wallet connection uses EIP-1193 and invalidates session on account changes", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const listeners = {};
    window.ethereum = {
      request: async ({ method, params = [] }) => {
        const actual =
          method === "eth_requestAccounts" ? "eth_accounts" : method;
        const r = await fetch("http://127.0.0.1:18546", {
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
        return actual === "eth_accounts" ? [data.result[1]] : data.result;
      },
      on: (name, fn) => {
        listeners[name] = fn;
      },
      removeListener: (name) => {
        delete listeners[name];
      },
    };
    window.emitWalletChange = () => listeners.accountsChanged?.([]);
  });
  await ready(page);
  await page.locator("#connect").click();
  await expect(page.locator("#account-label")).toHaveText("연결된 지갑");
  await page.evaluate(() => window.emitWalletChange());
  await expect(page.locator("#wallet-panel")).not.toBeVisible();
  await expect(page.locator("#status")).toContainText("다시 연결");
});
test("wrong chain and rejected wallet requests do not authorize transactions", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.ethereum = {
      request: async ({ method }) => {
        if (method === "eth_requestAccounts")
          return ["0x0000000000000000000000000000000000000001"];
        if (method === "eth_chainId") return "0x38";
        throw Object.assign(new Error("user rejected"), { code: 4001 });
      },
    };
  });
  await ready(page);
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toContainText("취소");
  await expect(page.locator("#wallet-panel")).not.toBeVisible();
});
