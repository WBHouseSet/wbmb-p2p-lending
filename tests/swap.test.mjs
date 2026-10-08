import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { BrowserProvider, ZeroAddress } from "ethers";
import { deployContract, us, wb } from "../scripts/deploy.mjs";

// WBMB <-> MOVN direct trade board. Price is MOVN base units per 1 WBMB (1e8 units).
describe("P2P swap board", () => {
  let c, provider, admin, seller, buyer, other, feeWallet, addr;
  let movn, wbmb, swap, snap;
  const SELL = 0;
  const BUY = 1;
  const DAY = 86400;
  const tx = async (p) => (await p).wait();
  const now = async () => Number((await provider.getBlock("latest")).timestamp);
  async function advance(s) {
    await provider.send("evm_increaseTime", [s]);
    await provider.send("evm_mine", []);
  }
  async function conserved(market = swap, quote = movn, base = wbmb) {
    const [m, w] = await market.liabilities();
    assert.equal(await quote.balanceOf(market.target), m);
    assert.equal(await base.balanceOf(market.target), w);
  }
  // total/minFill in WBMB units, price in MOVN units; pass bigints to bypass the unit helpers
  const W = (x) => (typeof x === "bigint" ? x : wb(x));
  const M = (x) => (typeof x === "bigint" ? x : us(x));
  async function sellOffer(total = 10, price = 112, minFill = 1, days = 30) {
    await tx(wbmb.connect(seller).approve(swap.target, W(total)));
    await tx(
      swap
        .connect(seller)
        .createOffer(
          SELL,
          W(total),
          M(price),
          W(minFill),
          (await now()) + days * DAY,
        ),
    );
    return swap.offerCount();
  }
  async function buyOffer(total = 10, price = 112, minFill = 1, days = 30) {
    await tx(movn.connect(buyer).approve(swap.target, us(1_000_000)));
    await tx(
      swap
        .connect(buyer)
        .createOffer(
          BUY,
          W(total),
          M(price),
          W(minFill),
          (await now()) + days * DAY,
        ),
    );
    return swap.offerCount();
  }
  // taker buys WBMB from a sell offer
  async function buy(id, amount, who = buyer) {
    const o = await swap.getOffer(id);
    await tx(movn.connect(who).approve(swap.target, us(1_000_000)));
    return tx(
      swap.connect(who).fillOffer(id, W(amount), o.price, (await now()) + 300),
    );
  }
  // taker sells WBMB into a buy offer
  async function sell(id, amount, who = seller) {
    const o = await swap.getOffer(id);
    await tx(wbmb.connect(who).approve(swap.target, W(amount)));
    return tx(
      swap.connect(who).fillOffer(id, W(amount), o.price, (await now()) + 300),
    );
  }

  before(async () => {
    c = await network.create();
    provider = new BrowserProvider(c.provider, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 10;
    [admin, seller, buyer, other, feeWallet] = await Promise.all(
      [0, 1, 2, 3, 7].map((i) => provider.getSigner(i)),
    );
    addr = async (s) => s.getAddress();
    movn = await deployContract("PausableToken", admin, [18]);
    wbmb = await deployContract("MockToken", admin, ["Demo WBMB", "dWBMB", 8]);
    swap = await deployContract("P2PSwap", admin, [
      movn.target,
      wbmb.target,
      await addr(feeWallet),
      50,
    ]);
    for (const s of [seller, buyer, other]) {
      await tx(movn.mint(await addr(s), us(100000)));
      await tx(wbmb.mint(await addr(s), wb(1000)));
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

  it("fixes tokens, fee wallet and fee rate at deployment and rejects bad settings", async () => {
    assert.equal(await swap.movn(), movn.target);
    assert.equal(await swap.wbmb(), wbmb.target);
    assert.equal(await swap.feeVault(), await addr(feeWallet));
    assert.equal(await swap.feeBps(), 50n);
    const deploy = (...a) => deployContract("P2PSwap", admin, a);
    const vault = await addr(feeWallet);
    await assert.rejects(
      deploy(movn.target, wbmb.target, ZeroAddress, 50),
      /BAD_CONFIG/,
    );
    await assert.rejects(
      deploy(movn.target, wbmb.target, movn.target, 50),
      /BAD_CONFIG/,
    );
    await assert.rejects(
      deploy(movn.target, wbmb.target, wbmb.target, 50),
      /BAD_CONFIG/,
    );
    await assert.rejects(
      deploy(movn.target, movn.target, vault, 50),
      /BAD_CONFIG/,
    );
    // swapped tokens: decimals are checked
    await assert.rejects(
      deploy(wbmb.target, movn.target, vault, 50),
      /DECIMALS/,
    );
    await assert.rejects(
      deploy(movn.target, wbmb.target, vault, 101),
      /FEE_TOO_HIGH/,
    );
    await deploy(movn.target, wbmb.target, vault, 100);
  });

  it("a sell offer escrows the WBMB and is listed for its maker", async () => {
    const id = await sellOffer(10, 112, 1);
    assert.equal(await wbmb.balanceOf(swap.target), wb(10));
    assert.equal(await wbmb.balanceOf(await addr(seller)), wb(990));
    const o = await swap.getOffer(id);
    assert.equal(o.maker, await addr(seller));
    assert.equal(o.side, 0n);
    assert.equal(o.closed, false);
    assert.equal(o.price, us(112));
    assert.equal(o.total, wb(10));
    assert.equal(o.remaining, wb(10));
    assert.equal(o.minFill, wb(1));
    assert.equal(o.movnRemaining, 0n);
    assert.deepEqual([...(await swap.offerIdsOf(await addr(seller)))], [1n]);
    await conserved();
  });

  it("buying from a sell offer swaps at once and takes 0.5% from the seller", async () => {
    const id = await sellOffer(10, 112, 1);
    const receipt = await buy(id, 10);
    // 10 WBMB x 112 = 1,120 MOVN -> seller 1,114.4, fee 5.6
    assert.equal(await movn.balanceOf(await addr(buyer)), us(100000 - 1120));
    assert.equal(await wbmb.balanceOf(await addr(buyer)), wb(1010));
    assert.equal(
      await movn.balanceOf(await addr(seller)),
      us(100000) + us("1114.4"),
    );
    assert.equal(await swap.feeBalance(), us("5.6"));
    assert.equal(await movn.balanceOf(swap.target), us("5.6"));
    assert.equal(await wbmb.balanceOf(swap.target), 0n);
    const o = await swap.getOffer(id);
    assert.equal(o.remaining, 0n);
    assert.equal(o.closed, true);
    const filled = receipt.logs
      .map((l) => {
        try {
          return swap.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l) => l?.name === "Filled");
    assert.deepEqual(
      [...filled.args],
      [id, await addr(buyer), wb(10), us(1120), us("5.6")],
    );
    await conserved();
  });

  it("a sell offer fills in parts and keeps the rest on the board", async () => {
    const id = await sellOffer(10, 100, 1);
    await buy(id, 3);
    await buy(id, 2, other);
    const o = await swap.getOffer(id);
    assert.equal(o.remaining, wb(5));
    assert.equal(o.closed, false);
    assert.equal(await wbmb.balanceOf(swap.target), wb(5));
    assert.equal(await swap.feeBalance(), us("2.5"));
    assert.equal(
      await movn.balanceOf(await addr(seller)),
      us(100000) + us("497.5"),
    );
    await conserved();
  });

  it("a buy offer escrows the MOVN, and a seller filling it is paid less the fee", async () => {
    const id = await buyOffer(10, 112, 1);
    assert.equal(await movn.balanceOf(swap.target), us(1120));
    assert.equal((await swap.getOffer(id)).movnRemaining, us(1120));
    await conserved();
    await sell(id, 4);
    // 4 x 112 = 448 MOVN -> seller 445.76, fee 2.24
    assert.equal(
      await movn.balanceOf(await addr(seller)),
      us(100000) + us("445.76"),
    );
    assert.equal(await wbmb.balanceOf(await addr(seller)), wb(996));
    assert.equal(await wbmb.balanceOf(await addr(buyer)), wb(1004));
    assert.equal(await swap.feeBalance(), us("2.24"));
    const o = await swap.getOffer(id);
    assert.equal(o.remaining, wb(6));
    assert.equal(o.movnRemaining, us(672));
    assert.equal(await wbmb.balanceOf(swap.target), 0n);
    await conserved();
  });

  it("rounds the payment up for a buyer who takes a sell offer and the fee up for the seller", async () => {
    // price 1.000000000000000001 MOVN, 0.00000001 WBMB -> gross ceil(1e18+1 / 1e8) = 1e10 + 1
    const price = us(1) + 1n;
    const id = await sellOffer(1n, price, 1n);
    const before_ = await movn.balanceOf(await addr(buyer));
    await buy(id, 1n);
    const gross = 10n ** 10n + 1n;
    const fee = (gross * 50n + 9999n) / 10000n;
    assert.equal(before_ - (await movn.balanceOf(await addr(buyer))), gross);
    assert.equal(await swap.feeBalance(), fee);
    assert.equal(
      await movn.balanceOf(await addr(seller)),
      us(100000) + gross - fee,
    );
    await conserved();
  });

  it("rounds a buy offer's payments down and returns the leftover to the maker with the last fill", async () => {
    // 3 units at a price that does not divide: deposit ceil(3p/1e8), each fill floor(p/1e8)
    const price = us(1) + 99_999_999n;
    const deposit = (3n * price + 10n ** 8n - 1n) / 10n ** 8n;
    const each = price / 10n ** 8n;
    const start = await movn.balanceOf(await addr(buyer));
    const id = await buyOffer(3n, price, 1n);
    assert.equal(start - (await movn.balanceOf(await addr(buyer))), deposit);
    await sell(id, 1n);
    await sell(id, 1n);
    await conserved();
    await sell(id, 1n);
    const o = await swap.getOffer(id);
    assert.equal(o.closed, true);
    assert.equal(o.movnRemaining, 0n);
    // the maker paid exactly the three floored payments
    assert.equal(start - (await movn.balanceOf(await addr(buyer))), 3n * each);
    assert.ok(deposit > 3n * each);
    assert.equal(await movn.balanceOf(swap.target), await swap.feeBalance());
    await conserved();
  });

  it("refuses a fill whose payment rounds to nothing", async () => {
    // 1 MOVN base unit per WBMB: 0.00000001 WBMB is worth less than one base unit
    const id = await buyOffer(1, 1n, 1n);
    await assert.rejects(sell(id, 1n), /ZERO_PAYMENT/);
    await sell(id, 1);
    await conserved();
  });

  it("enforces the minimum fill except for a smaller last remainder", async () => {
    const id = await sellOffer(10, 100, 4);
    await assert.rejects(buy(id, 3), /BAD_FILL/);
    await assert.rejects(buy(id, 0n), /BAD_FILL/);
    await assert.rejects(buy(id, 11), /BAD_FILL/);
    await buy(id, 7);
    // 3 left, below the minimum: only the whole remainder can be taken
    await assert.rejects(buy(id, 2), /BAD_FILL/);
    await buy(id, 3);
    assert.equal((await swap.getOffer(id)).closed, true);
    await conserved();
  });

  it("rejects a fill at another price, after the taker's deadline, or by the maker", async () => {
    const id = await sellOffer(10, 100, 1);
    await tx(movn.connect(buyer).approve(swap.target, us(100000)));
    const later = (await now()) + 300;
    await assert.rejects(
      swap.connect(buyer).fillOffer(id, wb(1), us(101), later),
      /PRICE_MISMATCH/,
    );
    await assert.rejects(
      swap.connect(buyer).fillOffer(id, wb(1), us(100), (await now()) - 1),
      /DEADLINE/,
    );
    await tx(movn.connect(seller).approve(swap.target, us(100000)));
    await assert.rejects(
      swap.connect(seller).fillOffer(id, wb(1), us(100), later),
      /SELF_FILL/,
    );
    await assert.rejects(
      swap.connect(buyer).fillOffer(99, wb(1), us(100), later),
      /OFFER_CLOSED/,
    );
  });

  it("rejects offers with bad amounts, prices or expiry", async () => {
    await tx(wbmb.connect(seller).approve(swap.target, wb(1000)));
    const t = await now();
    const make = (total, price, minFill, expiresAt) =>
      swap.connect(seller).createOffer(SELL, total, price, minFill, expiresAt);
    await assert.rejects(make(0n, us(1), 0n, t + DAY), /BAD_AMOUNT/);
    await assert.rejects(make(wb(1), us(1), 0n, t + DAY), /BAD_AMOUNT/);
    await assert.rejects(make(wb(1), us(1), wb(2), t + DAY), /BAD_AMOUNT/);
    await assert.rejects(
      make(10n ** 30n + 1n, us(1), 1n, t + DAY),
      /BAD_AMOUNT/,
    );
    await assert.rejects(make(wb(1), 0n, wb(1), t + DAY), /BAD_PRICE/);
    await assert.rejects(
      make(wb(1), 10n ** 30n + 1n, wb(1), t + DAY),
      /BAD_PRICE/,
    );
    await assert.rejects(make(wb(1), us(1), wb(1), t), /BAD_EXPIRY/);
    await assert.rejects(make(wb(1), us(1), wb(1), t + 91 * DAY), /BAD_EXPIRY/);
    await tx(make(wb(1), us(1), wb(1), t + 89 * DAY));
  });

  it("lets the maker cancel at any time and sends back what is left", async () => {
    const s = await sellOffer(10, 100, 1);
    await buy(s, 4);
    await assert.rejects(swap.connect(other).closeOffer(s), /NOT_MAKER/);
    await tx(swap.connect(seller).closeOffer(s));
    assert.equal(await wbmb.balanceOf(await addr(seller)), wb(996));
    assert.equal((await swap.getOffer(s)).closed, true);
    assert.equal((await swap.getOffer(s)).remaining, 0n);
    await assert.rejects(swap.connect(seller).closeOffer(s), /OFFER_CLOSED/);
    await assert.rejects(buy(s, 1), /OFFER_CLOSED/);

    const start = await movn.balanceOf(await addr(buyer));
    const b = await buyOffer(10, 100, 1);
    await sell(b, 4, other);
    await tx(swap.connect(buyer).closeOffer(b));
    assert.equal(start - (await movn.balanceOf(await addr(buyer))), us(400));
    assert.equal((await swap.getOffer(b)).movnRemaining, 0n);
    await assert.rejects(swap.connect(other).closeOffer(99), /OFFER_CLOSED/);
    await conserved();
  });

  it("stops fills at expiry and lets anyone send an expired offer back to its maker", async () => {
    const s = await sellOffer(10, 100, 1, 1);
    const b = await buyOffer(10, 100, 1, 1);
    await advance(DAY + 1);
    await assert.rejects(buy(s, 1), /OFFER_CLOSED/);
    await assert.rejects(sell(b, 1, other), /OFFER_CLOSED/);
    const otherW = await wbmb.balanceOf(await addr(other));
    const otherM = await movn.balanceOf(await addr(other));
    await tx(swap.connect(other).closeOffer(s));
    await tx(swap.connect(other).closeOffer(b));
    assert.equal(await wbmb.balanceOf(await addr(seller)), wb(1000));
    assert.equal(await movn.balanceOf(await addr(buyer)), us(100000));
    assert.equal(await wbmb.balanceOf(await addr(other)), otherW);
    assert.equal(await movn.balanceOf(await addr(other)), otherM);
    await conserved();
  });

  it("anyone can move collected fees to the fee wallet, and only there", async () => {
    await assert.rejects(swap.connect(other).flushFees(), /NO_FEES/);
    await buy(await sellOffer(10, 112, 1), 10);
    await tx(swap.connect(other).flushFees());
    assert.equal(await movn.balanceOf(await addr(feeWallet)), us("5.6"));
    assert.equal(await swap.feeBalance(), 0n);
    assert.equal(await movn.balanceOf(swap.target), 0n);
    await conserved();
  });

  it("while MOVN is paused nothing trades, but a seller can still take the WBMB back", async () => {
    const s = await sellOffer(10, 100, 1);
    const b = await buyOffer(10, 100, 1);
    await tx(movn.setPaused(true));
    await assert.rejects(buy(s, 1));
    await assert.rejects(sell(b, 1, other));
    await assert.rejects(swap.connect(buyer).closeOffer(b));
    await tx(swap.connect(seller).closeOffer(s));
    assert.equal(await wbmb.balanceOf(await addr(seller)), wb(1000));
    await tx(movn.setPaused(false));
    await tx(swap.connect(buyer).closeOffer(b));
    assert.equal(await movn.balanceOf(await addr(buyer)), us(100000));
    await conserved();
  });

  it("a blocked maker's offer cannot be filled while everyone else keeps trading", async () => {
    const s = await sellOffer(10, 100, 1);
    await tx(wbmb.connect(other).approve(swap.target, wb(10)));
    await tx(
      swap
        .connect(other)
        .createOffer(SELL, wb(10), us(100), wb(1), (await now()) + DAY),
    );
    const s2 = await swap.offerCount();
    await tx(movn.setBlocked(await addr(seller), true));
    await assert.rejects(buy(s, 1), /BLOCKED/);
    await buy(s2, 1);
    // the blocked maker still gets the WBMB back
    await tx(swap.connect(seller).closeOffer(s));
    assert.equal(await wbmb.balanceOf(await addr(seller)), wb(1000));
    await conserved();
  });

  it("a blocked fee wallet stops only the fee transfer, not trading", async () => {
    await tx(movn.setBlocked(await addr(feeWallet), true));
    await buy(await sellOffer(10, 100, 1), 10);
    await assert.rejects(swap.flushFees(), /BLOCKED/);
    assert.equal(await swap.feeBalance(), us(5));
    await tx(movn.setBlocked(await addr(feeWallet), false));
    await tx(swap.flushFees());
    assert.equal(await movn.balanceOf(await addr(feeWallet)), us(5));
    await conserved();
  });

  describe("with a misbehaving quote token", () => {
    let bad, market;
    beforeEach(async () => {
      bad = await deployContract("FaultyToken", admin, [18]);
      market = await deployContract("P2PSwap", admin, [
        bad.target,
        wbmb.target,
        await addr(feeWallet),
        50,
      ]);
      for (const s of [seller, buyer])
        await tx(bad.mint(await addr(s), us(1000)));
      await tx(bad.connect(buyer).approve(market.target, us(1000)));
      await tx(wbmb.connect(seller).approve(market.target, wb(100)));
    });
    const expiry = async () => (await now()) + DAY;

    it("refuses a token that takes a cut on transfer", async () => {
      await tx(bad.setFaults(false, true, ZeroAddress, "0x"));
      await assert.rejects(
        market
          .connect(buyer)
          .createOffer(BUY, wb(1), us(100), wb(1), await expiry()),
        /NON_EXACT_TOKEN/,
      );
      await tx(
        market
          .connect(seller)
          .createOffer(SELL, wb(1), us(100), wb(1), await expiry()),
      );
      await assert.rejects(
        market.connect(buyer).fillOffer(1, wb(1), us(100), (await now()) + 300),
        /NON_EXACT_TOKEN/,
      );
      assert.equal((await market.getOffer(1)).remaining, wb(1));
      await conserved(market, bad);
    });

    it("blocks a token that calls back into the market during a transfer", async () => {
      await tx(
        market
          .connect(seller)
          .createOffer(SELL, wb(2), us(100), wb(1), await expiry()),
      );
      await tx(
        bad.setFaults(
          false,
          false,
          market.target,
          market.interface.encodeFunctionData("closeOffer", [1]),
        ),
      );
      await tx(
        market.connect(buyer).fillOffer(1, wb(1), us(100), (await now()) + 300),
      );
      assert.equal(await bad.reentryBlocked(), true);
      assert.equal(
        await bad.reentryError(),
        market.interface.getError("ReentrancyGuardReentrantCall").selector,
      );
      assert.equal((await market.getOffer(1)).remaining, wb(1));
      await conserved(market, bad);
    });

    it("keeps balances when a transfer fails", async () => {
      await tx(
        market
          .connect(seller)
          .createOffer(SELL, wb(2), us(100), wb(1), await expiry()),
      );
      await tx(bad.setFaults(true, false, ZeroAddress, "0x"));
      await assert.rejects(
        market.connect(buyer).fillOffer(1, wb(1), us(100), (await now()) + 300),
      );
      assert.equal((await market.getOffer(1)).remaining, wb(2));
      assert.equal(await wbmb.balanceOf(market.target), wb(2));
      await conserved(market, bad);
    });
  });
});
