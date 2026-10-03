// Drives a BUILT page against a REAL chain with REAL keys: a mock browser wallet whose
// signing happens in this process, so the page never sees a key. Amounts are tiny and
// every step prints balances. On BSC this spends real MOVN, WBMB and BNB.
//
//   WEB_URL   the page under test (already served, e.g. http://127.0.0.1:5000)
//   RPC_URL   the chain the page talks to (must be the one compiled into the build)
//   KEY_FILE  mnemonic or hex key; index 0 = borrower, index 1 = lender
//   RECORD    deployment record (lending, movn, wbmb, chainId)
//
// Settlement paths are not run here: on a real chain they need maturity + grace plus a
// relayed price, which scripts/live-test-council.mjs --settle already covers.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { Contract, JsonRpcProvider, formatUnits, parseUnits } from "ethers";
import { loadDeployer } from "../../scripts/deploy-bsc.mjs";

test.describe.configure({ mode: "serial" });
const { WEB_URL, RPC_URL, KEY_FILE, RECORD } = process.env;
for (const [name, value] of Object.entries({
  WEB_URL,
  RPC_URL,
  KEY_FILE,
  RECORD,
}))
  if (!value) throw new Error(`${name} 환경 변수가 필요합니다.`);
const record = JSON.parse(fs.readFileSync(RECORD, "utf8"));
// cacheTimeout -1: the nonce must be read fresh for every signature (an instant-mining
// replica otherwise hands the second transaction the first one's nonce).
const provider = new JsonRpcProvider(RPC_URL, record.chainId, {
  staticNetwork: true,
  cacheTimeout: -1,
});
const secret = fs.readFileSync(KEY_FILE, "utf8");
const signer = (i) => loadDeployer(secret, provider, i);
const ERC20 = ["function balanceOf(address) view returns (uint256)"];
const movn = new Contract(record.movn, ERC20, provider);
const wbmb = new Contract(record.wbmb, ERC20, provider);
const LEND = "0.02"; // MOVN per loan; the borrower pledges ≈ 0.02 / (price × 0.5) WBMB

// A mock EIP-1193 provider: reads go straight to the RPC, signing requests come back here.
async function wallet(page, index) {
  const w = signer(index);
  await page.exposeFunction(
    "__walletRequest",
    async ({ method, params = [] }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts")
        return [w.address];
      if (method === "eth_chainId") return "0x" + record.chainId.toString(16);
      if (method === "eth_sendTransaction") {
        const { from, to, data, value, gas } = params[0];
        if (from.toLowerCase() !== w.address.toLowerCase())
          throw new Error("wrong from");
        // The page must only ever ask this wallet to talk to the market or its two tokens.
        const allowed = [record.lending, record.movn, record.wbmb].map((a) =>
          a.toLowerCase(),
        );
        if (!allowed.includes(to.toLowerCase()))
          throw new Error(`unexpected transaction target ${to}`);
        const tx = await w.sendTransaction({
          to,
          data,
          value: value ? BigInt(value) : 0n,
          ...(gas ? { gasLimit: BigInt(gas) } : {}),
        });
        return tx.hash;
      }
      if (method === "personal_sign") return w.signMessage(params[0]);
      if (method === "wallet_switchEthereumChain") return null;
      return provider.send(method, params);
    },
  );
  await page.addInitScript(() => {
    const listeners = {};
    window.ethereum = {
      request: (args) => window.__walletRequest(args),
      on: (n, f) => (listeners[n] = f),
      removeListener: (n) => delete listeners[n],
    };
  });
  return w.address;
}
async function balances(label, who) {
  const [m, b, bnb] = await Promise.all([
    movn.balanceOf(who),
    wbmb.balanceOf(who),
    provider.getBalance(who),
  ]);
  console.log(
    `${label} ${who}: MOVN ${formatUnits(m, 18)} · WBMB ${formatUnits(b, 8)} · BNB ${formatUnits(bnb, 18)}`,
  );
  return { m, b, bnb };
}
async function open(page) {
  await page.goto(WEB_URL);
  await expect(page.locator("#status")).toContainText("연결 완료");
  await page.locator("#connect").click();
  await expect(page.locator("#account-label")).toHaveText("연결된 지갑");
}
async function commit(page, done) {
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-submit").click();
  await expect(page.locator("#status")).toContainText(done, {
    timeout: 180000,
  });
  await page.waitForLoadState("networkidle");
}
async function post(page) {
  await page.locator("#open-offer").click();
  await page.locator('#offer-form [name="side"]').selectOption("1");
  await page.locator('#offer-form [name="total"]').fill(LEND);
  await page.locator('#offer-form [name="minFill"]').fill(LEND);
  await page.locator('#offer-form button[type="submit"]').click();
  await commit(page, "거래 게시 완료");
  await page.locator('[data-tab="mine"]').click();
  await page.waitForLoadState("networkidle");
  return page.locator("#cards [data-offer]").first().getAttribute("data-offer");
}
const mine = async (page) => {
  await page.locator("#refresh").click();
  await page.waitForLoadState("networkidle");
  await page.locator('[data-tab="mine"]').click();
  await page.waitForLoadState("networkidle");
};

