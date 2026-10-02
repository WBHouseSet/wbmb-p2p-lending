import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "serial" });
async function ready(page) {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("로컬 체인 준비 완료");
}
async function account(page, n) {
  await page.locator("#demo-account").selectOption(String(n));
  await expect(page.locator("#account-label")).toHaveText(`체험 지갑 ${n}`);
}
async function commit(page, done) {
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-submit").click();
  await expect(page.locator("#status")).toContainText(done);
  await expect(page.locator("#confirm-dialog")).not.toBeVisible();
}
// The dd next to a loan card's dt label.
const cell = (page, loan, label) =>
  page
    .locator(`[data-loan="${loan}"] dl > div`)
    .filter({ hasText: label })
    .locator("dd");
async function setPrice(page, value) {
  await page.locator(".lab summary").click();
  await page.locator("#lab-price").fill(String(value));
  await page.locator("#set-price").click();
  await expect(page.locator("#status")).toContainText("가격을 반영");
  await page.locator(".lab summary").click();
}

test("council market shows the council price, a fee tab and the fixed margins", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  await expect(page.locator("#current-label")).toContainText("카운슬 가격");
  await expect(page.locator("#current-price")).toHaveText("100");
  await expect(page.locator("#price-state")).toContainText("유효");
  await expect(page.locator('[data-tab="burn"]')).toHaveText("수수료");
  await expect(page.locator(".principle-tags")).toContainText(
    "수수료 이자의 5%",
  );
  await page.locator('[data-tab="borrow"]').click();
  await expect(page.locator('[data-offer="2"]')).toContainText("담보 여유");
  await expect(page.locator('[data-offer="2"]')).toContainText("40%");
  expect(errors).toEqual([]);
});

test("borrower takes a lend offer, price falls, top-up rescues, further fall settles with a 5% bonus", async ({
  page,
}) => {
  await ready(page);
  await account(page, 1);
  await page.locator('[data-tab="borrow"]').click();
  await page.locator('[data-fill-amount="2"]').fill("600");
  await page.locator('[data-offer="2"] [data-action="fill"]').click();
  await expect(page.locator("#confirm-body")).toContainText(
    "배정 담보: 10 WBMB",
  );
  await commit(page, "부분 체결 완료");
  await page.locator('[data-tab="mine"]').click();
  // debt 600 / (10 WBMB * 0.8) = 75
  // Fill happens at price 100, so the loan can lose a quarter of the price before liquidation.
  // The seeded offer charges 10% APR, so a few seconds of interest may move the last digits.
  await expect(cell(page, 1, "청산 가격")).toHaveText(
    /^75(\.0\d*)? USDT 이하$/,
  );
  await expect(cell(page, 1, "청산까지 여유")).toHaveText(/^(25|24\.9)%$/);
  await setPrice(page, 74);
  await page.locator('[data-topup-amount="1"]').fill("1");
  await page.locator('[data-loan="1"] [data-action="topup"]').click();
  await commit(page, "담보 추가 완료");
  await page.locator('[data-loan="1"] [data-action="settle"]').click();
  await expect(page.locator("#status")).toContainText(
    "가격 청산 조건에 해당하지 않습니다",
  );
  await setPrice(page, 63);
  await expect(cell(page, 1, "청산까지 여유")).toHaveText("청산 대상");
  await page.locator('[data-loan="1"] [data-action="settle"]').click();
  // 600 * 1.05 / 63 = 10 WBMB to the lender, 1 back to the borrower
  // The seeded offer charges 10% APR, so a few seconds of interest may show in the last digits.
  await expect(page.locator("#confirm-body")).toContainText(
    /대출자 귀속 10(\.0000\d+)? WBMB/,
  );
  await expect(page.locator("#confirm-body")).toContainText(
    /차입자 반환 (1|0\.9999\d+) WBMB/,
  );
  await expect(page.locator("#confirm-body")).toContainText("보너스 5%");
  await commit(page, "WBMB 정산 완료");
  await expect(page.locator(".claim-box")).toContainText(/(1|0\.9999\d+) WBMB/);
});

test("posting a lend offer uses the council margins, then a fill gets the 80% liquidation line", async ({
  page,
}) => {
  await ready(page);
  await setPrice(page, 100);
  await account(page, 2);
  await page.locator("#open-offer").click();
  await page.locator('#offer-form [name="side"]').selectOption("1");
  await expect(page.locator("#collateral-field")).toBeHidden();
  await expect(page.locator("#terms-note")).toContainText("60%");
  await expect(page.locator("#terms-note")).toContainText("80%");
  await expect(page.locator("#terms-note")).toContainText("5%");
  // The stale-price rule is read from the contract (7 days on the local market).
  await expect(page.locator("#terms-note")).toContainText(
    "가격 갱신이 끊긴 채로 유예 종료와 가격 만료 뒤 각각 7일이 지나면 담보 전부가 대출자에게 갑니다.",
  );
  await page.locator('#offer-form button[type="submit"]').click();
  await commit(page, "거래 게시 완료");
  await account(page, 1);
  await page.locator('[data-tab="borrow"]').click();
  await expect(page.locator('[data-offer="3"]')).toContainText("담보 여유");
  await expect(page.locator('[data-offer="3"]')).toContainText("40%");
  await page.locator('[data-fill-amount="3"]').fill("90");
  await page.locator('[data-offer="3"] [data-action="fill"]').click();
  // 90 USDT at 40% margin and price 100 needs 1.5 WBMB.
  await expect(page.locator("#confirm-body")).toContainText(
    "배정 담보: 1.5 WBMB",
  );
  await commit(page, "부분 체결 완료");
  await page.locator('[data-tab="mine"]').click();
  // The posted terms were 40% margin / 80% liquidation: 90 / (1.5 * 0.8) = 75.
  await expect(cell(page, 2, "청산 가격")).toHaveText(
    /^75(\.0\d*)? USDT 이하$/,
  );
  await expect(page.locator('[data-loan="2"]')).toContainText(
    "가격 하락 / 만기 미상환 · 초과담보 반환",
  );
});

test("an expired council price blocks new fills and settlement and says why", async ({
  page,
}) => {
  await ready(page);
  await account(page, 1);
  await page.locator('[data-tab="borrow"]').click();
  await page.locator('[data-offer="2"] [data-action="fill"]').click();
  await commit(page, "부분 체결 완료");
  await page.locator(".lab summary").click();
  await page.locator("#advance-week").click();
  await expect(page.locator("#status")).toContainText("7일이 경과");
  await expect(page.locator("#price-state")).toContainText("가격 만료");
  await page.locator('[data-tab="mine"]').click();
  await expect(cell(page, 3, "청산까지 여유")).toHaveText("가격 만료");
  // Settle stays reachable (the stale-price escape uses it); the contract refuses and the page says why.
  await page.locator('[data-loan="3"] [data-action="settle"]').click();
  await expect(page.locator("#status")).toContainText("가격이 만료");
  await expect(page.locator("#confirm-dialog")).not.toBeVisible();
  // An empty amount must still show the expiry reason, not an amount error.
  await page.locator('[data-tab="borrow"]').click();
  await page.locator('[data-fill-amount="2"]').fill("");
  await page.locator('[data-offer="2"] [data-action="fill"]').click();
  await expect(page.locator("#status")).toContainText("카운슬 가격이 만료");
});
