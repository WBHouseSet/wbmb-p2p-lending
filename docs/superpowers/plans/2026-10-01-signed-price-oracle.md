# Signed Price Oracle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-reporter `MockPricePolicy` with `SignedPricePolicy`, which accepts threshold-signed EIP-712 price reports and re-checks freshness, coverage, min and source divergence on-chain.

**Architecture:** A new immutable contract implements the existing `IPricePolicy` so `P2PLending` and `MockFeeBurner` are untouched. An off-chain module (`src/report-signing.mjs`) turns the output of `src/prices.mjs` into an EIP-712 `Report`, signs it with reporter signers and submits it. Deploy script, EVM tests and the web lab all publish prices through that one path.

**Tech Stack:** Solidity 0.8 + OpenZeppelin 5.6.1 (`EIP712`, `ECDSA`), ethers 6 (`signTypedData`), Hardhat 3 local EVM, node:test, Vite, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-01-signed-price-oracle-design.md`

## Global Constraints

- Prices are USDT base units (18 decimals) per whole WBMB; `0 < p <= 1e30`.
- Window: 336 buckets × 1800 s. `windowEnd % 1800 == 0`, `windowStart == windowEnd − 604800`.
- No owner / setter / reporter-change function on `SignedPricePolicy`.
- `prices()` must revert with the string `STALE_PRICE` when expired (the app and `P2PLending` tests key on it).
- Keep the lab status text `모의 가격을 반영했습니다.` (browser test asserts `모의 가격을 반영`).
- All `.sol` files under `contracts/` are compiled and size-checked by `scripts/compile.mjs`; no Hardhat config change needed.
- Commit after each task with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. `windowEnd < 604800` (tiny timestamps in a fresh local chain) must revert `BAD_WINDOW`, not panic on underflow — Task 2 test "rejects malformed windows".
2. Signatures of the correct report by the correct reporters but for another chain / another contract address must be rejected — Task 2 test "rejects signatures from another domain".
3. Submitting the exact same accepted report again (replay) must revert `OLD_ROUND` — Task 2 test "rejects replay and lower rounds".
4. The lab pressing "1일 경과" after the last report expired must still be able to publish (new round, new window) — Task 5 browser flow + Task 4 `publishPrices` always derives window from the latest block.
5. A report whose `cexLow*conversionBps/10000` rounds to 0 must revert `BAD_PRICE` rather than storing a zero low — Task 2 test "rejects zero adjusted prices".

---

### Task 1: Expose per-source values from `buildPriceReport`

**Files:**
- Modify: `src/prices.mjs:57-78`
- Test: `tests/prices.test.mjs`

**Interfaces:**
- Produces: `buildPriceReport(...)` additionally returns `dexLow`, `dexCurrent`, `cexLow`, `cexCurrent` (bigint, **cex values are raw / before conversion**). Existing `weekLow`, `current` unchanged.

- [ ] **Step 1: Add failing test** to `tests/prices.test.mjs` (append inside the file's existing style):

```js
test("report exposes raw per-source lows and currents", () => {
  const r = demoPriceReport(1_800_000_000);
  assert.equal(typeof r.dexLow, "bigint");
  assert.equal(r.dexLow, 100n * 10n ** 18n);
  assert.equal(r.cexLow, 101n * 10n ** 18n); // raw, before conversionBps
  assert.equal(r.dexCurrent, r.current <= r.dexCurrent ? r.dexCurrent : r.current);
  assert.ok(r.cexCurrent >= r.current);
});
```

- [ ] **Step 2: Run** `node --test tests/prices.test.mjs` → FAIL (`dexLow` undefined).

- [ ] **Step 3: Implement** — in `buildPriceReport`, keep the raw cex array before mapping:

```js
  const d = validate(dex);
  const cRaw = validate(cex);
  const c = cRaw.map((p) => (p * BigInt(conversionBps)) / 10000n);
  // ... divergence loop unchanged ...
  return {
    policy: "synthetic-7d-30m-min-v1",
    windowStart: start, windowEnd, bucketCount: BUCKET_COUNT,
    weekLow, current, scale: SCALE,
    dexLow: min(d), dexCurrent: d.at(-1),
    cexLow: min(cRaw), cexCurrent: cRaw.at(-1),
  };
