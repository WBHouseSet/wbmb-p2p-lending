import { test, expect } from "@playwright/test";
import { Contract, JsonRpcProvider } from "ethers";
import { artifact, deployContract, us, wb } from "../../scripts/deploy.mjs";
import { COUNCIL_POLICY_ID } from "../../src/council-signing.mjs";

test.describe.configure({ mode: "serial" });
// The suite's local chain (playwright.council.config.js). Node-side calls use its unlocked accounts.
const RPC = "http://127.0.0.1:18562";
const DAY = 86400;
const STANDARD = {
  aprBps: 1000,
  haircutBps: 5000,
  liquidationBps: 7000,
  duration: 14 * DAY,
  grace: DAY,
  mode: 0,
};
// Runs `fn` with a provider on the suite's chain, for what the page itself never does:
// posting terms the form does not offer, or deploying a second market.
async function onChain(fn) {
  const provider = new JsonRpcProvider(RPC, 31337, {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  provider.pollingInterval = 50;
  try {
    return await fn(provider);
  } finally {
    provider.destroy();
  }
}
const deployment = async (page) =>
  (await page.request.get("/deployment.json")).json();
// Posts an offer straight to the contract from local account `index` (체험 지갑 `index`).
async function postDirect(
  provider,
  config,
  index,
  side,
  total,
  collateral,
  terms,
) {
  const maker = await provider.getSigner(index);
  const lending = new Contract(
    config.addresses.lending,
    artifact("P2PLending").abi,
    maker,
  );
  const token = new Contract(
    side === 1 ? config.addresses.usdt : config.addresses.wbmb,
    ["function approve(address,uint256) returns (bool)"],
    maker,
  );
  await (
    await token.approve(lending.target, side === 1 ? total : collateral)
  ).wait();
  const expires = (await provider.getBlock("latest")).timestamp + 7 * DAY;
  await (
    await lending.createOffer(side, total, collateral, us(10), expires, terms)
  ).wait();
  return Number(await lending.offerCount());
}
// A second council market on the same chain and tokens whose price contract has no report yet.
async function marketWithoutPrice(provider, config, minGrace) {
  const admin = await provider.getSigner(0);
  const oracle = await deployContract("CouncilPricePolicy", admin, [
    [await (await provider.getSigner(4)).getAddress()],
    1,
    COUNCIL_POLICY_ID,
    6 * DAY,
    3000,
    43200,
  ]);
  const lending = await deployContract("P2PLending", admin, [
    config.addresses.usdt,
    config.addresses.wbmb,
    oracle.target,
    config.feeWallet,
    500,
    3600,
    minGrace,
    500,
    7 * DAY,
  ]);
  return {
    ...config,
    addresses: {
      ...config.addresses,
      lending: lending.target,
      oracle: oracle.target,
    },
  };
}
// Serves `config` as the page's deployment.json.
const serve = (page, config) =>
  page.route("**/deployment.json", (route) => route.fulfill({ json: config }));
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
// A loan card's liquidation block: its price ("price") or how far the price is from it ("margin").
const liq = (page, loan, part) =>
  page.locator(`[data-loan="${loan}"] [data-liq-${part}]`);
// The dd next to an offer card's dt label.
const offerCell = (page, offer, label) =>
  page
    .locator(`[data-offer="${offer}"] dl > div`)
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
  // The terms every listed offer shares are stated once, above the cards, not on each card.
  const terms = page.locator("#market-terms");
  await expect(terms).toContainText("담보 가치의 50%까지");
  await expect(terms).toContainText("빚이 담보 가치의 70%에 닿으면");
  await expect(terms).toContainText("약 28.6% 내릴 때");
  await expect(terms).toContainText("대출자는 빚 + 10%어치의 WBMB");
  await expect(terms).toContainText("만기 + 유예 1일");
  await expect(terms).toContainText("이자의 5%");
  await expect(terms).toContainText(
    "정산될 때는 못 낸 이자의 5%를 남은 담보에서 WBMB로 뗌",
  );
  // The fee tab says where settlement fees go and shows what the fee wallet can collect.
  await page.locator('[data-tab="burn"]').click();
  await expect(page.locator("#tab-description")).toContainText(
    "정산으로 끝난 대출은 못 낸 이자의 5%가 WBMB로 쌓입니다",
  );
  await expect(page.locator("#cards")).toContainText("정산 수수료 · WBMB");
  await page.locator('[data-tab="borrow"]').click();
  await expect(page.locator('[data-offer="2"]')).not.toContainText("담보 여유");
  await expect(page.locator('[data-offer="2"]')).not.toContainText(
    "비표준 조건",
  );
  expect(errors).toEqual([]);
});

