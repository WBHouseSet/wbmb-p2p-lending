import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { BrowserProvider } from "ethers";
import {
  deployCouncilFixture,
  deployContract,
  us,
  wb,
} from "../scripts/deploy.mjs";

describe("council-price market", () => {
  let c, f, snap;
  const DAY = 86400;
  before(async () => {
    c = await network.create();
    const provider = new BrowserProvider(c.provider, undefined, {
      cacheTimeout: -1,
    });
    provider.pollingInterval = 10;
    f = await deployCouncilFixture(provider);
    snap = await provider.send("evm_snapshot", []);
  });
  beforeEach(async () => {
    await f.provider.send("evm_revert", [snap]);
    snap = await f.provider.send("evm_snapshot", []);
  });
  after(async () => {
    f?.provider.destroy();
    await c?.close();
  });
  const tx = async (p) => (await p).wait();
  const now = async () =>
    Number((await f.provider.getBlock("latest")).timestamp);
  async function advance(s) {
    await f.provider.send("evm_increaseTime", [s]);
    await f.provider.send("evm_mine", []);
  }
  // Lender offers 1000 USDT; borrower takes 600 and must post 10 WBMB at price 100 (60% LTV).
  async function loan600(terms = {}) {
    await tx(f.usdt.connect(f.lender).approve(f.lending.target, us(1000)));
    await tx(
      f.lending
        .connect(f.lender)
        .createOffer(1, us(1000), 0, us(10), (await now()) + 7 * DAY, {
          ...f.terms,
          aprBps: 0,
          ...terms,
        }),
    );
    const offer = await f.lending.offerCount();
    const collateral = await f.lending.quoteFill(offer, us(600));
    assert.equal(collateral, wb(10));
    await tx(f.wbmb.connect(f.borrower).approve(f.lending.target, collateral));
    await tx(
      f.lending
        .connect(f.borrower)
        .fillOffer(offer, us(600), collateral, (await now()) + 300),
    );
    return await f.lending.loanCount();
  }
  async function conserved() {
    const [u, w] = await f.lending.liabilities();
    assert.equal(await f.usdt.balanceOf(f.lending.target), u);
    assert.equal(await f.wbmb.balanceOf(f.lending.target), w);
  }

  it("exposes the bonus and stale delay and rejects bad limits", async () => {
    assert.equal(await f.lending.liquidationBonusBps(), 500n);
    assert.equal(await f.lending.staleSettleDelay(), BigInt(7 * DAY));
    const args = (bonus, delay) => [
      f.usdt.target,
      f.wbmb.target,
      f.oracle.target,
      f.feeWallet,
      500,
      3600,
      DAY,
      bonus,
      delay,
    ];
    await assert.rejects(
      deployContract("P2PLending", f.admin, args(1001, 7 * DAY)),
      /BAD_LIMITS/,
    );
    await assert.rejects(
      deployContract("P2PLending", f.admin, args(500, 59)),
      /BAD_LIMITS/,
    );
    await assert.rejects(
      deployContract("P2PLending", f.admin, args(500, 30 * DAY + 1)),
      /BAD_LIMITS/,
    );
  });

  it("rejects a priced offer whose grace is below the market minimum", async () => {
    await tx(f.usdt.connect(f.lender).approve(f.lending.target, us(1000)));
    await assert.rejects(
      f.lending
        .connect(f.lender)
        .createOffer(1, us(1000), 0, us(10), (await now()) + 7 * DAY, {
          ...f.terms,
          grace: DAY - 1,
        }),
      /BAD_GRACE/,
    );
  });

  it("price drop: lender gets debt plus 5% in WBMB, borrower keeps the rest", async () => {
    const id = await loan600();
    await assert.rejects(f.lending.settle(id), /HEALTHY/);
    await f.publishPrice(us(70)); // collateral 700, threshold 560 <= debt 600
    const q = await f.lending.quoteSettlement(id);
    assert.equal(q.toLender, wb(9)); // 600 * 1.05 / 70
    assert.equal(q.toBorrower, wb(1));
    await tx(f.lending.connect(f.lender2).settle(id));
    assert.equal(await f.lending.claimableWBMB(f.addresses[2]), wb(9));
    assert.equal(await f.lending.claimableWBMB(f.addresses[1]), wb(1));
    assert.equal(await f.lending.claimableWBMB(f.addresses[3]), 0n);
    await assert.rejects(f.lending.settle(id), /NOT_ACTIVE/);
    await conserved();
  });

  it("deep drop: the bonus is capped at the collateral", async () => {
    const id = await loan600();
    await f.publishPrice(us(70));
    await f.publishPrice(us(49)); // collateral worth 490 < 630
    const q = await f.lending.quoteSettlement(id);
    assert.equal(q.toLender, wb(10));
    assert.equal(q.toBorrower, 0n);
  });

  it("topping up collateral lifts a loan back out of liquidation", async () => {
    const id = await loan600();
    await f.publishPrice(us(70));
    await tx(f.wbmb.connect(f.borrower).approve(f.lending.target, wb(1)));
    await tx(f.lending.connect(f.borrower).addCollateral(id, wb(1)));
    await assert.rejects(f.lending.settle(id), /HEALTHY/); // 11 * 70 * 0.8 = 616 > 600
  });

  it("overdue at an unchanged price: lender gets debt plus 5%, surplus returns", async () => {
    const id = await loan600();
    await advance(30 * DAY + DAY);
    await f.publishPrice(us(100));
    const q = await f.lending.quoteSettlement(id);
    assert.equal(q.toLender, wb(6.3));
    assert.equal(q.toBorrower, wb(3.7));
  });

  it("stale price: settlement waits, repay and top-up still work", async () => {
    const id = await loan600();
    await advance(6 * DAY); // price expired, loan not yet due
    await assert.rejects(f.lending.settle(id), /STALE_PRICE/);
    await tx(f.wbmb.connect(f.borrower).approve(f.lending.target, wb(1)));
    await tx(f.lending.connect(f.borrower).addCollateral(id, wb(1)));
    await tx(f.usdt.connect(f.borrower).approve(f.lending.target, us(600)));
    await tx(f.lending.connect(f.borrower).repay(id, us(600), us(600)));
    assert.equal(await f.lending.claimableWBMB(f.addresses[1]), wb(11));
    await conserved();
  });

  it("stale price on an overdue loan: all collateral to the lender only after the extra delay", async () => {
    const id = await loan600();
    await advance(30 * DAY + DAY); // overdue, price long expired
    await assert.rejects(f.lending.settle(id), /STALE_PRICE/);
    await advance(7 * DAY - 60);
    await assert.rejects(f.lending.settle(id), /STALE_PRICE/);
    await advance(60);
    const q = await f.lending.quoteSettlement(id);
    assert.equal(q.toLender, wb(10));
    assert.equal(q.toBorrower, 0n);
    assert.equal(q.price, 0n);
    await tx(f.lending.settle(id));
    assert.equal(await f.lending.claimableWBMB(f.addresses[2]), wb(10));
    await conserved();
  });

  it("a price that dies long after the deadline still makes the lender wait the full delay", async () => {
    const id = await loan600();
    // Keep the price alive well past maturity + grace + the stale delay (day 31 + 7).
    for (let i = 0; i < 8; i++) {
      await advance(5 * DAY);
      await f.publishPrice(us(100));
    }
    assert(
      (await now()) >
        (await f.lending.getLoan(id)).maturity + BigInt(DAY + 7 * DAY),
    );
    const live = await f.lending.quoteSettlement(id);
    assert.equal(live.toLender, wb(6.3));
    assert(live.toBorrower > 0n);
    // The price expires; the wait restarts from its expiry, not from the old deadline.
    const expiry = Number(await f.oracle.validUntil());
    await advance(expiry - (await now()) + 60);
    await assert.rejects(f.lending.quoteSettlement(id), /STALE_PRICE/);
    await assert.rejects(f.lending.settle(id), /STALE_PRICE/);
    await advance(expiry + 7 * DAY - 60 - (await now()));
    await assert.rejects(f.lending.settle(id), /STALE_PRICE/);
    await advance(120);
    const q = await f.lending.quoteSettlement(id);
    assert.equal(q.toLender, wb(10));
    assert.equal(q.toBorrower, 0n);
    assert.equal(q.price, 0n);
    await tx(f.lending.settle(id));
    assert.equal(await f.lending.claimableWBMB(f.addresses[2]), wb(10));
    await conserved();
  });

  it("a price that comes back after the delay is used instead of the escape", async () => {
    const id = await loan600();
    await advance(30 * DAY + DAY + 7 * DAY);
    await f.publishPrice(us(100));
    const q = await f.lending.quoteSettlement(id);
    assert.equal(q.toLender, wb(6.3));
    assert.equal(q.toBorrower, wb(3.7));
  });

  it("an overdue borrower can still repay in full while the price is stale", async () => {
    const id = await loan600();
    await advance(30 * DAY + DAY + DAY);
    await tx(f.usdt.connect(f.borrower).approve(f.lending.target, us(600)));
    await tx(f.lending.connect(f.borrower).repay(id, us(600), us(600)));
    assert.equal(await f.lending.claimableWBMB(f.addresses[1]), wb(10));
  });

  it("with interest and an uneven price the lender gets exactly ceil(debt x 1.05 / price)", async () => {
    // Every figure below is recomputed here with BigInt, from block times and inputs only.
    const BPS = 10000n,
      YEAR = 365n * 86400n,
      UNIT = 10n ** 8n,
      APR = 1237n,
      BONUS = 500n,
      FEE = 500n;
    const ceilDiv = (a, b) => (a + b - 1n) / b;
    const timeOf = async (receipt) =>
      BigInt((await f.provider.getBlock(receipt.blockNumber)).timestamp);
    const [, borrower, lender] = f.addresses;
    await tx(f.usdt.connect(f.lender).approve(f.lending.target, us(1000)));
    await tx(
      f.lending
        .connect(f.lender)
        .createOffer(1, us(1000), 0, us(10), (await now()) + 7 * DAY, {
          ...f.terms,
          aprBps: Number(APR),
        }),
    );
    const offer = await f.lending.offerCount();
    const principal = us("617.123456789012345678");
    // 60% of the collateral value at price 100, rounded up to a whole WBMB unit.
    const collateral = ceilDiv(principal * UNIT * BPS, us(100) * 6000n);
    assert.equal(await f.lending.quoteFill(offer, principal), collateral);
    await tx(f.wbmb.connect(f.borrower).approve(f.lending.target, collateral));
    const start = await timeOf(
      await tx(
        f.lending
          .connect(f.borrower)
          .fillOffer(offer, principal, collateral, (await now()) + 300),
      ),
    );
    const id = await f.lending.loanCount();
    const maturity = start + BigInt(f.terms.duration);

    // A partial repayment nine days in: all accrued interest plus part of the principal.
    await advance(9 * DAY + 4321);
    const part = us("211.000000000000000007");
    await tx(f.usdt.connect(f.borrower).approve(f.lending.target, us(1000)));
    const paidAt = await timeOf(
      await tx(f.lending.connect(f.borrower).repay(id, part, us(1000))),
    );
    const firstNumerator = principal * APR * (paidAt - start);
    const interestPaid = firstNumerator / (BPS * YEAR);
    const carried = firstNumerator % (BPS * YEAR);
    const feePaid = (interestPaid * FEE) / BPS;
    assert.ok(interestPaid > 0n && carried > 0n);
    assert.equal(await f.lending.claimableUSDT(lender), part + interestPaid);
    assert.equal(await f.lending.feeBalance(), feePaid);

    // Overdue, settled at a price that does not divide the debt evenly.
    await advance(Number(maturity) + DAY - (await now()) + 5);
    const price = us("97.31");
    await f.publishPrice(price);
    const left = principal - part;
    const secondNumerator = left * APR * (maturity - paidAt) + carried;
    const debt =
      left +
      secondNumerator / (BPS * YEAR) +
      (secondNumerator % (BPS * YEAR) > 0n ? 1n : 0n);
    const numerator = debt * (BPS + BONUS) * UNIT;
    const toLender = ceilDiv(numerator, price * BPS);
    // The division really is inexact and the collateral really is enough, so the ceiling is what is tested.
    assert.notEqual(numerator % (price * BPS), 0n);
    assert.ok(toLender < collateral);
    const q = await f.lending.quoteSettlement(id);
    assert.equal(q.debt, debt);
    assert.equal(q.price, price);
    assert.equal(q.toLender, toLender);
    assert.equal(q.toLender + q.toBorrower, collateral);
    await tx(f.lending.connect(f.lender2).settle(id));
    assert.equal(await f.lending.claimableWBMB(lender), toLender);
    assert.equal(
      await f.lending.claimableWBMB(borrower),
      collateral - toLender,
    );
    assert.equal(await f.lending.claimableWBMB(f.addresses[3]), 0n);
    await conserved();

    // Everything is paid out and the contract ends empty.
    await tx(f.lending.connect(f.lender).closeOffer(offer));
    await tx(f.lending.connect(f.lender).claimWBMB());
    await tx(f.lending.connect(f.lender).claimUSDT());
    await tx(f.lending.connect(f.borrower).claimWBMB());
    await conserved();
    await tx(f.lending.flushFees());
    assert.equal(await f.wbmb.balanceOf(lender), wb(100) + toLender);
    assert.equal(await f.wbmb.balanceOf(borrower), wb(100) - toLender);
    assert.equal(
      await f.usdt.balanceOf(lender),
      us(10000) - principal + part + interestPaid,
    );
    assert.equal(
      await f.usdt.balanceOf(borrower),
      us(10000) + principal - part - interestPaid - feePaid,
    );
    assert.equal(await f.usdt.balanceOf(f.feeWallet), us(10000) + feePaid);
    assert.equal(await f.usdt.balanceOf(f.lending.target), 0n);
    assert.equal(await f.wbmb.balanceOf(f.lending.target), 0n);
    assert.deepEqual([...(await f.lending.liabilities())], [0n, 0n]);
  });

  it("expired price: a new fill reverts with STALE_PRICE, cancelling and claiming still work", async () => {
    const [, borrower, lender] = f.addresses;
    const id = await loan600(); // lend offer 1 keeps 400 USDT unfilled
    const lendOffer = await f.lending.offerCount();
    await tx(f.wbmb.connect(f.borrower).approve(f.lending.target, wb(105)));
    await tx(
      f.lending
        .connect(f.borrower)
        .createOffer(0, us(300), wb(5), us(10), (await now()) + 7 * DAY, {
          ...f.terms,
          aprBps: 0,
        }),
    );
    const borrowOffer = await f.lending.offerCount();
    // A part repayment leaves the lender a USDT balance to claim later.
    await tx(f.usdt.connect(f.borrower).approve(f.lending.target, us(100)));
    await tx(f.lending.connect(f.borrower).repay(id, us(100), us(100)));

    await advance(6 * DAY); // the price has expired; both offers are still open
    assert.ok((await now()) > Number(await f.oracle.validUntil()));
    await assert.rejects(f.oracle.prices(), /STALE_PRICE/);
    await assert.rejects(
      f.lending.quoteFill(lendOffer, us(100)),
      /STALE_PRICE/,
    );
    await assert.rejects(
      f.lending
        .connect(f.borrower)
        .fillOffer(lendOffer, us(100), wb(100), (await now()) + 300),
      /STALE_PRICE/,
    );
    await tx(f.usdt.connect(f.lender2).approve(f.lending.target, us(100)));
    await assert.rejects(
      f.lending
        .connect(f.lender2)
        .fillOffer(borrowOffer, us(100), wb(100), (await now()) + 300),
      /STALE_PRICE/,
    );
    assert.equal(await f.lending.loanCount(), id);

    // Cancelling credits the makers; claiming pays them out.
    await tx(f.lending.connect(f.lender).closeOffer(lendOffer));
    await tx(f.lending.connect(f.borrower).closeOffer(borrowOffer));
    assert.equal(await f.lending.claimableUSDT(lender), us(500));
    assert.equal(await f.lending.claimableWBMB(borrower), wb(5));
    const usdtBefore = await f.usdt.balanceOf(lender);
    const wbmbBefore = await f.wbmb.balanceOf(borrower);
    await tx(f.lending.connect(f.lender).claimUSDT());
    await tx(f.lending.connect(f.borrower).claimWBMB());
    assert.equal(await f.usdt.balanceOf(lender), usdtBefore + us(500));
    assert.equal(await f.wbmb.balanceOf(borrower), wbmbBefore + wb(5));
    assert.equal(await f.lending.claimableUSDT(lender), 0n);
    assert.equal(await f.lending.claimableWBMB(borrower), 0n);
    await conserved();
  });
});
