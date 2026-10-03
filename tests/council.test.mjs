import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import {
  BrowserProvider,
  Wallet,
  ZeroHash,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import { deployContract, us } from "../scripts/deploy.mjs";
import {
  COUNCIL_POLICY_ID,
  councilDomain,
  signCouncilReport,
  submitCouncilReport,
} from "../src/council-signing.mjs";

describe("CouncilPricePolicy", () => {
  let c, provider, admin, oracle, reporters, snap;
  const MAX_AGE = 6 * 86400;
  const MIN_INTERVAL = 43200;
  const tx = async (p) => (await p).wait();
  const now = async () => Number((await provider.getBlock("latest")).timestamp);
  async function advance(s) {
    await provider.send("evm_increaseTime", [s]);
    await provider.send("evm_mine", []);
  }
  const deploy = (args) => deployContract("CouncilPricePolicy", admin, args);
  const addresses = () => reporters.map((w) => w.address);
  async function report(price, over = {}) {
    const t = await now();
    return {
      policyId: COUNCIL_POLICY_ID,
      roundId: Number(await oracle.lastRoundId()) + 1,
      price: us(price),
      confirmedAt: t,
      validUntil: t + MAX_AGE - 60,
      ...over,
    };
  }
  const submit = (r, signers = reporters.slice(0, 2)) =>
    tx(submitCouncilReport(oracle, r, signers));

  before(async () => {
    c = await network.create();
    provider = new BrowserProvider(c.provider, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 10;
    admin = await provider.getSigner(0);
    reporters = [0, 1, 2].map(() => Wallet.createRandom().connect(provider));
    oracle = await deploy([
      addresses(),
      2,
      COUNCIL_POLICY_ID,
      MAX_AGE,
      3000,
      MIN_INTERVAL,
    ]);
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

  it("constructor rejects bad reporter sets, thresholds and limits", async () => {
    const r = addresses();
    const args = (over) =>
      Object.values({
        reporters: r,
        threshold: 2,
        id: COUNCIL_POLICY_ID,
        maxAge: MAX_AGE,
        change: 3000,
        interval: MIN_INTERVAL,
        ...over,
      });
    await assert.rejects(deploy(args({ reporters: [] })), /BAD_REPORTERS/);
    await assert.rejects(
      deploy(args({ reporters: [r[0], r[0]] })),
      /BAD_REPORTERS/,
    );
    await assert.rejects(deploy(args({ threshold: 4 })), /BAD_THRESHOLD/);
    await assert.rejects(deploy(args({ threshold: 0 })), /BAD_THRESHOLD/);
    await assert.rejects(deploy(args({ id: ZeroHash })), /BAD_POLICY/);
    await assert.rejects(deploy(args({ maxAge: 3599 })), /BAD_LIMITS/);
    await assert.rejects(
      deploy(args({ maxAge: 14 * 86400 + 1 })),
      /BAD_LIMITS/,
    );
    await assert.rejects(deploy(args({ change: 0 })), /BAD_LIMITS/);
    await assert.rejects(deploy(args({ change: 10000 })), /BAD_LIMITS/);
    await assert.rejects(
      deploy(args({ interval: 7 * 86400 + 1 })),
      /BAD_LIMITS/,
    );
  });

  it("has no price before the first report and serves it after", async () => {
    await assert.rejects(oracle.prices(), /STALE_PRICE/);
    const r = await report(112.3);
    await submit(r);
    assert.deepEqual([...(await oracle.prices())], [us(112.3), us(112.3)]);
    assert.equal(await oracle.confirmedAt(), BigInt(r.confirmedAt));
    assert.equal(await oracle.lastRoundId(), 1n);
  });

  it("rejects wrong policy, round gaps and replays", async () => {
    await assert.rejects(
      submit(await report(100, { policyId: ZeroHash })),
      /BAD_POLICY/,
    );
    await assert.rejects(
      submit(await report(100, { roundId: 2 })),
      /ROUND_GAP/,
    );
    const r = await report(100);
    await submit(r);
    await assert.rejects(submit(r), /ROUND_GAP/);
  });

  it("rejects expired, too-long, future-confirmed and backdated reports", async () => {
    const t = await now();
    await assert.rejects(
      submit(await report(100, { validUntil: t })),
      /BAD_VALIDITY/,
    );
    await assert.rejects(
      submit(await report(100, { validUntil: t + MAX_AGE + 3600 })),
      /BAD_VALIDITY/,
    );
    await assert.rejects(
      submit(await report(100, { confirmedAt: t + 3600 })),
      /BAD_VALIDITY/,
    );
    await submit(await report(100));
    await assert.rejects(
      submit(await report(100, { confirmedAt: t - 10 })),
      /BAD_VALIDITY/,
    );
  });

  it("rejects zero and oversized prices", async () => {
    await assert.rejects(submit(await report(1, { price: 0n })), /BAD_PRICE/);
    await assert.rejects(
      submit(await report(1, { price: 10n ** 30n + 1n })),
      /BAD_PRICE/,
    );
  });

  it("rejects too few, outsider, duplicate and unsorted signatures and foreign domains", async () => {
    const r = await report(100);
    await assert.rejects(
      submit(r, reporters.slice(0, 1)),
      /NOT_ENOUGH_SIGNATURES/,
    );
    await assert.rejects(
      submit(r, [reporters[0], Wallet.createRandom().connect(provider)]),
      /BAD_SIGNER/,
    );
    const { chainId } = await provider.getNetwork();
    const domain = councilDomain(chainId, oracle.target);
    const [one] = await signCouncilReport(domain, r, [reporters[0]]);
    await assert.rejects(oracle.submit(r, [one, one]), /BAD_SIGNER/);
    const sorted = await signCouncilReport(domain, r, reporters.slice(0, 2));
    await assert.rejects(
      oracle.submit(r, [sorted[1], sorted[0]]),
      /BAD_SIGNER/,
    );
    const foreign = await signCouncilReport(
      councilDomain(56, oracle.target),
      r,
      reporters.slice(0, 2),
    );
    await assert.rejects(oracle.submit(r, foreign), /BAD_SIGNER/);
    const tampered = await signCouncilReport(
      domain,
      { ...r, price: us(50) },
      reporters.slice(0, 2),
    );
    await assert.rejects(oracle.submit(r, tampered), /BAD_SIGNER/);
  });

  it("limits a price change to maxChangeBps in either direction", async () => {
    await submit(await report(100));
    await advance(MIN_INTERVAL);
    await assert.rejects(submit(await report(130.01)), /PRICE_JUMP/);
    await assert.rejects(submit(await report(69.99)), /PRICE_JUMP/);
    await submit(await report(130));
    assert.equal(await oracle.current(), us(130));
  });

  it("makes a second change wait minInterval but accepts same-price refreshes any time", async () => {
    await submit(await report(100));
    await assert.rejects(submit(await report(101)), /TOO_SOON/);
    const refresh = await report(100);
    await submit(refresh);
    assert.equal(await oracle.validUntil(), BigInt(refresh.validUntil));
    assert.equal(await oracle.lastRoundId(), 2n);
    await advance(MIN_INTERVAL);
    await submit(await report(101));
    await assert.rejects(submit(await report(102)), /TOO_SOON/);
  });

  it("opening price holds the lower of previous and current for minInterval after a rise", async () => {
    await submit(await report(100));
    await advance(MIN_INTERVAL);
    await submit(await report(120));
    assert.deepEqual([...(await oracle.prices())], [us(100), us(120)]);
    await advance(MIN_INTERVAL);
    assert.deepEqual([...(await oracle.prices())], [us(120), us(120)]);
    await submit(await report(90));
    assert.deepEqual([...(await oracle.prices())], [us(90), us(90)]);
  });

  it("goes stale after validUntil and resumes with the next report", async () => {
    await submit(await report(100));
    await advance(MAX_AGE);
    await assert.rejects(oracle.prices(), /STALE_PRICE/);
    await submit(await report(100));
    assert.equal((await oracle.prices())[1], us(100));
  });
});

// The quote token is MOVN since 2026-10-04: reports signed for the MOVN-era domain must not
// be accepted by a policy deployed under the new id, whatever else matches.
describe("MOVN report domain", () => {
  let c, provider, admin, reporters, policy;
  const MAX_AGE = 6 * 86400;
  const USDT_ID = keccak256(toUtf8Bytes("wbmb-usdt/mobick-council/v1"));
  before(async () => {
    c = await network.create();
    provider = new BrowserProvider(c.provider, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 10;
    admin = await provider.getSigner(0);
    reporters = [0, 1].map(() => Wallet.createRandom().connect(provider));
    policy = await deployContract("CouncilPricePolicy", admin, [
      reporters.map((w) => w.address),
      1,
      COUNCIL_POLICY_ID,
      MAX_AGE,
      3000,
      300,
    ]);
  });
  after(async () => {
    provider?.destroy();
    await c?.close();
  });
  async function report(over = {}) {
    const t = Number((await provider.getBlock("latest")).timestamp);
    return {
      policyId: COUNCIL_POLICY_ID,
      roundId: 1,
      price: us(112.3),
      confirmedAt: t,
      validUntil: t + MAX_AGE - 60,
      ...over,
    };
  }
  it("policyId names MOVN as the quote token", () => {
    assert.equal(
      COUNCIL_POLICY_ID,
      keccak256(toUtf8Bytes("wbmb-movn/mobick-council/v1")),
    );
    assert.notEqual(COUNCIL_POLICY_ID, USDT_ID);
  });
  it("a report under the old MOVN domain is refused, the same report under MOVN is accepted", async () => {
    await assert.rejects(
      submitCouncilReport(
        policy,
        await report({ policyId: USDT_ID }),
        reporters.slice(0, 1),
      ),
      /BAD_POLICY/,
    );
    await (
      await submitCouncilReport(policy, await report(), reporters.slice(0, 1))
    ).wait();
    assert.equal(await policy.current(), us(112.3));
  });
});
