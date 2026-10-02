// Runs P2PLending against the REAL USDT and WBMB contracts: their deployed bytecode and
// storage are downloaded from BSC mainnet (read-only) and installed at the same addresses
// on a local chain. Test balances are written straight into local storage.
// Public RPCs do not serve the historical state a full fork needs, hence this replica.
// Nothing here sends a transaction to the real chain.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import {
  BrowserProvider,
  JsonRpcProvider,
  Contract,
  ZeroAddress,
  AbiCoder,
  keccak256,
  formatUnits,
  toBeHex,
} from "ethers";
import { deployContract, us, wb } from "../../scripts/deploy.mjs";
import { BSC } from "../../config/bsc.mjs";
import {
  COUNCIL_POLICY_ID,
  submitCouncilReport,
} from "../../src/council-signing.mjs";

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];

async function installRealToken(local, real, address) {
  const code = await real.getCode(address);
  assert.ok(code.length > 2, "real token code not found");
  await local.send("hardhat_setCode", [address, code]);
  for (let slot = 0; slot < 16; slot++) {
    const value = await real.getStorage(address, slot);
    if (BigInt(value) !== 0n)
      await local.send("hardhat_setStorageAt", [address, toBeHex(slot), value]);
  }
}
// Finds the balances mapping slot by trial, then credits `amount` to `who`.
async function give(local, token, who, amount) {
  for (let slot = 0; slot < 16; slot++) {
    const key = keccak256(
      AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [who, slot]),
    );
    const old = await local.getStorage(token.target, key);
    await local.send("hardhat_setStorageAt", [
      token.target,
      key,
      toBeHex(amount, 32),
    ]);
    if ((await token.balanceOf(who)) === amount) return;
    await local.send("hardhat_setStorageAt", [token.target, key, old]);
  }
  throw new Error("balance slot not found");
}

