import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { BrowserProvider } from "ethers";
import {
  deployFixture,
  deployContract,
  publishPricesWith,
  us,
  wb,
} from "../scripts/deploy.mjs";
import { hashSyntheticData } from "../src/report-signing.mjs";

describe("P2P lending on a real local EVM", () => {
  let c, f, snap;
  before(async () => {
    c = await network.create();
    const provider = new BrowserProvider(c.provider, undefined, {
      cacheTimeout: -1,
    });
    provider.pollingInterval = 10;
    f = await deployFixture(provider);
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
  const tx = async (promise) => (await promise).wait();
  const now = async () =>
    Number((await f.provider.getBlock("latest")).timestamp);
  const refresh = async (low = 100, current = 100) =>
    f.publishPrices(us(low), us(current));
  async function advance(seconds) {
    await f.provider.send("evm_increaseTime", [seconds]);
    await f.provider.send("evm_mine", []);
  }
  async function borrowOffer({
    total = 900,
    collateral = 10,
    min = 10,
    terms = {},
  } = {}) {
    await tx(
      f.wbmb.connect(f.borrower).approve(f.lending.target, wb(collateral)),
    );
    await tx(
      f.lending
        .connect(f.borrower)
        .createOffer(
          0,
          us(total),
          wb(collateral),
          us(min),
          (await now()) + 604800,
          { ...f.terms, ...terms },
        ),
    );
    return await f.lending.offerCount();
  }
  async function fill(id, amount = 90, who = f.lender) {
    await tx(f.movn.connect(who).approve(f.lending.target, us(amount)));
    const collateral = await f.lending.quoteFill(id, us(amount));
    await tx(
      f.lending
        .connect(who)
        .fillOffer(id, us(amount), collateral, (await now()) + 300),
    );
    return await f.lending.loanCount();
  }
  async function repay(id, principal) {
    await tx(f.movn.connect(f.borrower).approve(f.lending.target, us(10000)));
    await tx(f.lending.connect(f.borrower).repay(id, principal, us(10000)));
  }
  async function conserved() {
    const [u, w] = await f.lending.liabilities();
    assert.equal(await f.movn.balanceOf(f.lending.target), u);
    assert.equal(await f.wbmb.balanceOf(f.lending.target), w);
  }

  it("escrows a borrower offer, isolates two partial loans, returns only unfilled collateral", async () => {
    const id = await borrowOffer();
    const a = await fill(id, 90),
      b = await fill(id, 180, f.lender2);
    assert.equal((await f.lending.getLoan(a)).collateral, wb(1));
    assert.equal((await f.lending.getLoan(b)).collateral, wb(2));
    assert.equal((await f.lending.getOffer(id)).remaining, us(630));
    await tx(f.lending.connect(f.borrower).closeOffer(id));
    assert.equal(await f.lending.claimableWBMB(f.addresses[1]), wb(7));
    await tx(f.lending.connect(f.borrower).claimWBMB());
    assert.equal(await f.lending.activeCollateral(), wb(3));
    await conserved();
  });
  it("escrows a lender offer and transfers only a chosen partial principal", async () => {
    await tx(f.movn.connect(f.lender).approve(f.lending.target, us(1000)));
    await tx(
      f.lending
        .connect(f.lender)
        .createOffer(1, us(1000), 0, us(10), (await now()) + 604800, f.terms),
    );
    const collateral = await f.lending.quoteFill(1, us(90));
    assert.equal(collateral, wb(1));
    await tx(f.wbmb.connect(f.borrower).approve(f.lending.target, collateral));
    await tx(
      f.lending
        .connect(f.borrower)
        .fillOffer(1, us(90), collateral, (await now()) + 300),
    );
    assert.equal(await f.movn.balanceOf(f.addresses[1]), us(10090));
    assert.equal(await f.lending.escrowMOVN(), us(910));
    await conserved();
  });
  it("rejects unauthorized cancellation, self-fill, below minimum, overfill and expired fills", async () => {
    const id = await borrowOffer();
    await assert.rejects(
      f.lending.connect(f.lender).closeOffer(id),
      /NOT_MAKER/,
    );
    await assert.rejects(
      f.lending
        .connect(f.borrower)
        .fillOffer(id, us(90), wb(1), (await now()) + 300),
      /SELF_FILL/,
    );
    await assert.rejects(f.lending.quoteFill(id, us(1)), /BAD_FILL/);
    await assert.rejects(f.lending.quoteFill(id, us(901)), /BAD_FILL/);
    await advance(604801);
    await assert.rejects(f.lending.quoteFill(id, us(90)), /OFFER_CLOSED/);
    await tx(f.lending.connect(f.lender).closeOffer(id));
    assert.equal(await f.lending.claimableWBMB(f.addresses[1]), wb(10));
  });
  it("supports last-fill minimum exception and exact cumulative collateral conservation", async () => {
    const id = await borrowOffer({ total: 91, collateral: 2, min: 10 });
    await fill(id, 90);
    await fill(id, 1, f.lender2);
    const a = await f.lending.getLoan(1),
      b = await f.lending.getLoan(2);
    assert.equal(a.collateral + b.collateral, wb(2));
    assert.equal((await f.lending.getOffer(id)).collateralRemaining, 0n);
    await assert.rejects(f.lending.quoteFill(id, us(1)), /OFFER_CLOSED/);
    await conserved();
  });
  it("rolls back fills when token approval is missing and enforces max collateral/deadline", async () => {
    const id = await borrowOffer();
    await assert.rejects(
      f.lending
        .connect(f.lender)
        .fillOffer(id, us(90), wb(1), (await now()) + 300),
    );
    assert.equal(await f.lending.loanCount(), 0n);
    assert.equal((await f.lending.getOffer(id)).remaining, us(900));
    await assert.rejects(
      f.lending
        .connect(f.lender)
        .fillOffer(id, us(90), wb(".9"), (await now()) + 300),
      /COLLATERAL_SLIPPAGE/,
    );
    await assert.rejects(
      f.lending
        .connect(f.lender)
        .fillOffer(id, us(90), wb(1), (await now()) - 1),
      /DEADLINE/,
    );
    await conserved();
  });
  it("accrues exact 30-day simple interest, caps at maturity and returns all collateral after repayment", async () => {
    const id = await fill(await borrowOffer());
    await advance(31 * 86400);
    const [interest, fee, total] = await f.lending.quoteRepay(id, us(90));
    const expected =
      (us(90) * 1200n * 30n * 86400n + 10000n * 31536000n - 1n) /
      (10000n * 31536000n);
    assert.equal(interest, expected);
    assert.equal(fee, (interest * 500n + 9999n) / 10000n);
    await advance(86400);
    assert.equal((await f.lending.quoteRepay(id, us(90))).total, total);
    await repay(id, us(90)); // must work with stale oracle
    assert.equal((await f.lending.getLoan(id)).status, 2n);
    assert.equal(await f.lending.claimableWBMB(f.addresses[1]), wb(1));
    assert.equal(
      await f.lending.claimableMOVN(f.addresses[2]),
      us(90) + interest,
    );
    await tx(f.lending.connect(f.lender).claimMOVN());
    await tx(f.lending.connect(f.borrower).claimWBMB());
    assert.equal(await f.lending.debtOf(id), 0n);
    await assert.rejects(f.lending.settle(id), /NOT_ACTIVE/);
    await conserved();
  });
  it("partial repayment reduces future principal, keeps collateral and tracks fee/interest remainders", async () => {
    const id = await fill(await borrowOffer());
    await advance(15 * 86400);
    await repay(id, us(45));
    const l = await f.lending.getLoan(id);
    assert.equal(l.principal, us(45));
    assert.equal(l.collateral, wb(1));
    assert(l.interestRemainder < 10000n * 31536000n);
    await advance(15 * 86400);
    const [i] = await f.lending.quoteRepay(id, us(45));
    assert(i > us(".221") && i < us(".223"));
    await repay(id, us(45));
    await conserved();
  });
  it("interest-only payments neither compound interest nor unlock collateral", async () => {
    const id = await fill(await borrowOffer());
    await advance(86400);
    await repay(id, 0);
    const l = await f.lending.getLoan(id);
    assert.equal(l.principal, us(90));
    assert.equal(l.status, 1n);
    assert.equal(await f.lending.claimableWBMB(f.addresses[1]), 0n);
    await assert.rejects(
      f.lending.connect(f.lender).repay(id, 0, us(10)),
      /NOT_BORROWER/,
    );
    await conserved();
  });
  it("zero APR loans repay without charging fees", async () => {
    const id = await fill(await borrowOffer({ terms: { aprBps: 0 } }));
    await advance(86400);
    assert.equal(await f.lending.debtOf(id), us(90));
    await repay(id, us(90));
    assert.equal(await f.lending.feeBalance(), 0n);
    await conserved();
  });
  it("adds collateral only to the selected loan and prevents price settlement after top-up", async () => {
    const offer = await borrowOffer();
    const a = await fill(offer),
      b = await fill(offer, 90, f.lender2);
    await refresh(90, 90);
    await f.lending.quoteSettlement(a);
    await tx(f.wbmb.connect(f.borrower).approve(f.lending.target, wb(1)));
    await tx(f.lending.connect(f.borrower).addCollateral(a, wb(1)));
    await assert.rejects(f.lending.quoteSettlement(a), /HEALTHY/);
    assert.equal((await f.lending.getLoan(b)).collateral, wb(1));
    await assert.rejects(
      f.lending.connect(f.lender).addCollateral(a, wb(1)),
      /NOT_ACTIVE_BORROWER/,
    );
    await conserved();
  });
  it("settles in WBMB to the lender, returns surplus, credits no keeper and cannot repeat", async () => {
    const id = await fill(await borrowOffer({ terms: { aprBps: 0 } }));
    await refresh(94, 94);
    const before = await f.lending.quoteSettlement(id);
    await tx(f.lending.connect(f.lender2).settle(id));
    assert.equal(
      await f.lending.claimableWBMB(f.addresses[2]),
      before.toLender,
    );
    assert.equal(
      await f.lending.claimableWBMB(f.addresses[1]),
      before.toBorrower,
    );
    assert.equal(before.toLender + before.toBorrower, wb(1));
    assert.equal(await f.lending.claimableWBMB(f.addresses[3]), 0n);
    assert.equal(await f.lending.claimableMOVN(f.addresses[2]), 0n);
    await assert.rejects(f.lending.settle(id), /NOT_ACTIVE/);
    await assert.rejects(
      f.lending.connect(f.borrower).addCollateral(id, wb(1)),
      /NOT_ACTIVE_BORROWER/,
    );
    await conserved();
  });
  it("caps bad-debt settlement at collateral without touching other loans", async () => {
    const offer = await borrowOffer();
    const a = await fill(offer),
      b = await fill(offer, 90, f.lender2);
    await refresh(70, 70);
    await tx(f.lending.settle(a));
    assert.equal(await f.lending.claimableWBMB(f.addresses[2]), wb(1));
    assert.equal((await f.lending.getLoan(b)).status, 1n);
    assert.equal(await f.lending.activeCollateral(), wb(1));
    await conserved();
  });
  it("stale oracle blocks fills/price settlements but not repay, top-up, cancellation or claims", async () => {
    const offer = await borrowOffer(),
      id = await fill(offer);
    await advance(7201);
    await assert.rejects(f.lending.quoteFill(offer, us(90)), /STALE_PRICE/);
    await assert.rejects(f.lending.settle(id), /STALE_PRICE/);
    await tx(f.wbmb.connect(f.borrower).approve(f.lending.target, wb(1)));
    await tx(f.lending.connect(f.borrower).addCollateral(id, wb(1)));
    await tx(f.lending.connect(f.borrower).closeOffer(offer));
    await repay(id, us(90));
    await tx(f.lending.connect(f.borrower).claimWBMB());
    await conserved();
  });
  it("maturity-only mode ignores price drops and transfers ALL collateral only after grace", async () => {
    const id = await fill(
      await borrowOffer({ terms: { mode: 1, duration: 3600, grace: 86400 } }),
    );
    await refresh(1, 1);
    await assert.rejects(f.lending.settle(id), /NOT_OVERDUE/);
    await advance(7201 + 86400);
    await tx(f.lending.settle(id)); // no oracle needed even though stale
    assert.equal(await f.lending.claimableWBMB(f.addresses[2]), wb(1));
    assert.equal(await f.lending.claimableWBMB(f.addresses[1]), 0n);
    await conserved();
  });
  it("price mode can settle a healthy overdue loan with surplus returned", async () => {
    const id = await fill(
      await borrowOffer({ terms: { duration: 3600, grace: 86400 } }),
    );
    await advance(4300 + 86400);
    await refresh(100, 100);
    await tx(f.lending.settle(id));
    assert((await f.lending.claimableWBMB(f.addresses[1])) > 0n);
    await conserved();
  });
  it("rejects prices manipulated downward for new borrowing and terms without maturity interest buffer", async () => {
    const id = await borrowOffer();
    await refresh(80, 80);
    await assert.rejects(
      f.lending.quoteFill(id, us(90)),
      /INSUFFICIENT_COLLATERAL/,
    );
    await refresh(100, 100);
    const risky = await borrowOffer({
      terms: { aprBps: 10000, duration: 31536000 },
    });
    await assert.rejects(
      f.lending.quoteFill(risky, us(90)),
      /NO_INTEREST_BUFFER/,
    );
    await assert.rejects(
      borrowOffer({ terms: { haircutBps: 500, liquidationBps: 9500 } }),
      /BAD_MARGIN/,
    );
  });
  it("fee transfers and synthetic buyback burn cannot consume lender claims or collateral", async () => {
    const id = await fill(await borrowOffer());
    await advance(30 * 86400);
    await repay(id, us(90));
    const lenderClaim = await f.lending.claimableMOVN(f.addresses[2]);
    const fee = await f.lending.feeBalance();
    await tx(f.lending.connect(f.lender2).flushFees());
    assert.equal(await f.movn.balanceOf(f.burner.target), fee);
    await assert.rejects(
      f.burner.burnFees(fee, 0, (await now()) + 300),
      /STALE_PRICE/,
    );
    await refresh();
    const out = (fee * 100000000n) / us(100),
      supply = await f.wbmb.totalSupply();
    await assert.rejects(
      f.burner.burnFees(fee, out + 1n, (await now()) + 300),
      /BAD_OUTPUT/,
    );
    await tx(f.burner.burnFees(fee, out, (await now()) + 300));
    assert.equal(supply - (await f.wbmb.totalSupply()), out);
    assert.equal(await f.lending.claimableMOVN(f.addresses[2]), lenderClaim);
    await assert.rejects(f.burner.burnFees(fee, out, (await now()) + 300));
    await conserved();
  });
  it("oracle reporter access and token precision are enforced", async () => {
    await assert.rejects(
      publishPricesWith(
        f.provider,
        f.oracle,
        [f.borrower, f.lender],
        us(100),
        us(100),
      ),
      /BAD_SIGNER/,
    );
    await assert.rejects(f.publishPrices(0n, us(100)), /BAD_PRICE/);
    await f.publishPrices(us(98), us(99));
    assert.equal(
      await f.oracle.rawDataHash(),
      hashSyntheticData({
        windowEnd: Number(await f.oracle.windowEnd()),
        dexLow: us(98),
        cexLow: us(98),
        dexCurrent: us(99),
        cexCurrent: us(99),
      }),
    );
    const wrong = await deployContract("MockToken", f.admin, [
      "Wrong MOVN",
      "X",
      6,
    ]);
    await assert.rejects(
      deployContract("P2PLending", f.admin, [
        wrong.target,
        f.wbmb.target,
        f.oracle.target,
        f.burner.target,
        500,
        3600,
        86400,
        0,
        7 * 86400,
      ]),
      /DECIMALS/,
    );
  });
  it("bounded randomized operations preserve both token ledgers", async () => {
    const offer = await borrowOffer({ total: 900, collateral: 12 });
    let seed = 12345;
    for (let i = 0; i < 12; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const amount = 10 + (seed % 30);
      const id = await fill(offer, amount, i % 2 ? f.lender : f.lender2);
      await advance(seed % 100);
      if (i % 3 === 0) await repay(id, us(amount));
      else if (i % 3 === 1) await repay(id, us(1));
      await conserved();
    }
    await tx(f.lending.connect(f.borrower).closeOffer(offer));
    await conserved();
  });
  async function faultyMarket() {
    const token = await deployContract("FaultyToken", f.admin, [18]);
    const burner = await deployContract("MockFeeBurner", f.admin, [
      token.target,
      f.wbmb.target,
      f.oracle.target,
    ]);
    const lending = await deployContract("P2PLending", f.admin, [
      token.target,
      f.wbmb.target,
      f.oracle.target,
      burner.target,
      500,
      3600,
      86400,
      0,
      7 * 86400,
    ]);
    await tx(token.mint(f.addresses[2], us(1000)));
    await tx(token.connect(f.lender).approve(lending.target, us(1000)));
    return { token, lending };
  }
  it("false-returning and taxed tokens cannot create unbacked escrow", async () => {
    const { token, lending } = await faultyMarket();
    const zero = "0x0000000000000000000000000000000000000000";
    await tx(token.setFaults(true, false, zero, "0x"));
    await assert.rejects(
      lending
        .connect(f.lender)
        .createOffer(1, us(100), 0, us(10), (await now()) + 3600, f.terms),
    );
    assert.equal(await lending.offerCount(), 0n);
    await tx(token.setFaults(false, true, zero, "0x"));
    await assert.rejects(
      lending
        .connect(f.lender)
        .createOffer(1, us(100), 0, us(10), (await now()) + 3600, f.terms),
      /NON_EXACT_TOKEN/,
    );
    assert.equal(await lending.escrowMOVN(), 0n);
    assert.equal(await token.balanceOf(f.addresses[2]), us(1000));
  });
  it("failed outgoing transfers preserve claims and reentrant calls cannot enter lending", async () => {
    const { token, lending } = await faultyMarket();
    const zero = "0x0000000000000000000000000000000000000000";
    await tx(
      token.setFaults(
        false,
        false,
        lending.target,
        lending.interface.encodeFunctionData("createOffer", [
          1,
          us(10),
          0,
          us(10),
          (await now()) + 3600,
          f.terms,
        ]),
      ),
    );
    await tx(
      lending
        .connect(f.lender)
        .createOffer(1, us(100), 0, us(10), (await now()) + 3600, f.terms),
    );
    assert.equal(await token.reentryBlocked(), true);
    assert.equal(
      await token.reentryError(),
      lending.interface.getError("ReentrancyGuardReentrantCall").selector,
    );
    await tx(lending.connect(f.lender).closeOffer(1));
    await tx(token.setFaults(true, false, zero, "0x"));
    await assert.rejects(lending.connect(f.lender).claimMOVN());
    assert.equal(await lending.claimableMOVN(f.addresses[2]), us(100));
    assert.equal(await lending.totalClaimMOVN(), us(100));
    await tx(token.setFaults(false, false, zero, "0x"));
    await tx(lending.connect(f.lender).claimMOVN());
    assert.equal(await lending.claimableMOVN(f.addresses[2]), 0n);
    assert.equal(await token.balanceOf(f.addresses[2]), us(1000));
  });
  it("settlement boundary is inclusive and recovery invalidates previously eligible settlement", async () => {
    await refresh(110, 110);
    const id = await fill(
      await borrowOffer({ total: 95, collateral: 1, terms: { aprBps: 0 } }),
      95,
    );
    await refresh(90, 90);
    await f.lending.quoteSettlement(id);
    await refresh(110, 110);
    await assert.rejects(f.lending.settle(id), /HEALTHY/);
    // 95 MOVN against 1 WBMB at 100 MOVN is the exact 95% boundary.
    await refresh(100, 100);
    const q = await f.lending.quoteSettlement(id);
    assert.equal(q.debt, us(95));
    assert.equal(q.toLender, wb(".95"));
    await tx(f.lending.settle(id));
    await conserved();
  });

  // MOVN's issuer can pause the token or block an address. The market must neither lose
  // nor mint claims while that happens, and must end a loan in WBMB once grace is over.
  async function pausableMarket() {
    const token = await deployContract("PausableToken", f.admin, [18]);
    const lending = await deployContract("P2PLending", f.admin, [
      token.target,
      f.wbmb.target,
      f.oracle.target,
      f.addresses[3],
      500,
      3600,
      86400,
      0,
      7 * 86400,
    ]);
    for (const who of [f.addresses[1], f.addresses[2]])
      await tx(token.mint(who, us(1000)));
    await tx(token.connect(f.lender).approve(lending.target, us(1000)));
    await tx(token.connect(f.borrower).approve(lending.target, us(1000)));
    await tx(f.wbmb.connect(f.borrower).approve(lending.target, wb(10)));
    await tx(
      lending
        .connect(f.borrower)
        .createOffer(
          0,
          us(900),
          wb(10),
          us(10),
          (await now()) + 604800,
          f.terms,
        ),
    );
    const collateral = await lending.quoteFill(1, us(90));
    await tx(
      lending
        .connect(f.lender)
        .fillOffer(1, us(90), collateral, (await now()) + 300),
    );
    const held = async () => {
      const [u, w] = await lending.liabilities();
      assert.equal(await token.balanceOf(lending.target), u);
      assert.equal(await f.wbmb.balanceOf(lending.target), w);
    };
    return { token, lending, held };
  }
  it("a paused quote token blocks repay and new fills but changes nothing; repay works after unpause", async () => {
    const { token, lending, held } = await pausableMarket();
    await tx(token.setPaused(true));
    await assert.rejects(
      lending.connect(f.borrower).repay(1, us(90), us(1000)),
      /PAUSED/,
    );
    await assert.rejects(
      lending
        .connect(f.lender)
        .fillOffer(1, us(10), wb(1), (await now()) + 300),
      /PAUSED/,
    );
    assert.equal((await lending.getLoan(1)).status, 1n);
    assert.equal((await lending.getLoan(1)).principal, us(90));
    await held();
    await tx(token.setPaused(false));
    await tx(lending.connect(f.borrower).repay(1, us(90), us(1000)));
    assert.equal((await lending.getLoan(1)).status, 2n);
    await held();
  });
  it("a blocked lender cannot claim MOVN but keeps the claim; others claim; WBMB claims are unaffected", async () => {
    const { token, lending, held } = await pausableMarket();
    await tx(lending.connect(f.borrower).repay(1, us(90), us(1000)));
    const owed = await lending.claimableMOVN(f.addresses[2]);
    assert.ok(owed > us(90));
    await tx(token.setBlocked(f.addresses[2], true));
    await assert.rejects(lending.connect(f.lender).claimMOVN(), /BLOCKED/);
    assert.equal(await lending.claimableMOVN(f.addresses[2]), owed);
    // The borrower's collateral claim is WBMB and does not touch the blocked token.
    await tx(lending.connect(f.borrower).claimWBMB());
    await tx(lending.connect(f.borrower).closeOffer(1));
    await tx(lending.connect(f.borrower).claimWBMB());
    // Fees still move: the fee wallet is not blocked.
    await tx(lending.flushFees());
    await held();
    await tx(token.setBlocked(f.addresses[2], false));
    await tx(lending.connect(f.lender).claimMOVN());
    assert.equal(await lending.claimableMOVN(f.addresses[2]), 0n);
    await held();
  });
  it("while the quote token stays paused past grace, the loan ends in WBMB and both sides can take their WBMB", async () => {
    const { token, lending, held } = await pausableMarket();
    await tx(token.setPaused(true));
    await advance(31 * 86400 + 60);
    await refresh(100, 100);
    await assert.rejects(
      lending.connect(f.borrower).repay(1, us(90), us(1000)),
      /PAUSED/,
    );
    await tx(lending.settle(1));
    assert.equal((await lending.getLoan(1)).status, 3n);
    await tx(lending.connect(f.lender).claimWBMB());
    await tx(lending.connect(f.borrower).claimWBMB());
    await held();
  });
});