```

- [ ] **Step 4: Run** `node --test tests/prices.test.mjs` → all PASS.
- [ ] **Step 5: Commit** `feat(prices): expose per-source lows for signed reports`.

---

### Task 2: `SignedPricePolicy` contract + off-chain signing module + oracle tests

**Files:**
- Create: `contracts/SignedPricePolicy.sol`
- Create: `src/report-signing.mjs`
- Create: `tests/oracle.test.mjs`

**Interfaces:**
- Produces (Solidity): `constructor(address[] reporters, uint256 threshold, bytes32 policyId, uint256 conversionBps, uint256 maxDivergenceBps, uint256 maxAge)`; `submit(Report calldata, bytes[] calldata)`; views `weekLow() current() validUntil() windowEnd() lastRoundId() rawDataHash() threshold() reporters() isReporter(address) policyId() hashReport(Report)`; `prices()`.
- Produces (JS): `REPORT_TYPES`, `POLICY_ID`, `domainFor(chainId, address)`, `toReport(priceReport, {roundId, validUntil, rawDataHash})`, `hashRawData(dex, cex)`, `signReport(signer, domain, report)`, `collectSignatures(domain, report, signers)` (sorted by address asc), `submitReport(policy, report, signers)`.

- [ ] **Step 1: Write `src/report-signing.mjs`**

```js
// Builds, signs and submits EIP-712 price reports. Signing a report asserts the
// signer vouches for the input data; this module does not fetch market data.
import { keccak256, toUtf8Bytes } from "ethers";
import { BUCKET_COUNT } from "./prices.mjs";

export const DOMAIN_NAME = "WBMB Price Report";
export const DOMAIN_VERSION = "1";
export const POLICY_ID = keccak256(toUtf8Bytes("wbmb-usdt/7d-30m-min/dex+lbank/v1"));
export const REPORT_TYPES = {
  Report: [
    { name: "policyId", type: "bytes32" },
    { name: "roundId", type: "uint64" },
    { name: "windowStart", type: "uint64" },
    { name: "windowEnd", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "bucketCount", type: "uint16" },
    { name: "dexLow", type: "uint256" },
    { name: "dexCurrent", type: "uint256" },
    { name: "cexLow", type: "uint256" },
    { name: "cexCurrent", type: "uint256" },
    { name: "rawDataHash", type: "bytes32" },
  ],
};

export function domainFor(chainId, verifyingContract) {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: Number(chainId), verifyingContract };
}

export function hashRawData(dex, cex) {
  const rows = (r) => r.map((x) => [x.start, x.end, x.price.toString(), x.valid]);
  return keccak256(toUtf8Bytes(JSON.stringify({ dex: rows(dex), cex: rows(cex) })));
}

export function toReport(priceReport, { roundId, validUntil, rawDataHash, policyId = POLICY_ID }) {
  if (!Number.isSafeInteger(roundId) || roundId <= 0) throw new Error("잘못된 roundId");
  if (!Number.isSafeInteger(validUntil) || validUntil <= priceReport.windowEnd) throw new Error("잘못된 유효기한");
  return {
    policyId,
    roundId,
    windowStart: priceReport.windowStart,
    windowEnd: priceReport.windowEnd,
    validUntil,
    bucketCount: BUCKET_COUNT,
    dexLow: priceReport.dexLow,
    dexCurrent: priceReport.dexCurrent,
    cexLow: priceReport.cexLow,
    cexCurrent: priceReport.cexCurrent,
    rawDataHash,
  };
}

export function signReport(signer, domain, report) {
  return signer.signTypedData(domain, REPORT_TYPES, report);
}

/// Signatures must be ordered by signer address ascending; the contract enforces this to reject duplicates.
export async function collectSignatures(domain, report, signers) {
  const entries = await Promise.all(
    signers.map(async (s) => ({ address: (await s.getAddress()).toLowerCase(), sig: await signReport(s, domain, report) })),
  );
  entries.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return entries.map((e) => e.sig);
}

