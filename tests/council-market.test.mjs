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
});