describe("real BSC USDT and WBMB bytecode", () => {
  let c, provider, usdt, wbmb, lending, borrower, lender, feeWallet, A;
  const gas = {};
  const TERMS = {
    aprBps: 1200,
    haircutBps: 0,
    liquidationBps: 0,
    duration: 30 * 86400,
    grace: 86400,
    mode: 1,
  };
  const tx = async (label, p) => {
    const r = await (await p).wait();
    if (label) gas[label] = r.gasUsed;
    return r;
  };
  const now = async () => Number((await provider.getBlock("latest")).timestamp);
  async function advance(s) {
    await provider.send("evm_increaseTime", [s]);
    await provider.send("evm_mine", []);
  }
  async function conserved() {
    const [u, w] = await lending.liabilities();
    assert.equal(await usdt.balanceOf(lending.target), u);
    assert.equal(await wbmb.balanceOf(lending.target), w);
  }

  before(async () => {
    c = await network.create();
    provider = new BrowserProvider(c.provider, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 10;
    const real = new JsonRpcProvider(
      process.env.BSC_RPC_URL || BSC.rpcUrl,
      BSC.chainId,
      { staticNetwork: true },
    );
    const [admin, b, l, f] = await Promise.all(
      [0, 1, 2, 7].map((i) => provider.getSigner(i)),
    );
    borrower = b;
    lender = l;
    feeWallet = f;
    A = {
      borrower: await b.getAddress(),
      lender: await l.getAddress(),
      fee: await f.getAddress(),
    };
    usdt = new Contract(BSC.usdt, ERC20, provider);
    wbmb = new Contract(BSC.wbmb, ERC20, provider);
    await installRealToken(provider, real, BSC.usdt);
    await installRealToken(provider, real, BSC.wbmb);
    real.destroy();
    await give(provider, wbmb, A.borrower, wb(20));
    await give(provider, usdt, A.borrower, us(100));
    await give(provider, usdt, A.lender, us(3000));
    lending = await deployContract("P2PLending", admin, [
      BSC.usdt,
      BSC.wbmb,
      ZeroAddress,
      A.fee,
      BSC.feeBps,
      3600,
      86400,
      0,
      0,
    ]);
    gas.deploy = (await lending.deploymentTransaction().wait()).gasUsed;
  });
  after(async () => {
    if (provider) {
      const price = 100000000n; // 0.1 gwei, BSC floor-level gas price; adjust if the chain price differs
      console.log("\n  gas used (BNB cost at 0.1 gwei):");
      for (const [k, v] of Object.entries(gas))
        console.log(
          `    ${k.padEnd(14)} ${String(v).padStart(8)}  ${formatUnits(v * price, 18)} BNB`,
        );
    }
    provider?.destroy();
    await c?.close();
  });

  it("real tokens have the decimals the contract requires", async () => {
    assert.equal(await usdt.decimals(), 18n);
    assert.equal(await wbmb.decimals(), 8n);
    assert.equal(await wbmb.balanceOf(A.borrower), wb(20));
  });

  it("borrow offer: escrow, partial fill, interest, full repayment, claims — exact balances with real tokens", async () => {
    await tx("approve", wbmb.connect(borrower).approve(lending.target, wb(10)));
    await tx(
      "createOffer",
      lending
        .connect(borrower)
        .createOffer(0, us(900), wb(10), us(10), (await now()) + 604800, TERMS),
    );
    assert.equal(await wbmb.balanceOf(lending.target), wb(10));
    await tx(null, usdt.connect(lender).approve(lending.target, us(90)));
    const before_ = await usdt.balanceOf(A.borrower);
    await tx(
      "fillOffer",
      lending.connect(lender).fillOffer(1, us(90), wb(1), (await now()) + 300),
    );
    assert.equal((await usdt.balanceOf(A.borrower)) - before_, us(90));
    await conserved();
    await advance(30 * 86400);
    const [interest, fee, total] = await lending.quoteRepay(1, us(90));
    assert.equal(interest, 887671232876712329n); // 90 * 12% * 30/365, rounded up
    await tx(null, usdt.connect(borrower).approve(lending.target, total));
    await tx("repay", lending.connect(borrower).repay(1, us(90), total));
    const w0 = await wbmb.balanceOf(A.borrower),
      u0 = await usdt.balanceOf(A.lender),
      f0 = await usdt.balanceOf(A.fee);
    await tx("claimWBMB", lending.connect(borrower).claimWBMB());
    await tx("claimUSDT", lending.connect(lender).claimUSDT());
    await tx("flushFees", lending.flushFees());
    assert.equal((await wbmb.balanceOf(A.borrower)) - w0, wb(1));
    assert.equal((await usdt.balanceOf(A.lender)) - u0, us(90) + interest);
    assert.equal((await usdt.balanceOf(A.fee)) - f0, fee);
    await tx("closeOffer", lending.connect(borrower).closeOffer(1));
    await tx(null, lending.connect(borrower).claimWBMB());
    await conserved();
    assert.equal(await wbmb.balanceOf(lending.target), 0n);
    assert.equal(await usdt.balanceOf(lending.target), 0n);
  });

  it("lend offer: borrower posts the fixed collateral, defaults, lender receives real WBMB after grace", async () => {
    await tx(null, usdt.connect(lender).approve(lending.target, us(1000)));
    await tx(
      null,
      lending
        .connect(lender)
        .createOffer(
          1,
          us(1000),
          wb(12),
          us(10),
          (await now()) + 604800,
          TERMS,
        ),
    );
    const collateral = await lending.quoteFill(2, us(250));
    assert.equal(collateral, wb(3));
    await tx(null, wbmb.connect(borrower).approve(lending.target, collateral));
    await tx(
      null,
      lending
        .connect(borrower)
        .fillOffer(2, us(250), collateral, (await now()) + 300),
    );
    const loan = await lending.loanCount();
    await assert.rejects(lending.settle(loan), /NOT_OVERDUE/);
    await advance(31 * 86400 + 1);
    await tx("settle", lending.settle(loan));
    const w0 = await wbmb.balanceOf(A.lender);
    await tx(null, lending.connect(lender).claimWBMB());
    assert.equal((await wbmb.balanceOf(A.lender)) - w0, wb(3));
    await tx(null, lending.connect(lender).closeOffer(2));
    await tx(null, lending.connect(lender).claimUSDT());
    await conserved();
    assert.equal(await wbmb.balanceOf(lending.target), 0n);
    assert.equal(await usdt.balanceOf(lending.target), 0n);
  });

  it("interest-only and partial repayments, then a stranger closes the expired offer for the maker", async () => {
    await tx(null, wbmb.connect(borrower).approve(lending.target, wb(4)));
    const expiry = (await now()) + 3600;
    await tx(
      null,
      lending
        .connect(borrower)
        .createOffer(0, us(360), wb(4), us(10), expiry, TERMS),
    );
    const offer = await lending.offerCount();
    await tx(null, usdt.connect(lender).approve(lending.target, us(180)));
    await tx(
      null,
      lending
        .connect(lender)
        .fillOffer(offer, us(180), wb(2), (await now()) + 300),
    );
    const loan = await lending.loanCount();
    await advance(10 * 86400);
    await tx(null, usdt.connect(borrower).approve(lending.target, us(400)));
    const [interest1] = await lending.quoteRepay(loan, 0);
    await tx(null, lending.connect(borrower).repay(loan, 0, us(400))); // interest only
    // the quote is one block old, so a second or two more interest has accrued
    const paid = await lending.claimableUSDT(A.lender);
    assert.ok(paid >= interest1 && paid - interest1 < us("0.0001"));
    await tx(null, lending.connect(borrower).repay(loan, us(80), us(400))); // partial principal
    const l = await lending.getLoan(loan);
    assert.equal(l.principal, us(100));
    assert.equal(l.collateral, wb(2)); // partial repayment releases no collateral
    assert.equal(await lending.claimableWBMB(A.borrower), 0n);
    await conserved();
    // the unfilled half expired long ago; anyone may close it but only the maker is credited
    await tx(null, lending.connect(lender).closeOffer(offer));
    assert.equal(await lending.claimableWBMB(A.borrower), wb(2));
    assert.equal(await lending.claimableWBMB(A.lender), 0n);
    // an exact one-block-old quote is correctly rejected as slippage; a cap above it is accepted
    const [, , stale] = await lending.quoteRepay(loan, us(100));
    await advance(60);
    await assert.rejects(
      lending.connect(borrower).repay(loan, us(100), stale),
      /REPAY_SLIPPAGE/,
    );
    await tx(null, lending.connect(borrower).repay(loan, us(100), us(400)));
    const w0 = await wbmb.balanceOf(A.borrower);
    await tx(null, lending.connect(borrower).claimWBMB());
    assert.equal((await wbmb.balanceOf(A.borrower)) - w0, wb(4));
    await tx(null, lending.connect(lender).claimUSDT());
    await tx(null, lending.flushFees());
    await conserved();
    assert.equal(await wbmb.balanceOf(lending.target), 0n);
    assert.equal(await usdt.balanceOf(lending.target), 0n);
  });
});

describe("council-price market on real BSC USDT and WBMB bytecode", () => {
  let c, provider, usdt, wbmb, lending, oracle, borrower, lender, reporter, A;
  const TERMS = {
    aprBps: 0,
    haircutBps: 4000,
    liquidationBps: 8000,
    duration: 30 * 86400,
    grace: 86400,
    mode: 0,
  };
  const tx = async (p) => (await p).wait();
  const now = async () => Number((await provider.getBlock("latest")).timestamp);
  async function publish(price) {
    const t = await now();
    await tx(
      submitCouncilReport(
        oracle.connect(reporter),
        {
          policyId: COUNCIL_POLICY_ID,
          roundId: Number(await oracle.lastRoundId()) + 1,
          price: us(price),
          confirmedAt: t,
          validUntil: t + 6 * 86400 - 60,
        },
        [reporter],
      ),
    );
  }

  before(async () => {
    c = await network.create();
    provider = new BrowserProvider(c.provider, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 10;
    const real = new JsonRpcProvider(
      process.env.BSC_RPC_URL || BSC.rpcUrl,
      BSC.chainId,
      { staticNetwork: true },
    );
    const [admin, b, l, f, r] = await Promise.all(
      [0, 1, 2, 7, 4].map((i) => provider.getSigner(i)),
    );
    borrower = b;
    lender = l;
    reporter = r;
    A = {
      borrower: await b.getAddress(),
      lender: await l.getAddress(),
      fee: await f.getAddress(),
    };
    usdt = new Contract(BSC.usdt, ERC20, provider);
    wbmb = new Contract(BSC.wbmb, ERC20, provider);
    await installRealToken(provider, real, BSC.usdt);
    await installRealToken(provider, real, BSC.wbmb);
    real.destroy();
    await give(provider, wbmb, A.borrower, wb(20));
    await give(provider, usdt, A.lender, us(3000));
    oracle = await deployContract("CouncilPricePolicy", admin, [
      [await r.getAddress()],
      1,
      COUNCIL_POLICY_ID,
      BSC.council.maxAge,
      9000,
      0,
    ]);
    await publish(100);
    lending = await deployContract("P2PLending", admin, [
      BSC.usdt,
      BSC.wbmb,
      oracle.target,
      A.fee,
      BSC.feeBps,
      3600,
      86400,
      BSC.council.liquidationBonusBps,
      BSC.council.staleSettleDelay,
    ]);
  });
  after(async () => {
    provider?.destroy();
    await c?.close();
  });

  it("fills at the council price, settles with the bonus and pays out exact token amounts", async () => {
    await tx(usdt.connect(lender).approve(lending.target, us(1000)));
    await tx(
      lending
        .connect(lender)
        .createOffer(1, us(1000), 0, us(10), (await now()) + 86400, TERMS),
    );
    const collateral = await lending.quoteFill(1, us(600));
    assert.equal(collateral, wb(10));
    await tx(wbmb.connect(borrower).approve(lending.target, collateral));
    const usdtBefore = await usdt.balanceOf(A.borrower);
    await tx(
      lending
        .connect(borrower)
        .fillOffer(1, us(600), collateral, (await now()) + 300),
    );
    assert.equal(await usdt.balanceOf(A.borrower), usdtBefore + us(600));
    await publish(70);
    await tx(lending.connect(lender).settle(1));
    const lenderBefore = await wbmb.balanceOf(A.lender);
    const borrowerBefore = await wbmb.balanceOf(A.borrower);
    await tx(lending.connect(lender).claimWBMB());
    await tx(lending.connect(borrower).claimWBMB());
    assert.equal(await wbmb.balanceOf(A.lender), lenderBefore + wb(9));
    assert.equal(await wbmb.balanceOf(A.borrower), borrowerBefore + wb(1));
    await tx(lending.connect(lender).closeOffer(1));
    await tx(lending.connect(lender).claimUSDT());
    const [u, w] = await lending.liabilities();
    assert.equal(u, 0n);
    assert.equal(w, 0n);
    assert.equal(await usdt.balanceOf(lending.target), 0n);
    assert.equal(await wbmb.balanceOf(lending.target), 0n);
  });
});
