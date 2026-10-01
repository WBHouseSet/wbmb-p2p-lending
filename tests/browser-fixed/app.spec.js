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

test("oracle-free market shows no price feed and a fee tab instead of burn", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  await expect(page.locator("#week-price")).toBeHidden();
  await expect(page.locator("#current-price")).toBeHidden();
  await expect(page.locator("#set-price")).toBeHidden();
  await expect(page.locator('[data-tab="burn"]')).toHaveText("수수료");
  await page.locator('[data-tab="lend"]').click();
  await expect(page.locator('[data-offer="1"]')).toContainText(
    "1 WBMB당 90 USDT",
  );
  await expect(page.locator('[data-offer="1"]')).toContainText("만기 미상환");
  await expect(page.locator('[data-offer="1"]')).toContainText("유예 1일");
  await expect(page.locator(".principle-tags")).not.toContainText(
    "개발자 수익 0",
  );
  await expect(page.locator(".principle-tags")).toContainText(
    "수수료 이자의 5%",
  );
  await expect(page.locator("footer")).not.toContainText("프로토타입");
  expect(errors).toEqual([]);
});

test("lender funds a borrow request, borrower repays, fee goes to the fee wallet", async ({
  page,
}) => {
  await ready(page);
  await account(page, 2);
  await page.locator('[data-tab="lend"]').click();
  await page.locator('[data-fill-amount="1"]').fill("90");
  await page.locator('[data-offer="1"] [data-action="fill"]').click();
  await expect(page.locator("#confirm-body")).toContainText(
    "배정 담보: 1 WBMB",
  );
  await expect(page.locator("#confirm-body")).toContainText(
    "내가 보내는 것: 90 USDT",
  );
  await expect(page.locator("#confirm-body")).toContainText(
    "담보 비율: 1 WBMB당 90 USDT",
  );
  await expect(page.locator("#confirm-body")).toContainText("상환 기한");
  await commit(page, "부분 체결 완료");
  await account(page, 1);
  await page.locator('[data-tab="mine"]').click();
  await expect(
    page.locator('[data-loan="1"] [data-action="topup"]'),
  ).toHaveCount(0);
  await expect(page.locator(".claim-box")).toBeVisible(); // "내 거래" finished rendering
  await page.locator('[data-repay-amount="1"]').fill("40");
  await page.locator('[data-loan="1"] [data-action="repay"]').click();
  await expect(page.locator("#confirm-body")).toContainText(
    "일부만 갚으면 담보는 풀리지 않습니다",
  );
  await page.locator("#confirm-cancel").click();
  await expect(page.locator("#confirm-dialog")).not.toBeVisible();
  await page.locator('[data-repay-amount="1"]').fill("90");
  await page.locator(".lab summary").click();
  await page.locator("#advance-day").click();
  await expect(page.locator("#status")).toContainText("1일이 경과");
  await page.locator('[data-loan="1"] [data-action="repay"]').click();
  await expect(page.locator("#confirm-body")).toContainText("수수료");
  await commit(page, "상환 완료");
  await expect(page.locator('[data-loan="1"]')).toContainText("USDT 상환 완료");
  await page.locator('[data-action="claimWBMB"]').click();
  await commit(page, "WBMB 수령 완료");
  await page.locator('[data-tab="burn"]').click();
  await expect(page.locator("#cards")).toContainText("수수료 지갑");
  await page.locator('[data-action="flush"]').click();
  await commit(page, "수수료 이동 완료");
  await expect(page.locator('[data-action="flush"]')).toBeDisabled();
});

test("borrower takes a lend offer at the maker's ratio, defaults, lender receives WBMB", async ({
  page,
}) => {
  await ready(page);
  await account(page, 1);
  await page.locator('[data-tab="borrow"]').click();
  await expect(page.locator('[data-offer="2"]')).toContainText("1 WBMB당");
  await page.locator('[data-fill-amount="2"]').fill("250");
  await page.locator('[data-offer="2"] [data-action="fill"]').click();
  await expect(page.locator("#confirm-body")).toContainText(
    "배정 담보: 3 WBMB",
  );
  await expect(page.locator("#confirm-body")).toContainText(
    "내가 보내는 것: 3 WBMB",
  );
  await expect(page.locator("#confirm-body")).toContainText(
    "내가 받는 것: 250 USDT",
  );
  await commit(page, "부분 체결 완료");
  await page.locator('[data-tab="mine"]').click();
  const loan = page.locator('[data-loan="2"]');
  await loan.locator('[data-action="settle"]').click();
  await expect(page.locator("#status")).toContainText("아직 만기와 유예기간");
  await page.locator(".lab summary").click();
  await page.locator("#advance-month").click();
  await expect(page.locator("#status")).toContainText("31일이 경과");
  await page.locator("#advance-day").click();
  await expect(page.locator("#status")).toContainText("1일이 경과");
  await loan.locator('[data-action="settle"]').click();
  await expect(page.locator("#confirm-body")).toContainText(
    "대출자 귀속 3 WBMB",
  );
  await commit(page, "WBMB 정산 완료");
  await account(page, 2);
  await page.locator('[data-tab="mine"]').click();
  await page.locator('[data-action="claimWBMB"]').click();
  await commit(page, "WBMB 수령 완료");
});

test("a lend proposal asks for the required collateral and has no price-mode choice", async ({
  page,
}) => {
  await ready(page);
  await account(page, 3);
  await page.locator("#open-offer").click();
  await expect(page.locator('select[name="mode"]')).toBeHidden();
  await page.locator('select[name="side"]').selectOption("1");
  await expect(page.locator("#collateral-field")).toBeVisible();
  await expect(page.locator("#collateral-field")).toContainText("요구할 담보");
  await page.locator('input[name="total"]').fill("500");
  await page.locator('input[name="collateral"]').fill("6");
  await page.locator('#offer-form button[type="submit"]').click();
  await expect(page.locator("#confirm-body")).toContainText("6 WBMB");
  await commit(page, "거래 게시 완료");
  await page.locator('[data-tab="borrow"]').click();
  await expect(page.locator('[data-offer="3"]')).toContainText("500");
});