export async function submitReport(policy, report, signers) {
  const { chainId } = await policy.runner.provider.getNetwork();
  const sigs = await collectSignatures(domainFor(chainId, policy.target), report, signers);
  return policy.submit(report, sigs);
}
```

- [ ] **Step 2: Write `tests/oracle.test.mjs`** (deploys its own oracle with random `Wallet` reporters):

```js
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { BrowserProvider, Wallet, ZeroHash, keccak256, toUtf8Bytes } from "ethers";
import { deployContract } from "../scripts/deploy.mjs";
import { demoPriceReport, BUCKET_SECONDS } from "../src/prices.mjs";
import { POLICY_ID, domainFor, toReport, hashRawData, collectSignatures, submitReport } from "../src/report-signing.mjs";

describe("SignedPricePolicy", () => {
  let c, provider, admin, oracle, reporters, snap;
  const E = 10n ** 18n;
  const MAX_AGE = 7200;
  const tx = async (p) => (await p).wait();
  const now = async () => Number((await provider.getBlock("latest")).timestamp);
  async function advance(s) { await provider.send("evm_increaseTime", [s]); await provider.send("evm_mine", []); }
  async function baseReport(over = {}) {
    const t = await now();
    const pr = demoPriceReport(t);
    const r = toReport(pr, { roundId: Number(await oracle.lastRoundId()) + 1, validUntil: pr.windowEnd + MAX_AGE, rawDataHash: hashRawData([], []) });
    return { ...r, ...over };
  }
  async function submit(report, signers = reporters.slice(0, 2)) { return tx(submitReport(oracle, report, signers)); }
  before(async () => {
    c = await network.create();
    provider = new BrowserProvider(c.provider, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 10;
    admin = await provider.getSigner(0);
    reporters = [0, 1, 2].map(() => Wallet.createRandom().connect(provider));
    // make sure the chain is past the first 7-day window so windows are representable
    await advance(8 * 86400);
    oracle = await deployContract("SignedPricePolicy", admin, [reporters.map((w) => w.address), 2, POLICY_ID, 10000, 1000, MAX_AGE]);
    snap = await provider.send("evm_snapshot", []);
  });
  beforeEach(async () => { await provider.send("evm_revert", [snap]); snap = await provider.send("evm_snapshot", []); });
  after(async () => { provider?.destroy(); await c?.close(); });

  it("constructor rejects bad reporter sets, thresholds and parameters", async () => {
    const r = reporters.map((w) => w.address);
    await assert.rejects(deployContract("SignedPricePolicy", admin, [[], 1, POLICY_ID, 10000, 1000, MAX_AGE]), /BAD_REPORTERS/);
    await assert.rejects(deployContract("SignedPricePolicy", admin, [[r[0], r[0]], 1, POLICY_ID, 10000, 1000, MAX_AGE]), /BAD_REPORTERS/);
    await assert.rejects(deployContract("SignedPricePolicy", admin, [r, 4, POLICY_ID, 10000, 1000, MAX_AGE]), /BAD_THRESHOLD/);
    await assert.rejects(deployContract("SignedPricePolicy", admin, [r, 0, POLICY_ID, 10000, 1000, MAX_AGE]), /BAD_THRESHOLD/);
    await assert.rejects(deployContract("SignedPricePolicy", admin, [r, 2, ZeroHash, 10000, 1000, MAX_AGE]), /BAD_POLICY/);
    await assert.rejects(deployContract("SignedPricePolicy", admin, [r, 2, POLICY_ID, 0, 1000, MAX_AGE]), /BAD_CONVERSION/);
    await assert.rejects(deployContract("SignedPricePolicy", admin, [r, 2, POLICY_ID, 10000, 10001, MAX_AGE]), /BAD_DIVERGENCE/);
    await assert.rejects(deployContract("SignedPricePolicy", admin, [r, 2, POLICY_ID, 10000, 1000, 60]), /BAD_MAX_AGE/);
    assert.deepEqual(await oracle.reporters(), r);
    assert.equal(await oracle.threshold(), 2n);
  });

  it("accepts a 2-of-3 report, stores the min of adjusted sources and emits the round", async () => {
    const report = await baseReport({ dexLow: 100n * E, cexLow: 99n * E, dexCurrent: 103n * E, cexCurrent: 104n * E });
    const receipt = await submit(report, [reporters[2], reporters[0]]); // unsorted input, helper sorts
    const ev = receipt.logs.map((l) => oracle.interface.parseLog(l)).find((e) => e?.name === "ReportAccepted");
    assert.equal(ev.args.roundId, 1n);
    assert.equal(ev.args.weekLow, 99n * E);
    assert.equal(ev.args.current, 103n * E);
    assert.equal(ev.args.signerCount, 2n);
    assert.equal(await oracle.lastRoundId(), 1n);
    assert.equal(await oracle.rawDataHash(), report.rawDataHash);
    const [opening, current] = await oracle.prices();
    assert.equal(opening, 99n * E); assert.equal(current, 103n * E);
    // 3 signatures also fine
    await submit(await baseReport(), reporters);
    assert.equal(await oracle.lastRoundId(), 2n);
  });

  it("applies the conversion factor and rejects zero adjusted prices", async () => {
    const o2 = await deployContract("SignedPricePolicy", admin, [reporters.map((w) => w.address), 2, POLICY_ID, 5000, 10000, MAX_AGE]);
    const r = await baseReport({ dexLow: 50n * E, cexLow: 100n * E, dexCurrent: 50n * E, cexCurrent: 100n * E });
    await tx(submitReport(o2, r, reporters.slice(0, 2)));
    assert.equal(await o2.weekLow(), 50n * E);
    await assert.rejects(tx(submitReport(o2, { ...r, roundId: 2, cexLow: 1n }, reporters.slice(0, 2))), /BAD_PRICE/);
  });

  it("rejects insufficient, foreign, duplicated and unsorted signatures", async () => {
    const report = await baseReport();
    const { chainId } = await provider.getNetwork();
    const domain = domainFor(chainId, oracle.target);
    await assert.rejects(submit(report, [reporters[0]]), /NOT_ENOUGH_SIGNATURES/);
    const outsider = Wallet.createRandom().connect(provider);
    await assert.rejects(submit(report, [reporters[0], outsider]), /BAD_SIGNER/);
    const dup = await collectSignatures(domain, report, [reporters[0]]);
    await assert.rejects(tx(oracle.submit(report, [dup[0], dup[0]])), /BAD_SIGNER/);
    const sorted = await collectSignatures(domain, report, reporters.slice(0, 2));
    await assert.rejects(tx(oracle.submit(report, [sorted[1], sorted[0]])), /BAD_SIGNER/);
    await assert.rejects(tx(oracle.submit(report, ["0x1234", sorted[0]])), /ECDSAInvalidSignatureLength|BAD_SIGNER/);
  });

  it("rejects signatures from another domain or a tampered report", async () => {
    const report = await baseReport();
    const { chainId } = await provider.getNetwork();
    const wrongChain = await collectSignatures(domainFor(Number(chainId) + 1, oracle.target), report, reporters.slice(0, 2));
    await assert.rejects(tx(oracle.submit(report, wrongChain)), /BAD_SIGNER/);
    const wrongContract = await collectSignatures(domainFor(chainId, reporters[0].address), report, reporters.slice(0, 2));
    await assert.rejects(tx(oracle.submit(report, wrongContract)), /BAD_SIGNER/);
    const good = await collectSignatures(domainFor(chainId, oracle.target), report, reporters.slice(0, 2));
    await assert.rejects(tx(oracle.submit({ ...report, dexLow: report.dexLow - 1n }, good)), /BAD_SIGNER/);
  });

  it("rejects replay, lower rounds and wrong policy ids", async () => {
    const report = await baseReport();
    await submit(report);
    await assert.rejects(submit(report), /OLD_ROUND/);
    await assert.rejects(submit({ ...report, roundId: 0 }), /OLD_ROUND/);
    await assert.rejects(submit({ ...report, roundId: 2, policyId: keccak256(toUtf8Bytes("other")) }), /BAD_POLICY/);
  });

  it("rejects malformed windows, validity and coverage", async () => {
    const r = await baseReport();
    await assert.rejects(submit({ ...r, windowEnd: r.windowEnd + 1, windowStart: r.windowStart + 1 }), /BAD_WINDOW/);
    await assert.rejects(submit({ ...r, windowStart: r.windowStart + BUCKET_SECONDS }), /BAD_WINDOW/);
    await assert.rejects(submit({ ...r, windowEnd: r.windowEnd + 2 * BUCKET_SECONDS, windowStart: r.windowStart + 2 * BUCKET_SECONDS, validUntil: r.windowEnd + 2 * BUCKET_SECONDS + MAX_AGE }), /BAD_WINDOW/); // future
    await assert.rejects(submit({ ...r, windowEnd: 1800, windowStart: 0 }), /BAD_WINDOW/); // underflow guard, not a panic
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

  it("prices() is stale before any report and after validUntil, and a new round revives it", async () => {
    await assert.rejects(oracle.prices(), /STALE_PRICE/);
    await submit(await baseReport());
    await oracle.prices();
    await advance(MAX_AGE + 1);
    await assert.rejects(oracle.prices(), /STALE_PRICE/);
    await submit(await baseReport());
    await oracle.prices();
  });
});
```

- [ ] **Step 3: Run** `npm test` → FAIL (artifact `SignedPricePolicy` missing).

- [ ] **Step 4: Write `contracts/SignedPricePolicy.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IPricePolicy} from "./IPricePolicy.sol";

/// Threshold-signed 7-day price reports. Reporter set, threshold and policy are immutable:
/// replacing them means deploying a new policy and a new lending market.
/// Verifies signatures, freshness, coverage, min and source divergence; it cannot prove source data is genuine.
contract SignedPricePolicy is IPricePolicy, EIP712 {
    struct Report {
        bytes32 policyId;
        uint64 roundId;
        uint64 windowStart;
        uint64 windowEnd;
        uint64 validUntil;
        uint16 bucketCount;
        uint256 dexLow;
        uint256 dexCurrent;
        uint256 cexLow;      // raw BMB/USDT, before conversionBps
        uint256 cexCurrent;  // raw BMB/USDT, before conversionBps
        bytes32 rawDataHash;
    }

    bytes32 public constant REPORT_TYPEHASH = keccak256(
        "Report(bytes32 policyId,uint64 roundId,uint64 windowStart,uint64 windowEnd,uint64 validUntil,uint16 bucketCount,uint256 dexLow,uint256 dexCurrent,uint256 cexLow,uint256 cexCurrent,bytes32 rawDataHash)"
    );
    uint256 public constant BUCKET_SECONDS = 1800;
    uint256 public constant BUCKET_COUNT = 336;
    uint256 public constant WINDOW = BUCKET_SECONDS * BUCKET_COUNT;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_PRICE = 1e30;

    bytes32 public immutable policyId;
    uint256 public immutable threshold;
    uint256 public immutable conversionBps;
    uint256 public immutable maxDivergenceBps;
    uint256 public immutable maxAge;
    address[] private reporterList;
    mapping(address => bool) public isReporter;

    uint256 public weekLow;
    uint256 public current;
    uint64 public validUntil;
    uint64 public windowEnd;
    uint64 public lastRoundId;
    bytes32 public rawDataHash;

    event ReportAccepted(uint64 indexed roundId, uint256 weekLow, uint256 current, uint64 windowEnd, uint64 validUntil, bytes32 rawDataHash, uint256 signerCount);

    constructor(address[] memory reporters_, uint256 threshold_, bytes32 policyId_, uint256 conversionBps_, uint256 maxDivergenceBps_, uint256 maxAge_)
        EIP712("WBMB Price Report", "1")
    {
        require(reporters_.length >= 1 && reporters_.length <= 16, "BAD_REPORTERS");
        require(threshold_ >= 1 && threshold_ <= reporters_.length, "BAD_THRESHOLD");
        require(policyId_ != bytes32(0), "BAD_POLICY");
        require(conversionBps_ >= 1 && conversionBps_ <= BPS, "BAD_CONVERSION");
        require(maxDivergenceBps_ <= BPS, "BAD_DIVERGENCE");
        require(maxAge_ >= 1 hours && maxAge_ <= 7 days, "BAD_MAX_AGE");
        for (uint256 i; i < reporters_.length; i++) {
            address r = reporters_[i];
            require(r != address(0) && !isReporter[r], "BAD_REPORTERS");
            isReporter[r] = true;
            reporterList.push(r);
        }
        threshold = threshold_; policyId = policyId_; conversionBps = conversionBps_;
        maxDivergenceBps = maxDivergenceBps_; maxAge = maxAge_;
    }

    function reporters() external view returns (address[] memory) { return reporterList; }

    function hashReport(Report calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            REPORT_TYPEHASH, r.policyId, r.roundId, r.windowStart, r.windowEnd, r.validUntil, r.bucketCount,
            r.dexLow, r.dexCurrent, r.cexLow, r.cexCurrent, r.rawDataHash
        )));
    }

    /// Anyone may submit; only the reporters' signatures matter. Signatures must be sorted by signer address.
    function submit(Report calldata r, bytes[] calldata sigs) external {
        require(r.policyId == policyId, "BAD_POLICY");
        require(r.roundId > lastRoundId, "OLD_ROUND");
        require(
            r.windowEnd >= WINDOW && r.windowEnd % BUCKET_SECONDS == 0 && r.windowEnd <= block.timestamp
                && r.windowStart == r.windowEnd - WINDOW,
            "BAD_WINDOW"
        );
        require(r.validUntil > block.timestamp && r.validUntil <= uint256(r.windowEnd) + maxAge, "BAD_VALIDITY");
        require(r.bucketCount == BUCKET_COUNT, "BAD_COVERAGE");
        require(_valid(r.dexLow) && _valid(r.dexCurrent) && _valid(r.cexLow) && _valid(r.cexCurrent), "BAD_PRICE");
        require(sigs.length >= threshold, "NOT_ENOUGH_SIGNATURES");
        bytes32 digest = hashReport(r);
        address last;
        for (uint256 i; i < sigs.length; i++) {
            address signer = ECDSA.recover(digest, sigs[i]);
            require(signer > last && isReporter[signer], "BAD_SIGNER");
            last = signer;
        }
        uint256 cexLowAdj = r.cexLow * conversionBps / BPS;
        uint256 cexCurrentAdj = r.cexCurrent * conversionBps / BPS;
        require(cexLowAdj > 0 && cexCurrentAdj > 0, "BAD_PRICE");
        uint256 low = _agreedMin(r.dexLow, cexLowAdj);
        uint256 cur = _agreedMin(r.dexCurrent, cexCurrentAdj);
        weekLow = low; current = cur; validUntil = r.validUntil; windowEnd = r.windowEnd;
        lastRoundId = r.roundId; rawDataHash = r.rawDataHash;
        emit ReportAccepted(r.roundId, low, cur, r.windowEnd, r.validUntil, r.rawDataHash, sigs.length);
    }

    function prices() external view returns (uint256, uint256) {
        require(validUntil != 0 && block.timestamp <= validUntil, "STALE_PRICE");
        return (weekLow < current ? weekLow : current, current);
    }

    function _valid(uint256 p) internal pure returns (bool) { return p > 0 && p <= MAX_PRICE; }

    /// Never silently falls back to the higher source: both must agree within maxDivergenceBps.
    function _agreedMin(uint256 a, uint256 b) internal view returns (uint256 lo) {
        uint256 hi;
        (lo, hi) = a < b ? (a, b) : (b, a);
        require((hi - lo) * BPS <= lo * maxDivergenceBps, "DIVERGENCE");
    }
}
```

- [ ] **Step 5: Run** `npm test` → `tests/oracle.test.mjs` all PASS; `lending.test.mjs` still passes (it still uses the mock until Task 3).
- [ ] **Step 6: Commit** `feat(oracle): add threshold-signed SignedPricePolicy with EIP-712 reports`.

---

### Task 3: Switch deployment and lending tests to the signed oracle; delete the mock

**Files:**
- Modify: `scripts/deploy.mjs:23-106,107-124`
- Modify: `tests/lending.test.mjs:29-30,353-360`
- Delete: `contracts/mocks/MockPricePolicy.sol`

**Interfaces:**
- Produces: `deployFixture` returns additionally `reporters` (array of 3 `JsonRpcSigner`, accounts 4–6), `reporterIndices = [4,5,6]`, `threshold = 2`, and `publishPrices(low, current, {dexLow, cexLow, dexCurrent, cexCurrent} = {})` where `low/current` are bigint 18-dec values applied to both sources unless overridden. `oracle` is now a `SignedPricePolicy`. Exported helper `publishPricesWith(provider, oracle, signers, low, current, overrides)` for the app-free path.
- `deployment.json` gains `oracle: { contract: "SignedPricePolicy", reporters, reporterIndices, threshold, policyId, maxAge }`.

- [ ] **Step 1: Modify `tests/lending.test.mjs`** — replace `refresh`:

```js
  const refresh = async (low = 100, current = 100) =>
    f.publishPrices(us(low), us(current));