test.afterEach(async ({ browser }) => {
  for (const context of browser.contexts()) await context.close();
});

test("the page refuses a wallet on another chain and shows the market's own addresses", async ({
  browser,
}) => {
  const page = await browser.newPage();
  await page.exposeFunction(
    "__walletRequest",
    async ({ method, params = [] }) => {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_requestAccounts" || method === "eth_accounts")
        return [signer(1).address];
      if (method === "wallet_switchEthereumChain") return null;
      return provider.send(method, params);
    },
  );
  await page.addInitScript(() => {
    window.ethereum = {
      request: (a) => window.__walletRequest(a),
      on() {},
      removeListener() {},
    };
  });
  await page.goto(WEB_URL);
  await expect(page.locator("#status")).toContainText("연결 완료");
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toContainText("지갑 네트워크를");
  await expect(page.locator("#wallet-panel")).toBeHidden();
  const verify = page.locator("#verify-addresses");
  await expect(verify).toContainText(record.lending);
  await expect(verify).toContainText(record.movn);
  await expect(verify).toContainText(record.wbmb);
  await expect(page.locator("#movn-risk")).toBeVisible();
});

test("lender posts, borrower fills and repays, both claim; a second post is cancelled and reclaimed", async ({
  browser,
}) => {
  const B = signer(0).address,
    L = signer(1).address;
  const b0 = await balances("start borrower", B),
    l0 = await balances("start lender", L);
  expect(l0.m).toBeGreaterThanOrEqual(parseUnits("0.04", 18));
  expect(b0.m).toBeGreaterThanOrEqual(parseUnits("0.001", 18)); // interest + fee
  expect(b0.b).toBeGreaterThan(0n);

  const lender = await browser.newPage();
  await wallet(lender, 1);
  await open(lender);
  const offer = await post(lender);
  console.log(`posted offer #${offer}`);

  const borrower = await browser.newPage();
  await wallet(borrower, 0);
  await open(borrower);
  await borrower.locator('[data-tab="borrow"]').click();
  await borrower.waitForLoadState("networkidle");
  await borrower.locator(`[data-fill-amount="${offer}"]`).fill(LEND);
  await borrower
    .locator(`[data-offer="${offer}"] [data-action="fill"]`)
    .click();
  await commit(borrower, "부분 체결 완료");
  await mine(borrower);
  const loan = await borrower
    .locator("#cards [data-loan]")
    .first()
    .getAttribute("data-loan");
  console.log(`filled as loan #${loan}`);
  const mid = await balances("after fill borrower", B);
  expect(mid.m - b0.m).toBe(parseUnits(LEND, 18));

  await borrower.locator(`[data-loan="${loan}"] [data-action="repay"]`).click();
  await commit(borrower, "상환 완료");
  await expect(borrower.locator(`[data-loan="${loan}"]`)).toContainText(
    "MOVN 상환 완료",
  );
  await borrower.locator('[data-action="claimWBMB"]').click();
  await commit(borrower, "WBMB 수령 완료");
  await mine(lender);
  await lender.locator('[data-action="claimMOVN"]').click();
  await commit(lender, "MOVN 수령 완료");

  // Second post, cancelled unfilled, MOVN reclaimed.
  const second = await post(lender);
  await lender
    .locator(`[data-offer="${second}"] [data-action="close"]`)
    .click();
  await commit(lender, "미체결분 회수 완료");
  await lender.locator('[data-action="claimMOVN"]').click();
  await commit(lender, "MOVN 수령 완료");

  const b1 = await balances("end borrower", B),
    l1 = await balances("end lender", L);
  expect(b1.b).toBe(b0.b); // collateral came back whole
  expect(b1.m).toBeLessThan(b0.m); // interest + fee paid
  expect(b1.m).toBeGreaterThan(b0.m - parseUnits("0.001", 18));
  expect(l1.m).toBeGreaterThan(l0.m); // principal back plus interest
  const held = await movn.balanceOf(record.lending);
  console.log(
    `market holds MOVN ${formatUnits(held, 18)} (fee not yet flushed)`,
  );
});