test("the fill dialog tells a lender what settlement pays: debt plus the bonus, not all collateral", async ({
  page,
}) => {
  await ready(page);
  await account(page, 2);
  await page.locator('[data-tab="lend"]').click();
  // Seeded borrow request: 350 USDT against 10 WBMB.
  await page.locator('[data-fill-amount="1"]').fill("350");
  await page.locator('[data-offer="1"] [data-action="fill"]').click();
  const body = page.locator("#confirm-body");
  await expect(body).toContainText("내가 보내는 것: 350 USDT");
  await expect(body).toContainText(
    "내가 받는 것: 상환되면 원금과 이자(USDT), 정산되면 부채에 보너스 10%를 더한 만큼의 WBMB(담보가 모자라면 담보 전부)",
  );
  await expect(body).not.toContainText("미상환이면 담보 WBMB");
  await expect(body).toContainText("청산선 70%");
  await expect(body).toContainText("청산 가격: 50 USDT 이하");
  await expect(body).toContainText("나머지 담보는 차입자에게 돌아갑니다");
  await page.locator("#confirm-cancel").click();
  await expect(page.locator("#status")).toContainText("거래를 취소했습니다");
});

test("borrower takes a lend offer, price falls, top-up rescues, further fall settles with a 10% bonus", async ({
  page,
}) => {
  await ready(page);
  await account(page, 1);
  await page.locator('[data-tab="borrow"]').click();
  await page.locator('[data-fill-amount="2"]').fill("700");
  await page.locator('[data-offer="2"] [data-action="fill"]').click();
  await expect(page.locator("#confirm-body")).toContainText(
    "배정 담보: 14 WBMB",
  );
  // Before confirming, the borrower sees where this fill would be liquidated and what it costs:
  // 700 / (14 WBMB * 0.7) = 71.43, and settlement pays the lender the debt plus the on-chain bonus.
  await expect(page.locator("#confirm-body")).toContainText("청산선 70%");
  await expect(page.locator("#confirm-body")).toContainText(
    "청산 가격: 71.43 USDT 이하",
  );
  await expect(page.locator("#confirm-body")).toContainText(
    "부채에 보너스 10%를 더한 만큼의 WBMB가 대출자에게 가고 나머지 담보는 차입자에게 돌아갑니다",
  );
  await expect(page.locator("#confirm-body")).toContainText(
    "이때 못 낸 이자의 5%가 수수료로 돌려받을 담보에서 빠집니다",
  );
  await commit(page, "부분 체결 완료");
  await page.locator('[data-tab="mine"]').click();
  // The lender's share is named as going to the lender, the rest to the borrower.
  await expect(page.locator('[data-loan="1"] .loan-detail')).toContainText(
    "나머지는 차입자에게 돌아갑니다",
  );
  // debt 700 / (14 WBMB * 0.7) = 71.43
  // Fill happens at price 100, so the loan can lose 28.6% of the price before liquidation.
  // The seeded offer charges 10% APR, so a few seconds of interest may move the last digits.
  await expect(liq(page, 1, "price")).toHaveText("71.43 USDT");
  await expect(liq(page, 1, "margin")).toHaveText(/^28\.[56]% 더 내리면 청산$/);
  await expect(page.locator('[data-loan="1"] .liq')).toHaveClass(/safe/);
  await setPrice(page, 70);
  await page.locator('[data-topup-amount="1"]').fill("1");
  await page.locator('[data-loan="1"] [data-action="topup"]').click();
  await commit(page, "담보 추가 완료");
  await page.locator('[data-loan="1"] [data-action="settle"]').click();
  await expect(page.locator("#status")).toContainText(
    "가격 청산 조건에 해당하지 않습니다",
  );
  await setPrice(page, 55);
  await expect(liq(page, 1, "margin")).toHaveText("청산 대상");
  await expect(page.locator('[data-loan="1"] .liq')).toHaveClass(/hit/);
  await page.locator('[data-loan="1"] [data-action="settle"]').click();
  // 700 * 1.1 / 55 = 14 WBMB to the lender, 1 of the 15 back to the borrower
  // The seeded offer charges 10% APR, so a few seconds of interest may show in the last digits.
  await expect(page.locator("#confirm-body")).toContainText(
    /대출자 귀속 14(\.0000\d+)? WBMB/,
  );
  await expect(page.locator("#confirm-body")).toContainText(
    /차입자 반환 (1|0\.9999\d+) WBMB/,
  );
  await expect(page.locator("#confirm-body")).toContainText("보너스 10%");
  // A few seconds of unpaid interest: a fee of a few WBMB base units, shown as its own line.
  await expect(page.locator("#confirm-body")).toContainText(
    /수수료 0\.0000\d+ WBMB \(못 낸 이자의 5%\)/,
  );
  await commit(page, "WBMB 정산 완료");
  await expect(page.locator(".claim-box")).toContainText(/(1|0\.9999\d+) WBMB/);
});

