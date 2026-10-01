import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { BrowserProvider, Wallet, ZeroHash, keccak256, toUtf8Bytes } from "ethers";
import { deployContract } from "../scripts/deploy.mjs";
import { demoPriceReport, BUCKET_SECONDS } from "../src/prices.mjs";
import {
  POLICY_ID,
  domainFor,
  toReport,
  hashRawData,
  collectSignatures,
  submitReport,
} from "../src/report-signing.mjs";

describe("SignedPricePolicy", () => {
  let c, provider, admin, oracle, reporters, snap;
  const E = 10n ** 18n;
  const MAX_AGE = 7200;
  const tx = async (p) => (await p).wait();
  const now = async () => Number((await provider.getBlock("latest")).timestamp);
  async function advance(s) {
    await provider.send("evm_increaseTime", [s]);
    await provider.send("evm_mine", []);
  }
  const deploy = (args) => deployContract("SignedPricePolicy", admin, args);
  const addresses = () => reporters.map((w) => w.address);
  async function baseReport(over = {}) {
    const pr = demoPriceReport(await now());
    const r = toReport(pr, {
      roundId: Number(await oracle.lastRoundId()) + 1,
      validUntil: pr.windowEnd + MAX_AGE,
      rawDataHash: hashRawData([], []),
    });
    return { ...r, ...over };
  }
  const submit = (report, signers = reporters.slice(0, 2)) =>
    tx(submitReport(oracle, report, signers));
  const domain = async () =>
    domainFor((await provider.getNetwork()).chainId, oracle.target);

  before(async () => {
    c = await network.create();
    provider = new BrowserProvider(c.provider, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 10;
    admin = await provider.getSigner(0);
    reporters = [0, 1, 2].map(() => Wallet.createRandom().connect(provider));
    await advance(8 * 86400); // chain time must exceed one 7-day window
    oracle = await deploy([addresses(), 2, POLICY_ID, 10000, 1000, MAX_AGE]);
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

  it("constructor rejects bad reporter sets, thresholds and parameters", async () => {
    const r = addresses();
    await assert.rejects(deploy([[], 1, POLICY_ID, 10000, 1000, MAX_AGE]), /BAD_REPORTERS/);
    await assert.rejects(deploy([[r[0], r[0]], 1, POLICY_ID, 10000, 1000, MAX_AGE]), /BAD_REPORTERS/);
    await assert.rejects(deploy([r, 4, POLICY_ID, 10000, 1000, MAX_AGE]), /BAD_THRESHOLD/);
    await assert.rejects(deploy([r, 0, POLICY_ID, 10000, 1000, MAX_AGE]), /BAD_THRESHOLD/);
    await assert.rejects(deploy([r, 2, ZeroHash, 10000, 1000, MAX_AGE]), /BAD_POLICY/);
    await assert.rejects(deploy([r, 2, POLICY_ID, 0, 1000, MAX_AGE]), /BAD_CONVERSION/);
    await assert.rejects(deploy([r, 2, POLICY_ID, 10000, 10001, MAX_AGE]), /BAD_DIVERGENCE/);
    await assert.rejects(deploy([r, 2, POLICY_ID, 10000, 1000, 60]), /BAD_MAX_AGE/);
    assert.deepEqual([...(await oracle.reporters())], r);
    assert.equal(await oracle.threshold(), 2n);
  });

  it("accepts a 2-of-3 report, stores the min of sources and emits the round", async () => {
    const report = await baseReport({
      dexLow: 100n * E, cexLow: 99n * E, dexCurrent: 103n * E, cexCurrent: 104n * E,
    });
    const receipt = await submit(report, [reporters[2], reporters[0]]); // unsorted input
    const ev = receipt.logs
      .map((l) => oracle.interface.parseLog(l))
      .find((e) => e?.name === "ReportAccepted");
    assert.equal(ev.args.roundId, 1n);
    assert.equal(ev.args.weekLow, 99n * E);
    assert.equal(ev.args.current, 103n * E);
    assert.equal(ev.args.signerCount, 2n);
    assert.equal(await oracle.lastRoundId(), 1n);
    assert.equal(await oracle.rawDataHash(), report.rawDataHash);
    const [opening, current] = await oracle.prices();
    assert.equal(opening, 99n * E);
    assert.equal(current, 103n * E);
    await submit(await baseReport(), reporters); // all three also fine
    assert.equal(await oracle.lastRoundId(), 2n);
  });

  it("applies the conversion factor and rejects zero adjusted prices", async () => {
    const o2 = await deploy([addresses(), 2, POLICY_ID, 5000, 10000, MAX_AGE]);
    const r = await baseReport({
      dexLow: 50n * E, cexLow: 100n * E, dexCurrent: 50n * E, cexCurrent: 100n * E,
    });
    await tx(submitReport(o2, r, reporters.slice(0, 2)));
    assert.equal(await o2.weekLow(), 50n * E);
    await assert.rejects(
      tx(submitReport(o2, { ...r, roundId: 2, cexLow: 1n }, reporters.slice(0, 2))),
      /BAD_PRICE/,
    );
  });

  it("rejects insufficient, foreign, duplicated and unsorted signatures", async () => {
    const report = await baseReport();
    const d = await domain();
    await assert.rejects(submit(report, [reporters[0]]), /NOT_ENOUGH_SIGNATURES/);
    const outsider = Wallet.createRandom().connect(provider);
    await assert.rejects(submit(report, [reporters[0], outsider]), /BAD_SIGNER/);
    const [one] = await collectSignatures(d, report, [reporters[0]]);
    await assert.rejects(tx(oracle.submit(report, [one, one])), /BAD_SIGNER/);
    const sorted = await collectSignatures(d, report, reporters.slice(0, 2));
    await assert.rejects(tx(oracle.submit(report, [sorted[1], sorted[0]])), /BAD_SIGNER/);
    await assert.rejects(tx(oracle.submit(report, ["0x1234", sorted[0]])));
  });

  it("rejects signatures from another domain or a tampered report", async () => {
    const report = await baseReport();
    const { chainId } = await provider.getNetwork();
    const wrongChain = await collectSignatures(
      domainFor(Number(chainId) + 1, oracle.target), report, reporters.slice(0, 2),
    );
    await assert.rejects(tx(oracle.submit(report, wrongChain)), /BAD_SIGNER/);
    const wrongContract = await collectSignatures(
      domainFor(chainId, reporters[0].address), report, reporters.slice(0, 2),
    );
    await assert.rejects(tx(oracle.submit(report, wrongContract)), /BAD_SIGNER/);
    const good = await collectSignatures(await domain(), report, reporters.slice(0, 2));
    await assert.rejects(
      tx(oracle.submit({ ...report, dexLow: report.dexLow - 1n }, good)),
      /BAD_SIGNER/,
    );
  });

  it("rejects replay, lower rounds and wrong policy ids", async () => {
    const report = await baseReport();
    await submit(report);
    await assert.rejects(submit(report), /OLD_ROUND/);
    await assert.rejects(submit({ ...report, roundId: 0 }), /OLD_ROUND/);
    await assert.rejects(
      submit({ ...report, roundId: 2, policyId: keccak256(toUtf8Bytes("other")) }),
      /BAD_POLICY/,
    );
  });

  it("rejects malformed windows, validity and coverage", async () => {
    const r = await baseReport();
    await assert.rejects(
      submit({ ...r, windowEnd: r.windowEnd + 1, windowStart: r.windowStart + 1 }),
      /BAD_WINDOW/,
    );
    await assert.rejects(
      submit({ ...r, windowStart: r.windowStart + BUCKET_SECONDS }),
      /BAD_WINDOW/,
    );
    const future = 2 * BUCKET_SECONDS;
    await assert.rejects(
      submit({
        ...r,
        windowEnd: r.windowEnd + future,
        windowStart: r.windowStart + future,
        validUntil: r.windowEnd + future + MAX_AGE,
      }),
      /BAD_WINDOW/,
    );
    // underflow guard: a window shorter than 7 days must fail cleanly, not panic
    await assert.rejects(submit({ ...r, windowEnd: 1800, windowStart: 0 }), /BAD_WINDOW/);
    await assert.rejects(submit({ ...r, validUntil: r.windowEnd + MAX_AGE + 1 }), /BAD_VALIDITY/);
    await assert.rejects(submit({ ...r, validUntil: (await now()) - 1 }), /BAD_VALIDITY/);
    await assert.rejects(submit({ ...r, bucketCount: 335 }), /BAD_COVERAGE/);
    await assert.rejects(submit({ ...r, dexCurrent: 0n }), /BAD_PRICE/);
    await assert.rejects(submit({ ...r, cexLow: 10n ** 30n + 1n }), /BAD_PRICE/);
  });

  it("rejects source divergence beyond the limit, per pair", async () => {
    await assert.rejects(submit(await baseReport({ dexLow: 100n * E, cexLow: 111n * E })), /DIVERGENCE/);
    await assert.rejects(submit(await baseReport({ dexCurrent: 111n * E, cexCurrent: 100n * E })), /DIVERGENCE/);
    await submit(await baseReport({ dexLow: 100n * E, cexLow: 110n * E })); // exactly 10% allowed
  });

  it("prices() is stale before any report and after validUntil; a new round revives it", async () => {
    await assert.rejects(oracle.prices(), /STALE_PRICE/);
    await submit(await baseReport());
    await oracle.prices();
    await advance(MAX_AGE + 1);
    await assert.rejects(oracle.prices(), /STALE_PRICE/);
    await submit(await baseReport());
    await oracle.prices();
  });
});