```
and replace the body of the test at line 353 (`oracle reporter access and token precision are enforced`) with:

```js
  it("oracle rejects non-reporters and zero prices; token precision is enforced", async () => {
    const { submitReport } = await import("../src/report-signing.mjs");
    const { toReport, hashRawData } = await import("../src/report-signing.mjs");
    const { demoPriceReport } = await import("../src/prices.mjs");
    const pr = demoPriceReport(await now());
    const report = toReport(pr, { roundId: Number(await f.oracle.lastRoundId()) + 1, validUntil: pr.windowEnd + 7200, rawDataHash: hashRawData([], []) });
    await assert.rejects(tx(submitReport(f.oracle, report, [f.borrower, f.lender])), /BAD_SIGNER/);
    await assert.rejects(f.publishPrices(0n, us(100)), /BAD_PRICE/);
    // (keep the existing decimals assertions that follow in the original test body)
```
Keep whatever token-precision assertions the original test had after the oracle lines.

- [ ] **Step 2: Run** `npm test` → lending tests FAIL (`f.publishPrices` undefined).

- [ ] **Step 3: Modify `scripts/deploy.mjs`**

Imports:
```js
import { demoPriceReport } from "../src/prices.mjs";
import { POLICY_ID, toReport, hashRawData, submitReport } from "../src/report-signing.mjs";
```
Add exported helper (above `deployFixture`):
```js
export const REPORTER_INDICES = [4, 5, 6];
export const THRESHOLD = 2;
export const MAX_AGE = 7200;
/// Publishes a synthetic report where both sources show `low`/`current` unless overridden.
export async function publishPricesWith(provider, oracle, signers, low, current, overrides = {}) {
  const t = Number((await provider.getBlock("latest")).timestamp);
  const pr = demoPriceReport(t);
  const report = {
    ...toReport(pr, {
      roundId: Number(await oracle.lastRoundId()) + 1,
      validUntil: pr.windowEnd + MAX_AGE,
      rawDataHash: hashRawData([], []),
    }),
    dexLow: low, cexLow: low, dexCurrent: current, cexCurrent: current,
    ...overrides,
  };
  return (await submitReport(oracle, report, signers)).wait();
}
```
In `deployFixture`: accounts `[0..6]`; `const reporters = REPORTER_INDICES.map((i) => accounts[i]);` replace the oracle deploy + `setPrices` with:
```js
  const oracle = await deployContract("SignedPricePolicy", admin, [
    await Promise.all(reporters.map((r) => r.getAddress())), THRESHOLD, POLICY_ID, 10000, 1000, MAX_AGE,
  ]);
  const report = demoPriceReport(Number((await provider.getBlock("latest")).timestamp));
  const publishPrices = (low, current, overrides) =>
    publishPricesWith(provider, oracle, reporters.slice(0, THRESHOLD), low, current, overrides);
  await publishPrices(report.weekLow, report.current);
```
Mint loop: keep minting only to `addresses.slice(0, 4)` (demo accounts) — reporters need no tokens; `addresses` for `demoAccounts` must stay the first four. Return `reporters, reporterIndices: REPORTER_INDICES, threshold: THRESHOLD, publishPrices` in the fixture. In `saveDeployment` add:
```js
    oracle: {
      contract: "SignedPricePolicy",
      reporters: await ... // not async here: pass f.reporterAddresses computed in deployFixture
      reporterIndices: f.reporterIndices, threshold: f.threshold, policyId: POLICY_ID, maxAge: MAX_AGE,
    },
```
(compute `reporterAddresses` inside `deployFixture` and return it so `saveDeployment` stays sync). Change `pricePolicy` string to `"서명 보고서 2-of-3 · 모의 7일 30분 구간평균 최저가 (실제 시장 데이터 아님)"`.

- [ ] **Step 4: Delete `contracts/mocks/MockPricePolicy.sol`**, run `npm test` → all PASS (22 lending + 9 oracle + 7 prices).
- [ ] **Step 5: Commit** `refactor(deploy): publish prices through signed reports; remove MockPricePolicy`.

---

### Task 4: Web app reads and publishes signed reports; faucet unchanged

**Files:**
- Modify: `src/app.js:300-320,693-733,758-764`
- Modify: `index.html:60-64` (price-state label copy only if needed)
- Test: `tests/browser/app.spec.js` (existing flow must keep passing)

**Interfaces:**
- Consumes: `publishPricesWith` is Node-only (imports hardhat-free, but lives in `scripts/`) — the app re-implements the 6-line report build using `src/report-signing.mjs` + `src/prices.mjs` and `config.oracle.reporterIndices`.

- [ ] **Step 1: Modify `refresh()`** (app.js ~304):

```js
    const [oc, lc, low, current, validUntil, windowEnd, round, block] = await Promise.all([
      contracts.lending.offerCount(), contracts.lending.loanCount(),
      contracts.oracle.weekLow(), contracts.oracle.current(), contracts.oracle.validUntil(),
      contracts.oracle.windowEnd(), contracts.oracle.lastRoundId(), read.getBlock("latest"),
    ]);
    latest = block.timestamp;
    ...
    $("#price-state").textContent =
      latest > Number(validUntil)
        ? "가격 만료 · 신규 체결 중단"
        : `round ${round} · 관측 ${date(windowEnd)} · 서명 ${config.oracle.threshold}/${config.oracle.reporters.length}`;
```

- [ ] **Step 2: Modify `labAction`** — replace the `reporter`/`setPrices` block:

```js
    const t = Number((await read.getBlock("latest")).timestamp);
    const pr = demoPriceReport(t);
    const report = {
      ...toReport(pr, {
        roundId: Number(await contracts.oracle.lastRoundId()) + 1,
        validUntil: pr.windowEnd + Number(config.oracle.maxAge),
        rawDataHash: hashRawData([], []),
      }),
      dexLow: low, cexLow: low, dexCurrent: current, cexCurrent: current,
    };
    const signers = await Promise.all(
      config.oracle.reporterIndices.slice(0, config.oracle.threshold).map((i) => read.getSigner(i)),
    );
    await (await submitReport(contracts.oracle.connect(signers[0]), report, signers)).wait();
```
with imports at the top of app.js:
```js
import { demoPriceReport } from "./prices.mjs";
import { toReport, hashRawData, submitReport } from "./report-signing.mjs";
```
Success message unchanged (`모의 가격을 반영했습니다.` / `…일이 경과했습니다. 모의 가격 유효기간도 갱신했습니다.`). Also handle `oldLow`: `const oldLow = await contracts.oracle.weekLow()` stays.

- [ ] **Step 3: Change `names.oracle`** to `"SignedPricePolicy"` and the `init` config check to also require `config.oracle?.contract === "SignedPricePolicy"`.

- [ ] **Step 4: Run** `npm run build && npx playwright install chromium && npm run test:browser` → 6 PASS. If the `#status` assertion `모의 가격을 반영` fails, check that the lab signer `read.getSigner(4)` is unlocked on the local node (it is for the hardhat test accounts).
- [ ] **Step 5: Commit** `feat(web): show signed report round/validity and publish lab prices via reporters`.

---

### Task 5: Docs and validation record

**Files:**
- Modify: `README.md` (구현 범위 표, 자금 권한 절, 프로젝트 구조), `docs/IMPLEMENTATION.md` (가격 모듈 절, 다음 구현 작업 3번), `docs/VALIDATION.md` (counts, oracle note).

- [ ] **Step 1:** README 구현 범위 표 — replace row `가격 관측 지연 / 누락·괴리 거부` with `서명 보고서 오라클 (2-of-3, EIP-712, round·유효기한·커버리지·괴리 온체인 검사) | 구현, 합성 데이터` and add `SignedPricePolicy.sol` to the structure tree; in 자금 권한 절 replace "로컬 모의 단일 보고자" with "로컬 계정 3개 중 2개 서명이 필요한 보고서 오라클이며 보고자 집합은 변경 불가. 실제 거래소 데이터 수집은 아직 없음".
- [ ] **Step 2:** IMPLEMENTATION.md 가격 모듈 절 — describe `SignedPricePolicy` checks (list the 10 error codes), what it does **not** prove (source authenticity), and that the lab signs with local accounts 4·5. Update "다음 구현 작업" item 3 to the remaining parts (실제 수집기, 보고자 키 관리, 영구 장애 정책).
- [ ] **Step 3:** Run `npm run check`, then update VALIDATION.md test counts and add row `SignedPricePolicy 런타임 크기 N bytes` from the compile output.
- [ ] **Step 4: Commit** `docs: record signed price oracle`.
