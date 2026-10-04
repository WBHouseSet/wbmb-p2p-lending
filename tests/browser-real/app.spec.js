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
import {
  Contract,
  Interface,
  JsonRpcProvider,
  formatUnits,
  parseUnits,
} from "ethers";
import { loadDeployer } from "../../scripts/deploy-bsc.mjs";
import { artifact } from "../../scripts/deploy.mjs";

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
// MOVN per loan (LEND env); the borrower pledges ≈ LEND / (price × 0.5) WBMB, so the
// default fits a borrower holding ~0.00006 WBMB at a council price near 112.
const LEND = process.env.LEND || "0.003";

// What the page may legitimately ask the wallet to sign: an exact, small approval of the
// market on one of the two tokens, or one of the market's own user functions. Anything
// else (a transfer, an approval to a stranger, an unknown contract) is refused here.
const ERC20_IFACE = new Interface([
  "function approve(address spender, uint256 value)",
]);
const MARKET_IFACE = new Interface(artifact("P2PLending").abi);
const MARKET_CALLS = new Set([
  "createOffer",
  "fillOffer",
  "closeOffer",
  "addCollateral",
  "repay",
  "settle",
  "claimMOVN",
  "claimWBMB",
  "flushFees",
]);
const APPROVAL_CAP = {
  [record.movn.toLowerCase()]: parseUnits("1", 18),
  [record.wbmb.toLowerCase()]: parseUnits("1", 8),
};
function checkCalldata(to, data, value) {
  const target = String(to).toLowerCase();
  if (value && BigInt(value) !== 0n) throw new Error("refused: value transfer");
  if (target in APPROVAL_CAP) {
    const call = ERC20_IFACE.parseTransaction({ data });
    if (
      !call ||
      call.name !== "approve" ||
      call.args.spender.toLowerCase() !== record.lending.toLowerCase() ||
      call.args.value > APPROVAL_CAP[target]
    )
      throw new Error(`refused: token call ${data.slice(0, 10)} on ${to}`);
    return;
  }
  if (target === record.lending.toLowerCase()) {
    const call = MARKET_IFACE.parseTransaction({ data });
    if (!call || !MARKET_CALLS.has(call.name))
      throw new Error(`refused: market call ${data.slice(0, 10)}`);
    return;
  }
  throw new Error(`refused: unexpected transaction target ${to}`);
}

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
        checkCalldata(to, data, value);
        const tx = await w.sendTransaction({
          to,
          data,
          value: value ? BigInt(value) : 0n,
          ...(gas ? { gasLimit: BigInt(gas) } : {}),
        });
        return tx.hash;
      }
      // The page never asks for message or typed-data signatures.
      if (method === "personal_sign" || method.startsWith("eth_signTypedData"))
        throw new Error(`refused: ${method}`);
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
// #cards carries aria-busy="true" while the page's refresh() runs; wait for it to clear
// before reading or clicking cards.
const settled = (page) =>
  expect(page.locator("#cards")).toHaveAttribute("aria-busy", "false");
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
  await settled(page);
}
async function post(page) {
  await page.locator("#open-offer").click();
  await page.locator('#offer-form [name="side"]').selectOption("1");
  await page.locator('#offer-form [name="total"]').fill(LEND);
  await page.locator('#offer-form [name="minFill"]').fill(LEND);
  await page.locator('#offer-form button[type="submit"]').click();
  await commit(page, "거래 게시 완료");
  await page.locator('[data-tab="mine"]').click();
  await settled(page);
  return page.locator("#cards [data-offer]").first().getAttribute("data-offer");
}
const mine = async (page) => {
  await page.locator("#refresh").click();
  await settled(page);
  await page.locator('[data-tab="mine"]').click();
  await settled(page);
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

// The bridge signs with real keys, so it must refuse anything the page never legitimately
// asks for, even if the page (or something injected into it) tries.
test("the wallet bridge refuses approvals to strangers, unknown market calls and message signing", async ({
  browser,
}) => {
  const page = await browser.newPage();
  const from = await wallet(page, 1);
  await page.goto(WEB_URL);
  await expect(page.locator("#status")).toContainText("연결 완료");
  const attempt = (params) =>
    page.evaluate(async ({ method, params }) => {
      try {
        await window.ethereum.request({ method, params });
        return "accepted";
      } catch (e) {
        return "refused: " + (e.message || String(e));
      }
    }, params);
  const stranger = "0x000000000000000000000000000000000000dEaD";
  const approveStranger =
    "0x095ea7b3" +
    stranger.slice(2).toLowerCase().padStart(64, "0") +
    "f".repeat(64);
  expect(
    await attempt({
      method: "eth_sendTransaction",
      params: [{ from, to: record.movn, data: approveStranger }],
    }),
  ).toMatch(/^refused/);
  expect(
    await attempt({
      method: "eth_sendTransaction",
      params: [{ from, to: stranger, data: "0x" }],
    }),
  ).toMatch(/^refused/);
  // transfer(stranger, 1) aimed at the token: not an approval to the market.
  const transferStranger =
    "0xa9059cbb" +
    stranger.slice(2).toLowerCase().padStart(64, "0") +
    "1".padStart(64, "0");
  expect(
    await attempt({
      method: "eth_sendTransaction",
      params: [{ from, to: record.wbmb, data: transferStranger }],
    }),
  ).toMatch(/^refused/);
  expect(
    await attempt({ method: "personal_sign", params: ["0x1234", from] }),
  ).toMatch(/^refused/);
  expect(
    await attempt({ method: "eth_signTypedData_v4", params: [from, "{}"] }),
  ).toMatch(/^refused/);
});

test("lender posts, borrower fills and repays, both claim; a second post is cancelled and reclaimed", async ({
  browser,
}) => {
  const B = signer(0).address,
    L = signer(1).address;
  const b0 = await balances("start borrower", B),
    l0 = await balances("start lender", L);
  expect(l0.m).toBeGreaterThanOrEqual(2n * parseUnits(LEND, 18));
  expect(b0.m).toBeGreaterThanOrEqual(parseUnits("0.001", 18)); // interest + fee

  const lender = await browser.newPage();
  await wallet(lender, 1);
  await open(lender);
  // Earlier runs may have left this lender's posts open: reclaim them through the page first.
  await lender.locator('[data-tab="mine"]').click();
  await settled(lender);
  for (;;) {
    const close = lender
      .locator('#cards [data-offer] [data-action="close"]')
      .first();
    if ((await close.count()) === 0) break;
    await close.click();
    await commit(lender, "미체결분 회수 완료");
    await lender.locator('[data-tab="mine"]').click();
    await settled(lender);
  }
  if (await lender.locator('[data-action="claimMOVN"]').isEnabled()) {
    await lender.locator('[data-action="claimMOVN"]').click();
    await commit(lender, "MOVN 수령 완료");
  }
  const l0b = await balances("lender after cleanup", L);
  const offer = await post(lender);
  // The borrower must hold the collateral this fill needs, or the run would only prove the
  // balance check (covered on the replica).
  const lending = new Contract(
    record.lending,
    ["function quoteFill(uint256,uint256) view returns (uint256)"],
    provider,
  );
  const need = await lending.quoteFill(offer, parseUnits(LEND, 18));
  console.log(`collateral needed ${formatUnits(need, 8)} WBMB`);
  expect(b0.b).toBeGreaterThanOrEqual(need);
  console.log(`posted offer #${offer}`);

  const borrower = await browser.newPage();
  await wallet(borrower, 0);
  await open(borrower);
  await borrower.locator('[data-tab="borrow"]').click();
  await settled(borrower);
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
  expect(l1.m).toBeGreaterThan(l0b.m); // principal back plus interest
  const held = await movn.balanceOf(record.lending);
  console.log(
    `market holds MOVN ${formatUnits(held, 18)} (fee not yet flushed)`,
  );
});