test("posting a lend offer uses the council margins, then a fill gets the 70% liquidation line", async ({
  page,
}) => {
  await ready(page);
  await setPrice(page, 100);
  await account(page, 2);
  await page.locator("#open-offer").click();
  await page.locator('#offer-form [name="side"]').selectOption("1");
  await expect(page.locator("#collateral-field")).toBeHidden();
  await expect(page.locator("#terms-note")).toContainText("50%");
  await expect(page.locator("#terms-note")).toContainText("70%");
  await expect(page.locator("#terms-note")).toContainText("10%");
  // The stale-price rule is read from the contract (7 days on the local market).
  await expect(page.locator("#terms-note")).toContainText(
    "가격 갱신이 끊긴 채로 유예 종료와 가격 만료 뒤 각각 7일이 지나면 마지막 가격으로 정산됩니다.",
  );
  await page.locator('#offer-form button[type="submit"]').click();
  await commit(page, "거래 게시 완료");
  await account(page, 1);
  await page.locator('[data-tab="borrow"]').click();
  await page.locator('[data-fill-amount="3"]').fill("90");
  await page.locator('[data-offer="3"] [data-action="fill"]').click();
  // 90 USDT at 50% margin and price 100 needs 1.8 WBMB.
  await expect(page.locator("#confirm-body")).toContainText(
    "배정 담보: 1.8 WBMB",
  );
  await commit(page, "부분 체결 완료");
  await page.locator('[data-tab="mine"]').click();
  // The posted terms were 50% margin / 70% liquidation: 90 / (1.8 * 0.7) = 71.43.
  await expect(liq(page, 2, "price")).toHaveText("71.43 USDT");
  await expect(page.locator('[data-loan="2"] .mode')).toContainText(
    "갚는 기한",
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
  await expect(liq(page, 3, "margin")).toHaveText("가격 만료");
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

test("offers posted straight to the contract with other margins are not listed; the poster can still cancel", async ({
  page,
}) => {
  await ready(page);
  await setPrice(page, 100); // the previous test left the price expired
  const config = await deployment(page);
  const [lendId, borrowId] = await onChain(async (provider) => [
    // Margin 50% like the form, but a liquidation line of 51%: a 2% price drop would settle it.
    await postDirect(provider, config, 3, 1, us(500), 0n, {
      ...STANDARD,
      liquidationBps: 5100,
    }),
    // A borrow request with a 1% margin.
    await postDirect(provider, config, 3, 0, us(99), wb(1), {
      ...STANDARD,
      haircutBps: 100,
      liquidationBps: 9950,
    }),
  ]);
  // The poster sees both, labelled, with their real terms and a way to take them back.
  // (Selecting the wallet reloads the lists, so the market tabs below show the new state.)
  await account(page, 3);
  await page.locator('[data-tab="mine"]').click();
  for (const id of [lendId, borrowId])
    await expect(page.locator(`[data-offer="${id}"]`)).toContainText(
      "비표준 조건",
    );
  await expect(offerCell(page, lendId, "청산선")).toHaveText("51%");
  await expect(offerCell(page, borrowId, "담보 여유")).toHaveText("1%");
  await expect(
    page.locator(`[data-offer="${lendId}"] [data-action="fill"]`),
  ).toHaveCount(0);
  // Neither is offered on the market tabs, to the poster or to anyone else.
  for (const viewer of [3, 1]) {
    await account(page, viewer);
    await page.locator('[data-tab="borrow"]').click();
    await expect(page.locator('[data-offer="2"]')).toBeVisible();
    await expect(page.locator(`[data-offer="${lendId}"]`)).toHaveCount(0);
    await page.locator('[data-tab="lend"]').click();
    await expect(page.locator('[data-offer="1"]')).toBeVisible();
    await expect(page.locator(`[data-offer="${borrowId}"]`)).toHaveCount(0);
  }
  await account(page, 3);
  await page.locator('[data-tab="mine"]').click();
  await page.locator(`[data-offer="${lendId}"] [data-action="close"]`).click();
  await commit(page, "미체결분 회수 완료");
  await expect(page.locator(".claim-box")).toContainText("500 USDT");
  // A standard offer of one's own carries no such label.
  await account(page, 2);
  await page.locator('[data-tab="mine"]').click();
  await expect(page.locator('[data-offer="2"]')).toBeVisible();
  await expect(page.locator('[data-offer="2"]')).not.toContainText(
    "비표준 조건",
  );
});

test("a borrow request with too little collateral is refused by the form, and one already on chain says why it cannot be filled", async ({
  page,
}) => {
  await ready(page);
  await account(page, 3);
  await page.locator("#open-offer").click();
  await page.locator('#offer-form [name="total"]').fill("90");
  await page.locator('#offer-form [name="collateral"]').fill("0.01");
  // 90 USDT at 50% of collateral value and price 100 needs 1.8 WBMB.
  await expect(page.locator("#collateral-hint")).toContainText("최소 1.8 WBMB");
  await page.locator('#offer-form button[type="submit"]').click();
  await expect(page.locator("#status")).toContainText("담보가 부족합니다");
  await expect(page.locator("#status")).toContainText("최소 1.8 WBMB");
  await expect(page.locator("#confirm-dialog")).not.toBeVisible();
  // Enough collateral clears the warning and goes on to the confirmation.
  await page.locator('#offer-form [name="collateral"]').fill("1.8");
  await expect(page.locator("#collateral-hint")).not.toHaveClass(/warning/);
  await page.locator('#offer-form button[type="submit"]').click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-cancel").click();
  // The contract itself accepts such a request, so one can already be on chain.
  const config = await deployment(page);
  const id = await onChain((provider) =>
    postDirect(provider, config, 3, 0, us(90), wb("0.01"), STANDARD),
  );
  await account(page, 2);
  await page.locator('[data-tab="lend"]').click();
  const card = page.locator(`[data-offer="${id}"]`);
  await expect(card).toContainText("담보 부족");
  await expect(card).toContainText("최소 1.8 WBMB");
  await expect(card.locator('[data-action="fill"]')).toHaveCount(0);
  // A covered request shows what is pledged and can be filled as before.
  await expect(offerCell(page, 1, "맡긴 담보")).toContainText("WBMB");
  await expect(
    page.locator('[data-offer="1"] [data-action="fill"]'),
  ).toBeVisible();
  // The poster is told how to fix it.
  await account(page, 3);
  await page.locator('[data-tab="mine"]').click();
  await expect(card).toContainText("회수한 뒤 담보를 늘려 다시 올리세요");
});

test("before the first price report the page says so, shows no number and blocks fills", async ({
  page,
}) => {
  const config = await onChain(async (provider) => {
    const fresh = await marketWithoutPrice(
      provider,
      await deployment(page),
      DAY,
    );
    await postDirect(provider, fresh, 2, 1, us(500), 0n, STANDARD);
    return fresh;
  });
  await serve(page, config);
  await ready(page);
  await expect(page.locator("#price-state")).toContainText("가격 미등록");
  await expect(page.locator("#price-state")).not.toContainText("가격 만료");
  await expect(page.locator("#current-price")).toHaveText("—");
  await expect(page.locator("#week-price")).toHaveText("—");
  await account(page, 1);
  await page.locator('[data-tab="borrow"]').click();
  await page.locator('[data-offer="1"] [data-action="fill"]').click();
  await expect(page.locator("#status")).toContainText(
    "첫 카운슬 가격이 아직 등록되지 않아",
  );
  await expect(page.locator("#confirm-dialog")).not.toBeVisible();
});

test("a refused grace names the market's own minimum, read from the chain", async ({
  page,
}) => {
  // This market's minimum grace is 2 days, so the form's 1-day grace is refused by the contract.
  const config = await onChain(async (provider) =>
    marketWithoutPrice(provider, await deployment(page), 2 * DAY),
  );
  await serve(page, config);
  await ready(page);
  await account(page, 2);
  await page.locator("#open-offer").click();
  await page.locator('#offer-form [name="side"]').selectOption("1");
  await page.locator('#offer-form button[type="submit"]').click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-submit").click();
  await expect(page.locator("#status")).toContainText(
    "이 시장은 유예 2일 이상인 조건만 게시할 수 있습니다",
  );
});
