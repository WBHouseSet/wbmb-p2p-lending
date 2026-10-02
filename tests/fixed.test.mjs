import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { BrowserProvider, ZeroAddress } from "ethers";
import { deployContract, us, wb } from "../scripts/deploy.mjs";

// Oracle-free market: no price policy, collateral ratio fixed by the maker, maturity-only settlement.
describe("oracle-free fixed-ratio market", () => {
  let c, provider, admin, borrower, lender, lender2, feeWallet, addr;
  let usdt, wbmb, lending, snap, addr0;
  const TERMS = {
    aprBps: 1200,
    haircutBps: 0,
    liquidationBps: 0,
    duration: 30 * 86400,
    grace: 86400,
    mode: 1,
  };
  const tx = async (p) => (await p).wait();
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
  async function borrowOffer(total = 900, collateral = 10, terms = {}) {
    await tx(wbmb.connect(borrower).approve(lending.target, wb(collateral)));
    await tx(
      lending
        .connect(borrower)
        .createOffer(
          0,
          us(total),
          wb(collateral),
          us(10),
          (await now()) + 604800,
          {
            ...TERMS,
            ...terms,
          },
        ),
    );
    return lending.offerCount();
  }
  async function lendOffer(total = 1000, collateral = 12, terms = {}) {
    await tx(usdt.connect(lender).approve(lending.target, us(total)));
    await tx(
      lending
        .connect(lender)
        .createOffer(
          1,
          us(total),
          wb(collateral),
          us(10),
          (await now()) + 604800,
          {
            ...TERMS,
            ...terms,
          },
        ),
    );
    return lending.offerCount();
  }
  async function lend(id, amount, who = lender) {
    await tx(usdt.connect(who).approve(lending.target, us(amount)));
    const collateral = await lending.quoteFill(id, us(amount));
    await tx(
      lending
        .connect(who)
        .fillOffer(id, us(amount), collateral, (await now()) + 300),
    );
    return lending.loanCount();
  }
  async function borrow(id, amount) {
    const collateral = await lending.quoteFill(id, us(amount));
    await tx(wbmb.connect(borrower).approve(lending.target, collateral));
    await tx(
      lending
        .connect(borrower)
        .fillOffer(id, us(amount), collateral, (await now()) + 300),
    );
    return lending.loanCount();
  }

  before(async () => {
    c = await network.create();
    provider = new BrowserProvider(c.provider, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 10;
    [admin, borrower, lender, lender2, feeWallet] = await Promise.all(
      [0, 1, 2, 3, 7].map((i) => provider.getSigner(i)),
    );
    addr = async (s) => s.getAddress();
    addr0 = await feeWallet.getAddress();
    usdt = await deployContract("MockToken", admin, ["Demo USDT", "dUSDT", 18]);
    wbmb = await deployContract("MockToken", admin, ["Demo WBMB", "dWBMB", 8]);
    lending = await deployContract("P2PLending", admin, [
      usdt.target,
      wbmb.target,
      ZeroAddress,
      await addr(feeWallet),
      500,
      3600,
      86400,
    ]);
    for (const s of [borrower, lender, lender2]) {
      await tx(usdt.mint(await addr(s), us(10000)));
      await tx(wbmb.mint(await addr(s), wb(100)));
    }
    snap = await provider.send("evm_snapshot", []);
  });
  beforeEach(async () => {
    await provider.send("evm_revert", [snap]);
    snap = await provider.send("evm_snapshot", []);
  });
  after(async () => {
    provider?.destroy();
    await c?.close();
  });

  it("deploys without a price policy and with a plain wallet as fee recipient", async () => {
    assert.equal(await lending.pricePolicy(), ZeroAddress);
    assert.equal(await lending.feeVault(), await addr(feeWallet));
    await assert.rejects(
      deployContract("P2PLending", admin, [
        usdt.target,
        wbmb.target,
        ZeroAddress,
        ZeroAddress,
        500,
        3600,
        86400,
      ]),
      /BAD_CONFIG/,
    );
    // a policy address without code is still rejected
    await assert.rejects(
      deployContract("P2PLending", admin, [
        usdt.target,
        wbmb.target,
        await addr(lender),
        await addr(feeWallet),
        500,
        3600,
        86400,
      ]),
      /BAD_CONFIG/,
    );
  });

  it("only accepts maturity-only terms and an explicit collateral amount on both sides", async () => {
    await tx(wbmb.connect(borrower).approve(lending.target, wb(10)));
    const expiry = (await now()) + 604800;
    const create = (signer, side, collateral, terms) =>
      lending
        .connect(signer)
        .createOffer(side, us(900), collateral, us(10), expiry, {
          ...TERMS,
          ...terms,
        });
    await assert.rejects(
      create(borrower, 0, wb(10), { mode: 0 }),
      /ORACLE_FREE_TERMS/,
    );
    await assert.rejects(
      create(borrower, 0, wb(10), { haircutBps: 1000, liquidationBps: 9500 }),
      /ORACLE_FREE_TERMS/,
    );
    await tx(usdt.connect(lender).approve(lending.target, us(900)));
    await assert.rejects(create(lender, 1, 0, {}), /BAD_COLLATERAL/);
  });

  it("borrow offer fills partially with proportional collateral and no oracle", async () => {
    const id = await borrowOffer(900, 10);
    const a = await lend(id, 90),
      b = await lend(id, 180, lender2);
    assert.equal((await lending.getLoan(a)).collateral, wb(1));
    assert.equal((await lending.getLoan(b)).collateral, wb(2));
    assert.equal((await lending.getOffer(id)).collateralRemaining, wb(7));
    assert.equal(await usdt.balanceOf(await addr(borrower)), us(10270));
    await conserved();
  });

  it("lend offer takes the maker's fixed ratio from each borrower and never escrows WBMB for the maker", async () => {
    const id = await lendOffer(1000, 12);
    assert.equal(await lending.escrowWBMB(), 0n);
    assert.equal(await lending.escrowUSDT(), us(1000));
    assert.equal(await lending.quoteFill(id, us(250)), wb(3));
    const loan = await borrow(id, 250);
    const l = await lending.getLoan(loan);
    assert.equal(l.collateral, wb(3));
    assert.equal(l.lender, await addr(lender));
    assert.equal(l.borrower, await addr(borrower));
    assert.equal(await usdt.balanceOf(await addr(borrower)), us(10250));
    // a borrower can refuse a worse ratio than quoted
    await assert.rejects(
      lending
        .connect(borrower)
        .fillOffer(id, us(250), wb(3) - 1n, (await now()) + 300),
      /COLLATERAL_SLIPPAGE/,
    );
    await tx(lending.connect(lender).closeOffer(id));
    assert.equal(await lending.claimableUSDT(await addr(lender)), us(750));
    assert.equal(await lending.claimableWBMB(await addr(lender)), 0n);
    await conserved();
  });

  it("odd partial fills of a lend offer sum to exactly the stated collateral", async () => {
    // 7 WBMB units (smallest) per 1000 USDT cannot divide evenly: rounding must never exceed the total
    await tx(usdt.connect(lender).approve(lending.target, us(1000)));
    await tx(
      lending
        .connect(lender)
        .createOffer(
          1,
          us(1000),
          100000007n,
          us(10),
          (await now()) + 604800,
          TERMS,
        ),
    );
    let sum = 0n;
    for (const amount of [333, 333, 334]) {
      const id = await borrow(1, amount);
      sum += (await lending.getLoan(id)).collateral;
    }
    assert.equal(sum, 100000007n);
    assert.equal((await lending.getOffer(1)).collateralRemaining, 0n);
    assert.equal((await lending.getOffer(1)).closed, true);
    await conserved();
  });

  it("repayment returns collateral, pays the lender and sends the fee to the fee wallet", async () => {
    const id = await borrowOffer(900, 10);
    const loan = await lend(id, 900);
    await advance(30 * 86400);
    const [interest, fee, total] = await lending.quoteRepay(loan, us(900));
    assert.ok(interest > 0n && fee > 0n);
    await tx(usdt.connect(borrower).approve(lending.target, total));
    await tx(lending.connect(borrower).repay(loan, us(900), total));
    assert.equal(await lending.claimableWBMB(await addr(borrower)), wb(10));
    assert.equal(
      await lending.claimableUSDT(await addr(lender)),
      us(900) + interest,
    );
    assert.equal(await lending.feeBalance(), fee);
    const before_ = await usdt.balanceOf(await addr(feeWallet));
    await tx(lending.connect(lender2).flushFees()); // anyone may flush; destination is fixed
    assert.equal((await usdt.balanceOf(await addr(feeWallet))) - before_, fee);
    await tx(lending.connect(lender).claimUSDT());
    await tx(lending.connect(borrower).claimWBMB());
    await conserved();
    assert.equal(await usdt.balanceOf(lending.target), 0n);
    assert.equal(await wbmb.balanceOf(lending.target), 0n);
  });

  it("settles only after maturity plus grace and hands over all collateral including top-ups", async () => {
    const id = await borrowOffer(900, 10);
    const loan = await lend(id, 90);
    await tx(wbmb.connect(borrower).approve(lending.target, wb(0.5)));
    await tx(lending.connect(borrower).addCollateral(loan, wb(0.5)));
    await assert.rejects(lending.settle(loan), /NOT_OVERDUE/);
    await advance(30 * 86400 + 86400 - 10);
    await assert.rejects(lending.settle(loan), /NOT_OVERDUE/);
    await advance(20);
    await tx(lending.connect(lender2).settle(loan)); // caller gets nothing
    assert.equal(await lending.claimableWBMB(await addr(lender)), wb(1.5));
    assert.equal(await lending.claimableWBMB(await addr(lender2)), 0n);
    assert.equal(await lending.claimableUSDT(await addr(lender)), 0n);
    await assert.rejects(lending.settle(loan), /NOT_ACTIVE/);
    await assert.rejects(
      lending.connect(borrower).repay(loan, 0, us(1000)),
      /BAD_REPAY/,
    );
    await conserved();
  });

  it("a late borrower can still repay before anyone settles", async () => {
    const id = await borrowOffer(900, 10);
    const loan = await lend(id, 90);
    await advance(40 * 86400);
    const [, , total] = await lending.quoteRepay(loan, us(90));
    await tx(usdt.connect(borrower).approve(lending.target, total));
    await tx(lending.connect(borrower).repay(loan, us(90), total));
    await assert.rejects(lending.settle(loan), /NOT_ACTIVE/);
    assert.equal(await lending.claimableWBMB(await addr(borrower)), wb(1));
    await conserved();
  });

  it("requires at least one day of grace and rejects each stray margin field on its own", async () => {
    await tx(wbmb.connect(borrower).approve(lending.target, wb(10)));
    const expiry = (await now()) + 604800;
    const create = (terms) =>
      lending
        .connect(borrower)
        .createOffer(0, us(900), wb(10), us(10), expiry, {
          ...TERMS,
          ...terms,
        });
    await assert.rejects(create({ grace: 86399 }), /ORACLE_FREE_TERMS/);
    await assert.rejects(create({ grace: 0 }), /ORACLE_FREE_TERMS/);
    await assert.rejects(create({ haircutBps: 1 }), /ORACLE_FREE_TERMS/);
    await assert.rejects(create({ liquidationBps: 1 }), /ORACLE_FREE_TERMS/);
    await tx(create({ grace: 86400 }));
  });

  it("rejects a fee above 10% at deployment", async () => {
    const args = (fee) => [
      usdt.target,
      wbmb.target,
      ZeroAddress,
      addr0,
      fee,
      3600,
      86400,
    ];
    await assert.rejects(
      deployContract("P2PLending", admin, args(1001)),
      /FEE_TOO_HIGH/,
    );
    await deployContract("P2PLending", admin, args(1000));
  });

  it("collateral rounds up per cumulative fill and a fill that would get none is refused", async () => {
    // 3 smallest WBMB units for 900 USDT: one unit per 300 USDT
    await tx(wbmb.connect(borrower).approve(lending.target, 3n));
    await tx(
      lending
        .connect(borrower)
        .createOffer(0, us(900), 3n, us(10), (await now()) + 604800, TERMS),
    );
    assert.equal(await lending.quoteFill(1, us(100)), 1n); // ceil(3*100/900)
    const first = await lend(1, 100);
    assert.equal((await lending.getLoan(first)).collateral, 1n);
    // cumulative 200 USDT still rounds to 1 unit in total, so this fill would be unsecured
    await assert.rejects(lending.quoteFill(1, us(100)), /BAD_COLLATERAL/);
    await tx(usdt.connect(lender).approve(lending.target, us(100)));
    await assert.rejects(
      lending.connect(lender).fillOffer(1, us(100), 10n, (await now()) + 300),
      /BAD_COLLATERAL/,
    );
    assert.equal(await lending.quoteFill(1, us(250)), 1n); // cumulative 350 -> 2 units
    assert.equal(await lending.quoteFill(1, us(800)), 2n); // the rest takes exactly what is left
    await conserved();
  });

  it("indexes every offer and loan by account so none can scroll out of reach", async () => {
    const offer = await borrowOffer(900, 10);
    const a = await lend(offer, 90);
    const b = await lend(offer, 180, lender2);
    const B = await addr(borrower),
      L = await addr(lender),
      L2 = await addr(lender2);
    assert.deepEqual([...(await lending.offerIdsOf(B))], [offer]);
    assert.deepEqual([...(await lending.loanIdsOf(B))], [a, b]);
    assert.deepEqual([...(await lending.loanIdsOf(L))], [a]);
    assert.deepEqual([...(await lending.loanIdsOf(L2))], [b]);
    assert.deepEqual([...(await lending.loanIdsOf(await addr(feeWallet)))], []);
    const byLender = await lending.queryFilter(
      lending.filters.LoanCreated(null, null, L2),
    );
    assert.equal(byLender.length, 1);
    assert.equal(byLender[0].args.id, b);
  });

  it("minimum duration and grace are fixed per deployment: a test market allows 30-minute loans, the standard one does not", async () => {
    const expiry = (await now()) + 604800;
    const short = { ...TERMS, duration: 1800, grace: 300 };
    await tx(wbmb.connect(borrower).approve(lending.target, wb(1)));
    await assert.rejects(
      lending
        .connect(borrower)
        .createOffer(0, us(90), wb(1), us(10), expiry, short),
      /BAD_TERM/,
    );
    assert.equal(await lending.minDuration(), 3600n);
    assert.equal(await lending.minGrace(), 86400n);

    const quick = await deployContract("P2PLending", admin, [
      usdt.target,
      wbmb.target,
      ZeroAddress,
      addr0,
      500,
      300,
      300,
    ]);
    await tx(wbmb.connect(borrower).approve(quick.target, wb(1)));
    await assert.rejects(
      quick
        .connect(borrower)
        .createOffer(0, us(90), wb(1), us(10), expiry, {
          ...short,
          duration: 299,
        }),
      /BAD_TERM/,
    );
    await assert.rejects(
      quick
        .connect(borrower)
        .createOffer(0, us(90), wb(1), us(10), expiry, {
          ...short,
          grace: 299,
        }),
      /ORACLE_FREE_TERMS/,
    );
    await tx(
      quick
        .connect(borrower)
        .createOffer(0, us(90), wb(1), us(10), expiry, short),
    );
    await tx(usdt.connect(lender).approve(quick.target, us(90)));
    await tx(
      quick.connect(lender).fillOffer(1, us(90), wb(1), (await now()) + 300),
    );
    await advance(1800 + 290);
    await assert.rejects(quick.settle(1), /NOT_OVERDUE/);
    await advance(20);
    await tx(quick.settle(1));
    assert.equal(await quick.claimableWBMB(await addr(lender)), wb(1));

    const bad = (d, g) =>
      deployContract("P2PLending", admin, [
        usdt.target,
        wbmb.target,
        ZeroAddress,
        addr0,
        500,
        d,
        g,
      ]);
    await assert.rejects(bad(59, 300), /BAD_LIMITS/);
    await assert.rejects(bad(300, 59), /BAD_LIMITS/);
    await assert.rejects(bad(300, 7 * 86400 + 1), /BAD_LIMITS/);
  });
});
