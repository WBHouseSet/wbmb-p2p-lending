import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "serial" });
// The WBMB/MOVN trade board on its own local council-market chain (playwright.swap.config.js). The fixture seeds two offers from
// 체험 지갑 3 at a council price of 100 MOVN: #1 sells 5 WBMB at 105, #2 buys 5 WBMB at 95.
async function ready(page) {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("로컬 체인 준비 완료");
}
async function account(page, n) {
  await page.locator("#demo-account").selectOption(String(n));
  await expect(page.locator("#account-label")).toHaveText(`체험 지갑 ${n}`);
}
async function board(page, n) {
  await ready(page);
  if (n) await account(page, n);
  await page.locator('[data-tab="swap"]').click();
}
async function commit(page, done) {
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-submit").click();
  await expect(page.locator("#status")).toContainText(done);
  await expect(page.locator("#confirm-dialog")).not.toBeVisible();
}
const card = (page, id) => page.locator(`[data-swap-offer="${id}"]`);
const cell = (page, id, label) =>
  card(page, id).locator("dl > div").filter({ hasText: label }).locator("dd");

test("the board lists sell and buy offers with their distance from the council price", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await board(page);
  await expect(page.locator("#tab-description")).toContainText("0.5%");
  await expect(card(page, 1)).toContainText("팝니다");
  await expect(card(page, 1)).toContainText("105");
  await expect(cell(page, 1, "남은 수량")).toHaveText("5 WBMB");
  await expect(cell(page, 1, "카운슬 가격 대비")).toHaveText("+5%");
  await expect(card(page, 2)).toContainText("삽니다");
  await expect(cell(page, 2, "카운슬 가격 대비")).toHaveText("-5%");
  expect(errors).toEqual([]);
});

test("buying from a sell offer shows what moves and swaps at once", async ({
  page,
}) => {
  await board(page, 1);
  await page.locator('[data-swap-amount="1"]').fill("2");
  await card(page, 1).locator('[data-action="swapFill"]').click();
  const body = page.locator("#confirm-body");
  await expect(body).toContainText("내가 보내는 것: 210 MOVN");
  await expect(body).toContainText("내가 받는 것: 2 WBMB");
  await expect(body).toContainText("수수료 0.5%");
  await expect(body).toContainText("수수료 지갑");
  await expect(body).not.toContainText("소각합니다");
  await commit(page, "WBMB 사기 완료");
  await expect(cell(page, 1, "남은 수량")).toHaveText("3 WBMB");
  await expect(page.locator("#wallet-balances")).toContainText("92 WBMB");
});

test("selling into a buy offer pays the price less the seller's fee", async ({
  page,
}) => {
  await board(page, 1);
  await page.locator('[data-swap-amount="2"]').fill("1");
  await card(page, 2).locator('[data-action="swapFill"]').click();
  const body = page.locator("#confirm-body");
  await expect(body).toContainText("내가 보내는 것: 1 WBMB");
  // 95 MOVN less 0.5%
  await expect(body).toContainText("내가 받는 것: 94.525 MOVN");
  await commit(page, "WBMB 팔기 완료");
  await expect(cell(page, 2, "남은 수량")).toHaveText("4 WBMB");
});

test("posting far from the council price asks twice, and a fair price posts", async ({
  page,
}) => {
  await board(page, 2);
  await page.locator("#open-offer").click();
  const form = page.locator("#swap-form");
  await expect(form).toBeVisible();
  await form.locator('[name="tradeSide"]').selectOption("0");
  await form.locator('[name="tradeAmount"]').fill("1");
  await form.locator('[name="tradePrice"]').fill("70");
  await expect(page.locator("#swap-total")).toContainText("70 MOVN");
  await form.locator('[type="submit"]').click();
  await expect(page.locator("#confirm-title")).toHaveText("가격 경고");
  await expect(page.locator("#confirm-body")).toContainText("30% 싸게");
  await page.locator("#confirm-cancel").click();
  await expect(page.locator("#status")).toContainText("취소");
  await expect(card(page, 3)).toHaveCount(0);

  await page.locator("#open-offer").click();
  await form.locator('[name="tradePrice"]').fill("101");
  await form.locator('[type="submit"]').click();
  await expect(page.locator("#confirm-title")).not.toHaveText("가격 경고");
  await expect(page.locator("#confirm-body")).toContainText(
    "내가 보내는 것: 1 WBMB",
  );
  await commit(page, "직거래 글 올리기 완료");
  await expect(cell(page, 3, "카운슬 가격 대비")).toHaveText("+1%");
  // my own offer has no fill row
  await expect(card(page, 3).locator('[data-action="swapFill"]')).toHaveCount(
    0,
  );
});

test("my trade posts are under 내 거래 and what is left can be taken back", async ({
  page,
}) => {
  await ready(page);
  await account(page, 2);
  await page.locator('[data-tab="mine"]').click();
  await expect(card(page, 3)).toBeVisible();
  await card(page, 3).locator('[data-action="swapClose"]').click();
  await expect(page.locator("#confirm-body")).toContainText("1 WBMB");
  await commit(page, "직거래 미체결분 회수 완료");
  await expect(card(page, 3)).toContainText("종료된 게시글");
  await expect(page.locator("#wallet-balances")).toContainText("100 WBMB");
});

test("trade fees collect in the contract and anyone can move them to the fee wallet", async ({
  page,
}) => {
  await ready(page);
  await account(page, 2);
  await page.locator('[data-tab="burn"]').click();
  const fees = page.locator("[data-swap-fees]");
  // 210 x 0.5% + 95 x 0.5%
  await expect(fees).toContainText("1.525");
  await fees.locator('[data-action="swapFlush"]').click();
  await commit(page, "직거래 수수료 이동 완료");
  await expect(fees.locator("strong")).toHaveText("0");
});

test("a deployment without a trade contract shows no trade tab", async ({
  page,
}) => {
  const config = await (await page.request.get("/deployment.json")).json();
  delete config.addresses.swap;
  await page.route("**/deployment.json", (route) =>
    route.fulfill({ json: config }),
  );
  await ready(page);
  await expect(page.locator('[data-tab="swap"]')).toBeHidden();
  await expect(page.locator('[data-tab="borrow"]')).toBeVisible();
});
