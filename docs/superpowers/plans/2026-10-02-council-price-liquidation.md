# Council-Price Liquidation Market Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new USDT/WBMB lending market that liquidates at the Mobick council price: on default or price drop the lender receives debt × 1.05 worth of WBMB and the borrower keeps the rest.

**Architecture:** A new `CouncilPricePolicy` contract stores a threshold-signed council price behind the existing `IPricePolicy` interface. `P2PLending` keeps its existing price mode and gains a liquidation bonus, a stale-price escape and a grace floor. A one-shot relay script copies the council API price on-chain. The web app gains a third market kind (`policy: "council"`) for local demo and live builds.

**Tech Stack:** Solidity 0.8.37 (viaIR, optimizer 200, EVM cancun), OpenZeppelin 5.6.1, ethers 6.17, Hardhat 3 (`edr-simulated`), `node:test`, Vite 8, Playwright 1.63.

**Spec:** `docs/superpowers/specs/2026-10-02-council-price-liquidation-design.md`

## Global Constraints

- Never send anything to BSC mainnet. No `--broadcast`, no `--execute` against a real RPC. Local chains and dry runs only.
- Never print, log, commit or store a private key or mnemonic. Tests use `Wallet.createRandom()`.
- Do not delete or overwrite `deployments/bsc.json` or `deployments/bsc-test.json`.
- Do not touch anything under `../autouniswap`.
- Keep `evmVersion: "cancun"` in `scripts/compile.mjs`.
- Every contract must stay within 24,576 runtime bytes (`scripts/compile.mjs` fails otherwise).
- The two oracle-free markets must behave exactly as before: all tests in `tests/fixed.test.mjs`, `tests/browser-fixed/`, `tests/browser-live/` keep passing with only constructor-argument edits.
- Prices are USDT base units (18 decimals) per whole WBMB (8 decimals).
- Deployed values, main market: `feeBps` 500, `liquidationBonusBps` 500, `staleSettleDelay` 7 days, `minDuration` 1 hour, `minGrace` 1 day, policy `maxAge` 6 days, `maxChangeBps` 3000, `minInterval` 12 hours, 1 reporter, threshold 1. Test market: `minDuration`, `minGrace`, `minInterval`, `staleSettleDelay` all 300 seconds.
- Web form terms for the council market: `haircutBps` 4000, `liquidationBps` 8000, mode 0.
- User-facing text is Korean. Code comments are English, matching the existing files.
- Format with `npx prettier --write <files>` before each commit.

## Review Focus

1. **Relay outage while a loan is overdue.** The lender expects to recover collateral eventually; the borrower expects to still be able to repay. Pinned in Task 2 (`stale price` tests).
2. **Council API returns a malformed or exponent-form number, a future `confirmedAt`, or an HTTP error.** The relay must send nothing and exit non-zero. Pinned in Task 3 (`parseCouncilPrice` tests, `relay sends nothing on a bad API`).
3. **Price changes by more than the on-chain limit (the API moved 18.5% once; a larger move is possible).** The relay must not submit and must say why; the contract must reject. Pinned in Task 1 (`PRICE_JUMP`) and Task 3 (`planRelay` jump test).
4. **Borrower one minute late in the priced market.** They expect the grace period the market promises, not an instant 5% loss. Pinned in Task 2 (`BAD_GRACE`).
5. **A live page served with a swapped price-contract address.** The page must refuse to open. Pinned in Task 6 (live browser test `rejects a swapped oracle address`).

---

### Task 1: CouncilPricePolicy contract and signing helper

**Files:**
- Create: `contracts/CouncilPricePolicy.sol`
- Create: `src/council-signing.mjs`
- Test: `tests/council.test.mjs`

**Interfaces:**
- Consumes: `contracts/IPricePolicy.sol` (`prices() returns (uint256 openingPrice, uint256 currentPrice)`), `deployContract(name, signer, args)` from `scripts/deploy.mjs`.
- Produces:
  - Contract `CouncilPricePolicy(address[] reporters, uint256 threshold, bytes32 policyId, uint256 maxAge, uint256 maxChangeBps, uint256 minInterval)` with views `previous()`, `current()`, `confirmedAt()`, `validUntil()`, `changedAt()`, `lastRoundId()`, `policyId()`, `threshold()`, `maxAge()`, `maxChangeBps()`, `minInterval()`, `isReporter(address)`, `reporters()`, `prices()`, and `submit((bytes32 policyId,uint64 roundId,uint256 price,uint64 confirmedAt,uint64 validUntil) r, bytes[] sigs)`.
  - `src/council-signing.mjs` exports `COUNCIL_POLICY_ID`, `COUNCIL_TYPES`, `councilDomain(chainId, verifyingContract)`, `signCouncilReport(domain, report, signers) → Promise<string[]>` (sorted by signer address), `submitCouncilReport(policy, report, signers) → Promise<TransactionResponse>`.

- [ ] **Step 1: Write the signing helper**

`src/council-signing.mjs`:

```js
// Signs and submits Mobick council price reports (EIP-712). A signature means the reporter
// vouches that `price` is the council price confirmed at `confirmedAt`; nothing here proves it.
import { keccak256, toUtf8Bytes } from "ethers";

export const COUNCIL_DOMAIN_NAME = "WBMB Council Price";
export const COUNCIL_DOMAIN_VERSION = "1";
export const COUNCIL_POLICY_ID = keccak256(
  toUtf8Bytes("wbmb-usdt/mobick-council/v1"),
);
export const COUNCIL_TYPES = {
  Report: [
    { name: "policyId", type: "bytes32" },
    { name: "roundId", type: "uint64" },
    { name: "price", type: "uint256" },
    { name: "confirmedAt", type: "uint64" },
    { name: "validUntil", type: "uint64" },
  ],
};

export function councilDomain(chainId, verifyingContract) {
  return {
    name: COUNCIL_DOMAIN_NAME,
    version: COUNCIL_DOMAIN_VERSION,
    chainId: Number(chainId),
    verifyingContract,
  };
}

// The contract requires signatures ordered by signer address (ascending) to reject duplicates.
export async function signCouncilReport(domain, report, signers) {
  const entries = await Promise.all(
    signers.map(async (s) => ({
      address: (await s.getAddress()).toLowerCase(),
      sig: await s.signTypedData(domain, COUNCIL_TYPES, report),
    })),
  );
  entries.sort((a, b) =>
    a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
  );
  return entries.map((e) => e.sig);
}

export async function submitCouncilReport(policy, report, signers) {
  const { chainId } = await policy.runner.provider.getNetwork();
  const sigs = await signCouncilReport(
    councilDomain(chainId, policy.target),
    report,
    signers,
  );
  return policy.submit(report, sigs);
}
```

- [ ] **Step 2: Write the failing tests**

`tests/council.test.mjs`:

```js
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { BrowserProvider, Wallet, ZeroHash } from "ethers";
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
    await assert.rejects(deploy(args({ maxAge: 14 * 86400 + 1 })), /BAD_LIMITS/);
    await assert.rejects(deploy(args({ change: 0 })), /BAD_LIMITS/);
    await assert.rejects(deploy(args({ change: 10000 })), /BAD_LIMITS/);
    await assert.rejects(deploy(args({ interval: 7 * 86400 + 1 })), /BAD_LIMITS/);
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
    await assert.rejects(submit(await report(100, { roundId: 2 })), /ROUND_GAP/);
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
    await assert.rejects(submit(r, reporters.slice(0, 1)), /NOT_ENOUGH_SIGNATURES/);
    await assert.rejects(
      submit(r, [reporters[0], Wallet.createRandom().connect(provider)]),
      /BAD_SIGNER/,
    );
    const { chainId } = await provider.getNetwork();
    const domain = councilDomain(chainId, oracle.target);
    const [one] = await signCouncilReport(domain, r, [reporters[0]]);
    await assert.rejects(oracle.submit(r, [one, one]), /BAD_SIGNER/);
    const sorted = await signCouncilReport(domain, r, reporters.slice(0, 2));
    await assert.rejects(oracle.submit(r, [sorted[1], sorted[0]]), /BAD_SIGNER/);
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run compile && node --test --test-concurrency=1 tests/council.test.mjs`
Expected: FAIL — `ENOENT … artifacts/CouncilPricePolicy.json`.

- [ ] **Step 4: Write the contract**

`contracts/CouncilPricePolicy.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IPricePolicy} from "./IPricePolicy.sol";

/// Threshold-signed relay of the Mobick council price. Reporter set and limits are immutable:
/// replacing them means deploying a new policy and a new lending market.
/// Verifies signatures, freshness and a bounded change per report; it cannot prove the
/// reporters copied the council's number faithfully.
contract CouncilPricePolicy is IPricePolicy, EIP712 {
    struct Report {
        bytes32 policyId;
        uint64 roundId;
        uint256 price;
        uint64 confirmedAt;
        uint64 validUntil;
    }

    bytes32 public constant REPORT_TYPEHASH =
        keccak256("Report(bytes32 policyId,uint64 roundId,uint256 price,uint64 confirmedAt,uint64 validUntil)");
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_PRICE = 1e30;

    bytes32 public immutable policyId;
    uint256 public immutable threshold;
    uint256 public immutable maxAge;
    uint256 public immutable maxChangeBps;
    uint256 public immutable minInterval;
    address[] private reporterList;
    mapping(address => bool) public isReporter;

    uint256 public previous;
    uint256 public current;
    uint64 public confirmedAt;
    uint64 public validUntil;
    uint64 public changedAt;
    uint64 public lastRoundId;

    event ReportAccepted(uint64 indexed roundId, uint256 price, uint64 confirmedAt, uint64 validUntil, uint256 signerCount);

    constructor(
        address[] memory reporters_,
        uint256 threshold_,
        bytes32 policyId_,
        uint256 maxAge_,
        uint256 maxChangeBps_,
        uint256 minInterval_
    ) EIP712("WBMB Council Price", "1") {
        require(reporters_.length >= 1 && reporters_.length <= 16, "BAD_REPORTERS");
        require(threshold_ >= 1 && threshold_ <= reporters_.length, "BAD_THRESHOLD");
        require(policyId_ != bytes32(0), "BAD_POLICY");
        require(
            maxAge_ >= 1 hours && maxAge_ <= 14 days && maxChangeBps_ >= 1 && maxChangeBps_ < BPS && minInterval_ <= 7 days,
            "BAD_LIMITS"
        );
        for (uint256 i; i < reporters_.length; i++) {
            address r = reporters_[i];
            require(r != address(0) && !isReporter[r], "BAD_REPORTERS");
            isReporter[r] = true;
            reporterList.push(r);
        }
        threshold = threshold_; policyId = policyId_; maxAge = maxAge_;
        maxChangeBps = maxChangeBps_; minInterval = minInterval_;
    }

    function reporters() external view returns (address[] memory) { return reporterList; }

    function hashReport(Report calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REPORT_TYPEHASH, r.policyId, r.roundId, r.price, r.confirmedAt, r.validUntil)));
    }

    /// Anyone may submit; only the reporters' signatures matter. Signatures must be sorted by signer address.
    function submit(Report calldata r, bytes[] calldata sigs) external {
        require(r.policyId == policyId, "BAD_POLICY");
        // Sequential rounds: one mistyped huge roundId must not freeze this immutable policy.
        require(r.roundId == uint256(lastRoundId) + 1, "ROUND_GAP");
        require(
            r.validUntil > block.timestamp && r.validUntil <= block.timestamp + maxAge
                && r.confirmedAt <= block.timestamp && r.confirmedAt >= confirmedAt,
            "BAD_VALIDITY"
        );
        require(r.price > 0 && r.price <= MAX_PRICE, "BAD_PRICE");
        require(sigs.length >= threshold, "NOT_ENOUGH_SIGNATURES");
        bytes32 digest = hashReport(r);
        address last;
        for (uint256 i; i < sigs.length; i++) {
            address signer = ECDSA.recover(digest, sigs[i]);
            require(signer > last && isReporter[signer], "BAD_SIGNER");
            last = signer;
        }
        if (lastRoundId == 0) {
            previous = r.price; changedAt = uint64(block.timestamp);
        } else if (r.price != current) {
            // A leaked key can still walk the price, but only this far per step and this often.
            uint256 diff = r.price > current ? r.price - current : current - r.price;
            require(diff * BPS <= current * maxChangeBps, "PRICE_JUMP");
            require(block.timestamp >= uint256(changedAt) + minInterval, "TOO_SOON");
            previous = current; changedAt = uint64(block.timestamp);
        }
        current = r.price; confirmedAt = r.confirmedAt; validUntil = r.validUntil; lastRoundId = r.roundId;
        emit ReportAccepted(r.roundId, r.price, r.confirmedAt, r.validUntil, sigs.length);
    }

    /// Opening price stays at the lower of the last two prices for minInterval after a change,
    /// so a fresh rise cannot be borrowed against immediately.
    function prices() external view returns (uint256, uint256) {
        require(validUntil != 0 && block.timestamp <= validUntil, "STALE_PRICE");
        bool held = block.timestamp < uint256(changedAt) + minInterval;
        return (held && previous < current ? previous : current, current);
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run compile && node --test --test-concurrency=1 tests/council.test.mjs`
Expected: 10 pass, 0 fail. The compile output lists `CouncilPricePolicy: <N> runtime bytes` with N < 24576.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/council-signing.mjs tests/council.test.mjs
git add contracts/CouncilPricePolicy.sol src/council-signing.mjs tests/council.test.mjs
git commit -m "feat: council price policy with bounded, threshold-signed reports"
```

---

### Task 2: P2PLending — liquidation bonus, stale-price escape, grace floor

**Files:**
- Modify: `contracts/P2PLending.sol` (constructor ~95-104, `createOffer` ~117-121, `quoteSettlement` ~253-269)
- Modify: `scripts/deploy.mjs` (both `deployContract("P2PLending", …)` calls; add `deployCouncilFixture`)
- Modify: `scripts/deploy-bsc.mjs` (`args` array only — append two zeros)
- Modify: `tests/lending.test.mjs:389,423`, `tests/fixed.test.mjs:100,128,141,322-325,383,427`, `tests/real/real-tokens.test.mjs:112` (constructor arguments only)
- Test: `tests/council-market.test.mjs`

**Interfaces:**
- Consumes: `CouncilPricePolicy`, `submitCouncilReport`, `COUNCIL_POLICY_ID` from Task 1.
- Produces:
  - `P2PLending` constructor with **9** arguments: `(usdt, wbmb, policy, vault, feeBps, minDuration, minGrace, liquidationBonusBps, staleSettleDelay)`; public immutables `liquidationBonusBps()`, `staleSettleDelay()`.
  - `scripts/deploy.mjs` exports `COUNCIL_TERMS` and `deployCouncilFixture(provider, { seed = false } = {})` returning `{ provider, accounts, addresses, admin, borrower, lender, lender2, usdt, wbmb, oracle, lending, feeWallet, terms, reporter, reporterAddress, publishPrice }` where `publishPrice(price: bigint) → Promise<receipt>`.

- [ ] **Step 1: Add the council fixture to `scripts/deploy.mjs`**

Add to the imports at the top:

```js
import {
  COUNCIL_POLICY_ID,
  submitCouncilReport,
} from "../src/council-signing.mjs";
```

Add after `deployFixedFixture`:

```js
export const COUNCIL_TERMS = {
  aprBps: 1200,
  haircutBps: 4000,
  liquidationBps: 8000,
  duration: 30 * 86400,
  grace: 86400,
  mode: 0,
};
export const COUNCIL_REPORTER_INDEX = 4;
export const COUNCIL_MAX_AGE = 6 * 86400;
/// Council-price market with mock tokens. The local policy has no change interval and a wide
/// change limit so the lab can move the price freely; the limits themselves are tested in
/// tests/council.test.mjs.
export async function deployCouncilFixture(provider, { seed = false } = {}) {
  await assertLocal(provider);
  const accounts = await Promise.all(
    [0, 1, 2, 3].map((i) => provider.getSigner(i)),
  );
  const [admin, borrower, lender, lender2] = accounts;
  const addresses = await Promise.all(accounts.map((a) => a.getAddress()));
  const usdt = await deployContract("MockToken", admin, [
    "Demo USDT",
    "dUSDT",
    18,
  ]);
  const wbmb = await deployContract("MockToken", admin, [
    "Demo WBMB",
    "dWBMB",
    8,
  ]);
  const reporter = await provider.getSigner(COUNCIL_REPORTER_INDEX);
  const reporterAddress = await reporter.getAddress();
  const oracle = await deployContract("CouncilPricePolicy", admin, [
    [reporterAddress],
    1,
    COUNCIL_POLICY_ID,
    COUNCIL_MAX_AGE,
    9000,
    0,
  ]);
  const publishPrice = async (price) => {
    const t = Number((await provider.getBlock("latest")).timestamp);
    const report = {
      policyId: COUNCIL_POLICY_ID,
      roundId: Number(await oracle.lastRoundId()) + 1,
      price,
      confirmedAt: t,
      validUntil: t + COUNCIL_MAX_AGE - 60,
    };
    return (
      await submitCouncilReport(oracle.connect(reporter), report, [reporter])
    ).wait();
  };
  await publishPrice(us(100));
  const feeWallet = addresses[0];
  const lending = await deployContract("P2PLending", admin, [
    usdt.target,
    wbmb.target,
    oracle.target,
    feeWallet,
    500,
    3600,
    86400,
    500,
    7 * 86400,
  ]);
  for (const address of addresses) {
    await (await usdt.mint(address, us(10000))).wait();
    await (await wbmb.mint(address, wb(100))).wait();
  }
  if (seed) {
    const block = await provider.getBlock("latest");
    // 30 days, not 7: the browser lab jumps a week forward and the seeded offers must survive it.
    const expires = block.timestamp + 30 * 86400;
    await (await wbmb.connect(borrower).approve(lending.target, wb(10))).wait();
    await (
      await lending
        .connect(borrower)
        .createOffer(0, us(600), wb(10), us(10), expires, COUNCIL_TERMS)
    ).wait();
    await (await usdt.connect(lender).approve(lending.target, us(1000))).wait();
    await (
      await lending
        .connect(lender)
        .createOffer(1, us(1000), 0, us(10), expires, {
          ...COUNCIL_TERMS,
          aprBps: 1000,
          duration: 14 * 86400,
        })
    ).wait();
  }
  return {
    provider,
    accounts,
    addresses,
    admin,
    borrower,
    lender,
    lender2,
    usdt,
    wbmb,
    oracle,
    lending,
    feeWallet,
    terms: COUNCIL_TERMS,
    reporter,
    reporterAddress,
    publishPrice,
  };
}
```

- [ ] **Step 2: Write the failing tests**

`tests/council-market.test.mjs`:

```js
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run compile && node --test --test-concurrency=1 tests/council-market.test.mjs`
Expected: FAIL in `before` — the 9-argument `P2PLending` deploy is rejected (`incorrect number of arguments to constructor`).

- [ ] **Step 4: Change the contract**

In `contracts/P2PLending.sol`:

Below the `minDuration` and `minGrace` immutables add:

```solidity
    /// Extra share of the debt a lender receives in WBMB when a priced loan is settled.
    uint256 public immutable liquidationBonusBps;
    /// How long past maturity + grace a priced loan waits for a price before the lender takes all.
    uint256 public immutable staleSettleDelay;
```

Replace the constructor with:

```solidity
    constructor(
        address usdt_, address wbmb_, address policy_, address vault_, uint256 feeBps_, uint256 minDuration_, uint256 minGrace_,
        uint256 bonusBps_, uint256 staleDelay_
    ) {
        require(usdt_ != wbmb_ && vault_ != address(0) && (policy_ == address(0) || policy_.code.length > 0), "BAD_CONFIG");
        require(IERC20Metadata(usdt_).decimals() == 18 && IERC20Metadata(wbmb_).decimals() == 8, "DECIMALS");
        require(feeBps_ <= 1000, "FEE_TOO_HIGH");
        usdt = IERC20(usdt_); wbmb = IERC20(wbmb_); pricePolicy = IPricePolicy(policy_);
        require(minDuration_ >= 1 minutes && minDuration_ <= 30 days && minGrace_ >= 1 minutes && minGrace_ <= 7 days, "BAD_LIMITS");
        // The stale delay only matters with a price policy; there it must leave time to restart a relay.
        require(bonusBps_ <= 1000 && staleDelay_ <= 30 days && (policy_ == address(0) || staleDelay_ >= 1 minutes), "BAD_LIMITS");
        feeVault = vault_; feeBps = feeBps_; minDuration = minDuration_; minGrace = minGrace_;
        liquidationBonusBps = bonusBps_; staleSettleDelay = staleDelay_;
    }
```

In `createOffer`, replace the `else require(... "BAD_MARGIN");` line with:

```solidity
        else {
            require(t.haircutBps >= 100 && t.haircutBps <= 9000 && t.liquidationBps < BPS && BPS - t.haircutBps < t.liquidationBps, "BAD_MARGIN");
            // Settlement costs the borrower the bonus, so a late payment needs the same minimum grace.
            require(t.grace >= minGrace, "BAD_GRACE");
        }
```

In `quoteSettlement`, replace everything from `(, price) = pricePolicy.prices();` to the end of the function with:

```solidity
        bool ok;
        try pricePolicy.prices() returns (uint256, uint256 p) { price = p; ok = p > 0 && p <= 1e30; } catch {}
        if (!ok) {
            // A dead price relay must not lock an overdue loan forever.
            require(block.timestamp >= uint256(l.maturity) + l.terms.grace + staleSettleDelay, "STALE_PRICE");
            return (l.collateral, 0, debt, 0);
        }
        uint256 threshold = Math.mulDiv(Math.mulDiv(l.collateral, price, WBMB_UNIT), l.terms.liquidationBps, BPS);
        require(overdue || debt >= threshold, "HEALTHY");
        toLender = Math.min(l.collateral, Math.mulDiv(debt * (BPS + liquidationBonusBps), WBMB_UNIT, price * BPS, Math.Rounding.Ceil));
        toBorrower = l.collateral - toLender;
    }
```

- [ ] **Step 5: Update every existing deploy site (arguments only)**

Append two arguments to each existing `P2PLending` deployment:

| Site | Append |
|---|---|
| `scripts/deploy.mjs` `deployFixture` (priced, SignedPricePolicy) | `0, 7 * 86400` |
| `scripts/deploy.mjs` `deployFixedFixture` | `0, 0` |
| `scripts/deploy-bsc.mjs` `args` array | `0, 0` |
| `tests/lending.test.mjs:389,423` | `0, 7 * 86400` |
| `tests/fixed.test.mjs:100,128,141,383,427` and the `args(...)` helper used at 322-325 | `0, 0` |
| `tests/real/real-tokens.test.mjs:112` | `0, 0` |

Bonus 0 keeps every existing expected amount unchanged. Do not change any assertion. Two priced tests in `tests/lending.test.mjs` post offers with `grace: 600` and will now revert with `BAD_GRACE`: `maturity-only mode ignores price drops and transfers ALL collateral only after grace` (~line 295) and `price mode can settle a healthy overdue loan with surplus returned` (~line 307). In each, set `grace: 86400` and add `86400` to the time advance (7201 → 7201 + 86400, 4300 → 4300 + 86400). Change nothing else in them.

- [ ] **Step 6: Run the whole contract suite**

Run: `npm test`
Expected: all previous tests pass (51 + 10 from Task 1) plus 10 new in `council-market.test.mjs`; `P2PLending: <N> runtime bytes` with N < 24576.

Run: `npm run test:real`
Expected: 18 pass (needs network access to read BSC token code; if the public RPC is unreachable, report that instead of editing the tests).

- [ ] **Step 7: Commit**

```bash
npx prettier --write scripts/deploy.mjs scripts/deploy-bsc.mjs tests/council-market.test.mjs tests/lending.test.mjs tests/fixed.test.mjs tests/real/real-tokens.test.mjs
git add contracts/P2PLending.sol scripts/deploy.mjs scripts/deploy-bsc.mjs tests/
git commit -m "feat: liquidation bonus, stale-price escape and grace floor for priced markets"
```

---

### Task 3: Council price relay

**Files:**
- Create: `src/council-relay.mjs`
- Create: `scripts/relay-council.mjs`
- Modify: `scripts/deploy-bsc.mjs` (export `isMnemonic` and `secretLine`: add `export` to both `const` declarations)
- Modify: `package.json` (script `"relay:council": "node scripts/relay-council.mjs"`)
- Test: `tests/relay.test.mjs`

**Interfaces:**
- Consumes: `CouncilPricePolicy` views and `submit` (Task 1), `submitCouncilReport`, `COUNCIL_POLICY_ID` (Task 1), `loadDeployer(secret, provider, index)` from `scripts/deploy-bsc.mjs`.
- Produces:
  - `src/council-relay.mjs`: `COUNCIL_API_URL`, `parseCouncilPrice(json) → { price: bigint, confirmedAt: number }`, `planRelay({ api, chain, now, policyId }) → { action: "submit" | "wait" | "none", reason: string, report? }`. `chain` is `{ lastRoundId, current, confirmedAt, validUntil, changedAt, maxAge, maxChangeBps, minInterval }` with `current` a bigint and the rest numbers.
  - `scripts/relay-council.mjs`: `relayCouncil({ rpcUrl, chainId = 56, policy, apiUrl, secret, index = 0, expectAddress, broadcast = false, fetchImpl = fetch, log = console.log }) → Promise<{ action, reason, broadcast, txHash? }>`.

- [ ] **Step 1: Write the failing tests**

`tests/relay.test.mjs`:

```js
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { artifact, deployContract, us } from "../scripts/deploy.mjs";
import { COUNCIL_POLICY_ID } from "../src/council-signing.mjs";
import { parseCouncilPrice, planRelay } from "../src/council-relay.mjs";
import { relayCouncil } from "../scripts/relay-council.mjs";

const API = {
  price: 112.3,
  date: "2026-09-30",
  confirmedAt: "2026-09-30T03:00:50.263Z",
};
const CONFIRMED = Math.floor(Date.parse(API.confirmedAt) / 1000);

describe("parseCouncilPrice", () => {
  it("converts the API answer to 18-decimal units and seconds", () => {
    assert.deepEqual(parseCouncilPrice(API), {
      price: us("112.3"),
      confirmedAt: CONFIRMED,
    });
  });
  it("rejects anything that is not a plain positive decimal with a valid time", () => {
    for (const bad of [
      null,
      {},
      { ...API, price: 0 },
      { ...API, price: -1 },
      { ...API, price: "112.3" },
      { ...API, price: 1e-7 },
      { ...API, price: 1e31 },
      { ...API, price: NaN },
      { ...API, confirmedAt: "soon" },
      { ...API, confirmedAt: undefined },
    ])
      assert.throws(() => parseCouncilPrice(bad), /카운슬 가격/);
  });
});

describe("planRelay", () => {
  const MAX_AGE = 6 * 86400;
  const now = CONFIRMED + 3600;
  const chain = (over = {}) => ({
    lastRoundId: 3,
    current: us("112.3"),
    confirmedAt: CONFIRMED,
    validUntil: now + MAX_AGE - 600,
    changedAt: now - 86400,
    maxAge: MAX_AGE,
    maxChangeBps: 3000,
    minInterval: 43200,
    ...over,
  });
  const api = (price = "112.3", confirmedAt = CONFIRMED) => ({
    price: us(price),
    confirmedAt,
  });
  const plan = (a, c) =>
    planRelay({ api: a, chain: c, now, policyId: COUNCIL_POLICY_ID });

  it("submits round 1 when the policy is empty", () => {
    const p = plan(
      api(),
      chain({ lastRoundId: 0, current: 0n, confirmedAt: 0, validUntil: 0 }),
    );
    assert.equal(p.action, "submit");
    assert.deepEqual(p.report, {
      policyId: COUNCIL_POLICY_ID,
      roundId: 1,
      price: us("112.3"),
      confirmedAt: CONFIRMED,
      validUntil: now + MAX_AGE - 600,
    });
  });
  it("does nothing when the price is unchanged and far from expiry", () => {
    assert.equal(plan(api(), chain()).action, "none");
  });
  it("refreshes the same price when less than a third of maxAge remains", () => {
    const p = plan(api(), chain({ validUntil: now + MAX_AGE / 3 - 1 }));
    assert.equal(p.action, "submit");
    assert.equal(p.report.price, us("112.3"));
    assert.equal(p.report.roundId, 4);
  });
  it("submits a changed price once minInterval has passed", () => {
    const p = plan(api("118", CONFIRMED + 60), chain());
    assert.equal(p.action, "submit");
    assert.equal(p.report.price, us("118"));
    assert.equal(p.report.confirmedAt, CONFIRMED + 60);
  });
  it("waits when a change comes too soon, but still refreshes an expiring price", () => {
    const soon = { changedAt: now - 60 };
    assert.equal(plan(api("118"), chain(soon)).action, "wait");
    const p = plan(
      api("118"),
      chain({ ...soon, validUntil: now + 3600 }),
    );
    assert.equal(p.action, "submit");
    assert.equal(p.report.price, us("112.3"));
    assert.equal(p.report.confirmedAt, CONFIRMED);
  });
  it("refuses a change beyond the on-chain limit", () => {
    assert.throws(() => plan(api("146"), chain()), /한도/);
    assert.throws(() => plan(api("78.6"), chain()), /한도/);
  });
  it("refuses a confirmation time in the future or older than the chain's", () => {
    assert.throws(() => plan(api("112.3", now + 10), chain()), /확정 시각/);
    assert.throws(() => plan(api("118", CONFIRMED - 10), chain()), /확정 시각/);
  });
});

describe("relayCouncil against a local chain", () => {
  const url = "http://127.0.0.1:18561";
  let server, local, admin, oracle;
  const reporter = Wallet.createRandom();
  const fetchOk = (body) => async () => ({ ok: true, json: async () => body });
  const run = (over = {}) =>
    relayCouncil({
      rpcUrl: url,
      chainId: 31337,
      policy: oracle.target,
      secret: reporter.privateKey,
      fetchImpl: fetchOk({ ...API, confirmedAt: "2026-01-01T00:00:00.000Z" }),
      log: () => {},
      ...over,
    });

  before(async () => {
    server = await network.createServer(undefined, "127.0.0.1", 18561);
    await server.listen();
    local = new JsonRpcProvider(url, 31337, {
      staticNetwork: true,
      cacheTimeout: -1,
    });
    admin = await local.getSigner(0);
    oracle = await deployContract("CouncilPricePolicy", admin, [
      [reporter.address],
      1,
      COUNCIL_POLICY_ID,
      6 * 86400,
      3000,
      43200,
    ]);
    await local.send("hardhat_setBalance", [
      reporter.address,
      "0x16345785D8A0000",
    ]);
  });
  after(async () => {
    local?.destroy();
    await server?.close();
  });

  it("a dry run reports the plan and sends nothing", async () => {
    const r = await run();
    assert.equal(r.action, "submit");
    assert.equal(r.broadcast, false);
    assert.equal(await local.getTransactionCount(reporter.address), 0);
    assert.equal(await oracle.lastRoundId(), 0n);
  });
  it("sends nothing on a bad API answer or HTTP error", async () => {
    await assert.rejects(
      run({ broadcast: true, fetchImpl: fetchOk({ price: "x" }) }),
      /카운슬 가격/,
    );
    await assert.rejects(
      run({ broadcast: true, fetchImpl: async () => ({ ok: false, status: 503 }) }),
      /503/,
    );
    assert.equal(await local.getTransactionCount(reporter.address), 0);
  });
  it("refuses a key that is not a reporter", async () => {
    await assert.rejects(
      run({ broadcast: true, secret: Wallet.createRandom().privateKey }),
      /보고자/,
    );
  });
  it("refuses a mnemonic without an expected address and a mismatched one", async () => {
    const phrase = Wallet.createRandom().mnemonic.phrase;
    await assert.rejects(run({ secret: phrase }), /RELAY_EXPECT/);
    await assert.rejects(
      run({ expectAddress: Wallet.createRandom().address }),
      /예상 주소/,
    );
  });
  it("broadcast publishes round 1, then has nothing more to do", async () => {
    const r = await run({ broadcast: true });
    assert.equal(r.broadcast, true);
    assert.match(r.txHash, /^0x[0-9a-f]{64}$/);
    assert.equal(await oracle.lastRoundId(), 1n);
    assert.equal(await oracle.current(), us("112.3"));
    const again = await run({ broadcast: true });
    assert.equal(again.action, "none");
    assert.equal(await oracle.lastRoundId(), 1n);
  });
  it("never prints the key", async () => {
    const lines = [];
    await run({ log: (l) => lines.push(String(l)) });
    assert.ok(lines.length > 0);
    assert.ok(!lines.join("\n").includes(reporter.privateKey.slice(2)));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run compile && node --test --test-concurrency=1 tests/relay.test.mjs`
Expected: FAIL — `Cannot find module … src/council-relay.mjs`.

- [ ] **Step 3: Write the pure relay logic**

`src/council-relay.mjs`:

```js
// Decides what the council price relay should publish. Pure: no network, no clock.
import { parseUnits } from "ethers";

export const COUNCIL_API_URL = "https://movnvote.com/api/public/price/latest";
// Margin between the local decision and the block that carries it.
const VALIDITY_MARGIN = 600;

/// `json` is the API answer: { price: 112.3, date, confirmedAt: ISO string }.
export function parseCouncilPrice(json) {
  const fail = () => new Error("카운슬 가격 응답을 해석할 수 없습니다.");
  const text = typeof json?.price === "number" ? String(json.price) : "";
  // Plain decimals only: exponent forms and strings are refused rather than guessed.
  if (!/^\d{1,12}(\.\d{1,18})?$/.test(text)) throw fail();
  const price = parseUnits(text, 18);
  const ms = typeof json.confirmedAt === "string" ? Date.parse(json.confirmedAt) : NaN;
  if (price <= 0n || !Number.isFinite(ms) || ms <= 0) throw fail();
  return { price, confirmedAt: Math.floor(ms / 1000) };
}

export function planRelay({ api, chain, now, policyId }) {
  const submit = (price, confirmedAt, reason) => ({
    action: "submit",
    reason,
    report: {
      policyId,
      roundId: chain.lastRoundId + 1,
      price,
      confirmedAt,
      validUntil: now + chain.maxAge - VALIDITY_MARGIN,
    },
  });
  if (api.confirmedAt > now)
    throw new Error("카운슬 확정 시각이 미래입니다. 보내지 않았습니다.");
  if (chain.lastRoundId === 0)
    return submit(api.price, api.confirmedAt, "첫 가격 등록");
  const changed = api.price !== chain.current;
  const expiring = chain.validUntil - now < Math.floor(chain.maxAge / 3);
  if (changed) {
    if (api.confirmedAt < chain.confirmedAt)
      throw new Error(
        "카운슬 확정 시각이 체인에 올라간 값보다 과거입니다. 보내지 않았습니다.",
      );
    const diff =
      api.price > chain.current
        ? api.price - chain.current
        : chain.current - api.price;
    if (diff * 10000n > chain.current * BigInt(chain.maxChangeBps))
      throw new Error(
        "가격 변동이 컨트랙트 한도를 넘습니다. 사람이 확인해야 합니다. 보내지 않았습니다.",
      );
    if (now >= chain.changedAt + chain.minInterval)
      return submit(api.price, api.confirmedAt, "가격 변경");
    if (!expiring)
      return { action: "wait", reason: "가격이 바뀌었지만 최소 간격이 지나지 않았습니다." };
  }
  if (expiring)
    return submit(chain.current, chain.confirmedAt, "유효기한 연장");
  return { action: "none", reason: "변경 없음" };
}
```

- [ ] **Step 4: Write the relay script**

First add `export` to `isMnemonic` and `secretLine` in `scripts/deploy-bsc.mjs`.

`scripts/relay-council.mjs`:

```js
// Copies the Mobick council price to the CouncilPricePolicy contract. Run it on a timer;
// each run checks once and exits.
//
//   Dry run (sends nothing):   RELAY_KEY_FILE=/path/key npm run relay:council
//   Real submission:           RELAY_KEY_FILE=/path/key npm run relay:council -- --broadcast
//   Test market:               add --test-market
//
// For a mnemonic, RELAY_INDEX picks the wallet and RELAY_EXPECT must be that wallet's address.
// The key is read at run time, never printed, never written anywhere.
import fs from "node:fs";
import {
  Contract,
  JsonRpcProvider,
  formatUnits,
  getAddress,
  isAddress,
} from "ethers";
import { BSC } from "../config/bsc.mjs";
import { artifact } from "./deploy.mjs";
import { isMnemonic, loadDeployer, secretLine } from "./deploy-bsc.mjs";
import { submitCouncilReport } from "../src/council-signing.mjs";
import {
  COUNCIL_API_URL,
  parseCouncilPrice,
  planRelay,
} from "../src/council-relay.mjs";

export async function relayCouncil({
  rpcUrl = BSC.rpcUrl,
  chainId = BSC.chainId,
  policy,
  apiUrl = COUNCIL_API_URL,
  secret,
  index = 0,
  expectAddress,
  broadcast = false,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const provider = new JsonRpcProvider(rpcUrl, chainId, {
    staticNetwork: true,
  });
  try {
    if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(chainId))
      throw new Error("RPC의 체인 ID가 예상과 다릅니다.");
    if (!isAddress(policy) || (await provider.getCode(policy)) === "0x")
      throw new Error("가격 컨트랙트 주소가 올바르지 않습니다.");
    const signer = loadDeployer(secret, provider, index);
    if (!signer) throw new Error("RELAY_KEY_FILE 이 필요합니다.");
    if (isMnemonic(secretLine(secret)) && !expectAddress)
      throw new Error(
        "니모닉을 쓸 때는 RELAY_EXPECT 에 사용할 지갑 주소를 반드시 지정해야 합니다.",
      );
    const from = await signer.getAddress();
    if (
      expectAddress &&
      (!isAddress(expectAddress) || getAddress(expectAddress) !== from)
    )
      throw new Error(
        "서명 지갑이 예상 주소와 다릅니다. RELAY_INDEX 와 RELAY_EXPECT 를 확인하세요. 아무것도 전송하지 않았습니다.",
      );
    const oracle = new Contract(
      policy,
      artifact("CouncilPricePolicy").abi,
      signer,
    );
    if (!(await oracle.isReporter(from)))
      throw new Error("이 지갑은 가격 컨트랙트의 보고자가 아닙니다: " + from);
    const response = await fetchImpl(apiUrl, { cache: "no-store" });
    if (!response.ok)
      throw new Error(`카운슬 가격 API 응답 오류 (HTTP ${response.status})`);
    const api = parseCouncilPrice(await response.json());
    const [
      block,
      policyId,
      lastRoundId,
      current,
      confirmedAt,
      validUntil,
      changedAt,
      maxAge,
      maxChangeBps,
      minInterval,
    ] = await Promise.all([
      provider.getBlock("latest"),
      oracle.policyId(),
      oracle.lastRoundId(),
      oracle.current(),
      oracle.confirmedAt(),
      oracle.validUntil(),
      oracle.changedAt(),
      oracle.maxAge(),
      oracle.maxChangeBps(),
      oracle.minInterval(),
    ]);
    const plan = planRelay({
      api,
      policyId,
      now: block.timestamp,
      chain: {
        lastRoundId: Number(lastRoundId),
        current,
        confirmedAt: Number(confirmedAt),
        validUntil: Number(validUntil),
        changedAt: Number(changedAt),
        maxAge: Number(maxAge),
        maxChangeBps: Number(maxChangeBps),
        minInterval: Number(minInterval),
      },
    });
    log(
      `카운슬 ${formatUnits(api.price, 18)} · 체인 ${formatUnits(current, 18)} · ${plan.reason}`,
    );
    if (plan.action !== "submit")
      return { action: plan.action, reason: plan.reason, broadcast: false };
    log(
      `보고서   round ${plan.report.roundId} · 가격 ${formatUnits(plan.report.price, 18)} · 유효 ${new Date(plan.report.validUntil * 1000).toISOString()}`,
    );
    if (!broadcast) {
      log("--broadcast 가 없어 전송하지 않았습니다.");
      return { action: "submit", reason: plan.reason, broadcast: false };
    }
    const tx = await submitCouncilReport(oracle, plan.report, [signer]);
    log(`전송됨   ${tx.hash}`);
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error("가격 보고 거래가 실패했습니다.");
    return {
      action: "submit",
      reason: plan.reason,
      broadcast: true,
      txHash: tx.hash,
    };
  } finally {
    provider.destroy();
  }
}

if (process.argv[1]?.endsWith("relay-council.mjs")) {
  const recordFile = process.argv.includes("--test-market")
    ? "deployments/bsc-council-test.json"
    : "deployments/bsc-council.json";
  const file = process.env.RELAY_KEY_FILE;
  Promise.resolve()
    .then(() => {
      if (!fs.existsSync(recordFile))
        throw new Error(`배포 기록이 없습니다: ${recordFile}`);
      const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
      return relayCouncil({
        rpcUrl: process.env.BSC_RPC_URL || BSC.rpcUrl,
        policy: record.pricePolicy,
        secret: file ? fs.readFileSync(file, "utf8") : undefined,
        index: Number(process.env.RELAY_INDEX || 0),
        expectAddress: process.env.RELAY_EXPECT,
        broadcast: process.argv.includes("--broadcast"),
      });
    })
    .catch((e) => {
      console.error("실패:", e.shortMessage || e.message);
      process.exit(1);
    });
}
```

Add to `package.json` scripts: `"relay:council": "node scripts/relay-council.mjs"`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run compile && node --test --test-concurrency=1 tests/relay.test.mjs`
Expected: 15 pass, 0 fail.

Run: `npm run relay:council`
Expected: exits 1 with `실패: 배포 기록이 없습니다: deployments/bsc-council.json`. Nothing is sent.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/council-relay.mjs scripts/relay-council.mjs scripts/deploy-bsc.mjs tests/relay.test.mjs package.json
git add src/council-relay.mjs scripts/relay-council.mjs scripts/deploy-bsc.mjs tests/relay.test.mjs package.json
git commit -m "feat: one-shot relay that publishes the council price on-chain"
```

---

### Task 4: Deploy script profiles for the council market

**Files:**
- Modify: `config/bsc.mjs`
- Modify: `scripts/deploy-bsc.mjs` (`PROFILES`, `deployBsc`, `liveWebConfig`, CLI block)
- Test: `tests/real/deploy-rehearsal.test.mjs` (append tests)

**Interfaces:**
- Consumes: `CouncilPricePolicy` constructor (Task 1), 9-argument `P2PLending` constructor (Task 2), `COUNCIL_POLICY_ID` (Task 1).
- Produces:
  - `PROFILES.council` → record file `bsc-council.json`; `PROFILES["council-test"]` → `bsc-council-test.json`.
  - `deployBsc({ profile, reporter, … })`: for council profiles `reporter` (address) is required; the returned/recorded object gains `pricePolicy` (address), `policyTxHash`, `liquidationBonusBps`, `staleSettleDelay`, `council: { reporter, policyId, maxAge, maxChangeBps, minInterval }`, `policyConstructorArgs`.
  - `liveWebConfig(record)` returns `{ version: 3, demo: false, policy: "council", chainId, rpcUrl, deployedAt, feeWallet, feeBps, liquidationBonusBps, addresses: { usdt, wbmb, lending, oracle } }` when `record.pricePolicy` is not the zero address; unchanged otherwise.
  - CLI flags: `--council` (main council market), `--council --test-market` (council test market); env `REPORTER=0x…`.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe` in `tests/real/deploy-rehearsal.test.mjs` (it already defines `url`, `local`, `outDir`, `wallet`, `log`; `wallet` was funded by the earlier broadcast test):

```js
  it("council profile needs a reporter address", async () => {
    await assert.rejects(
      deployBsc({ rpcUrl: url, profile: "council", log }),
      /REPORTER/,
    );
    await assert.rejects(
      deployBsc({ rpcUrl: url, profile: "council", reporter: BSC.usdt, log }),
      /REPORTER/,
    );
  });

  it("council dry run estimates both deployments and sends nothing", async () => {
    const before = await local.getTransactionCount(wallet.address);
    const r = await deployBsc({
      rpcUrl: url,
      profile: "council",
      reporter: wallet.address,
      secret: wallet.privateKey,
      outDir,
      log,
    });
    assert.equal(r.broadcast, false);
    assert.ok(r.gas > 3_000_000n);
    assert.equal(await local.getTransactionCount(wallet.address), before);
    assert.equal(fs.existsSync(path.join(outDir, "bsc-council.json")), false);
  });

  it("council broadcast deploys the policy and the market and records both", async () => {
    const reporter = Wallet.createRandom().address;
    const r = await deployBsc({
      rpcUrl: url,
      profile: "council-test",
      reporter,
      secret: wallet.privateKey,
      broadcast: true,
      outDir,
      confirmations: 1,
      log,
    });
    const record = JSON.parse(
      fs.readFileSync(path.join(outDir, "bsc-council-test.json"), "utf8"),
    );
    assert.equal(record.lending, r.lending);
    assert.notEqual(record.pricePolicy, ZeroAddress);
    assert.equal(record.liquidationBonusBps, 500);
    assert.equal(record.staleSettleDelay, 300);
    assert.equal(record.council.reporter, reporter);
    assert.equal(record.council.minInterval, 300);
    const lending = new Contract(
      record.lending,
      artifact("P2PLending").abi,
      local,
    );
    assert.equal(await lending.pricePolicy(), record.pricePolicy);
    assert.equal(await lending.oracleFree(), false);
    assert.equal(await lending.liquidationBonusBps(), 500n);
    assert.equal(await lending.minGrace(), 300n);
    const policy = new Contract(
      record.pricePolicy,
      artifact("CouncilPricePolicy").abi,
      local,
    );
    assert.equal(await policy.isReporter(reporter), true);
    assert.equal(await policy.threshold(), 1n);
    assert.equal(await policy.maxAge(), BigInt(6 * 86400));
    assert.equal(await policy.maxChangeBps(), 3000n);
    const web = liveWebConfig(record);
    assert.equal(web.policy, "council");
    assert.equal(web.oracleFree, undefined);
    assert.equal(web.addresses.oracle, record.pricePolicy);
    assert.equal(web.liquidationBonusBps, 500);
    // The oracle-free record written earlier in this file is untouched.
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(outDir, "bsc.json"), "utf8"))
        .pricePolicy,
      ZeroAddress,
    );
  });

  it("council broadcast refuses to overwrite its record", async () => {
    await assert.rejects(
      deployBsc({
        rpcUrl: url,
        profile: "council-test",
        reporter: wallet.address,
        secret: wallet.privateKey,
        broadcast: true,
        outDir,
        confirmations: 1,
        log,
      }),
      /이미 배포 기록이 있습니다/,
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run compile && node --test tests/real/deploy-rehearsal.test.mjs`
Expected: the 4 new tests FAIL with `알 수 없는 profile 입니다`.

- [ ] **Step 3: Add the council settings**

In `config/bsc.mjs`, add inside `BSC`:

```js
  // Council-price market. Fixed at deployment; changing any of these means a new market.
  council: {
    maxAge: 6 * 86400, // the council has gone 4 days between updates
    maxChangeBps: 3000, // largest single council move seen: +18.5%
    minInterval: 43200,
    liquidationBonusBps: 500,
    staleSettleDelay: 7 * 86400,
  },
```

- [ ] **Step 4: Extend `scripts/deploy-bsc.mjs`**

Add the import: `import { COUNCIL_POLICY_ID } from "../src/council-signing.mjs";`

Replace `PROFILES` with:

```js
// "main" is the oracle-free market for real use. "test" differs only in short minimums, so a
// full default-and-settle cycle can be checked in minutes. The council profiles add a price
// policy fed by the council price relay.
export const PROFILES = {
  main: { file: "bsc.json", minDuration: 3600, minGrace: 86400 },
  test: { file: "bsc-test.json", minDuration: 300, minGrace: 300 },
  council: {
    file: "bsc-council.json",
    minDuration: 3600,
    minGrace: 86400,
    council: BSC.council,
  },
  "council-test": {
    file: "bsc-council-test.json",
    minDuration: 300,
    minGrace: 300,
    council: { ...BSC.council, minInterval: 300, staleSettleDelay: 300 },
  },
};
```

Add `reporter,` to the `deployBsc` parameter list. Change the unknown-profile message to `"알 수 없는 profile 입니다."`.

After `const limits = PROFILES[profile];` add:

```js
    const cp = limits.council;
    if (
      cp &&
      (!isAddress(reporter) ||
        [BSC.usdt, BSC.wbmb, ZeroAddress].includes(getAddress(reporter)))
    )
      throw new Error(
        "REPORTER 에 가격 중계 지갑 주소를 지정해야 합니다. 직접 관리하는 지갑이어야 합니다.",
      );
    const policyArgs = cp && [
      [getAddress(reporter)],
      1,
      COUNCIL_POLICY_ID,
      cp.maxAge,
      cp.maxChangeBps,
      cp.minInterval,
    ];
    const policyArtifact = cp && artifact("CouncilPricePolicy");
    const policyFactory =
      cp &&
      new ContractFactory(
        policyArtifact.abi,
        policyArtifact.bytecode,
        deployer || provider,
      );
```

Replace the `args` array with a function, because the policy address is only known after the first deployment:

```js
    // Before the policy exists, a token address stands in so gas can still be estimated.
    const lendingArgs = (policyAddress) => [
      BSC.usdt,
      BSC.wbmb,
      cp ? policyAddress : ZeroAddress,
      fee || "0x000000000000000000000000000000000000dEaD",
      BSC.feeBps,
      limits.minDuration,
      limits.minGrace,
      cp ? cp.liquidationBonusBps : 0,
      cp ? cp.staleSettleDelay : 0,
    ];
    let args = lendingArgs(BSC.usdt);
```

Replace the gas estimate so it covers both contracts:

```js
    const request = await factory.getDeployTransaction(...args);
    const lendingGas = await provider.estimateGas({
      ...request,
      from: from || undefined,
    });
    const policyGas = cp
      ? await provider.estimateGas({
          ...(await policyFactory.getDeployTransaction(...policyArgs)),
          from: from || undefined,
        })
      : 0n;
    const gas = lendingGas + policyGas;
```

After the balance check and before `factory.deploy`, deploy the policy:

```js
    let policyAddress = ZeroAddress,
      policyTxHash = null;
    if (cp) {
      const policy = await policyFactory.deploy(...policyArgs, {
        gasLimit: (policyGas * 12n) / 10n,
        gasPrice,
      });
      policyTxHash = policy.deploymentTransaction().hash;
      log(`가격 컨트랙트 전송됨 ${policyTxHash} · 확정 대기 중…`);
      const policyReceipt = await policy
        .deploymentTransaction()
        .wait(confirmations);
      if (policyReceipt.status !== 1)
        throw new Error("가격 컨트랙트 배포 거래가 실패했습니다.");
      policyAddress = await policy.getAddress();
      // Printed at once: if the next step fails this address is still on record in the log.
      log(`가격 컨트랙트 ${policyAddress} (블록 ${policyReceipt.blockNumber})`);
      const [isRep, threshold, maxAge, maxChange, minInterval] =
        await Promise.all([
          policy.isReporter(getAddress(reporter)),
          policy.threshold(),
          policy.maxAge(),
          policy.maxChangeBps(),
          policy.minInterval(),
        ]);
      if (
        !isRep ||
        threshold !== 1n ||
        maxAge !== BigInt(cp.maxAge) ||
        maxChange !== BigInt(cp.maxChangeBps) ||
        minInterval !== BigInt(cp.minInterval)
      )
        throw new Error(
          "배포된 가격 컨트랙트의 설정이 예상과 다릅니다. 사용하지 마세요: " +
            policyAddress,
        );
      args = lendingArgs(policyAddress);
    }
```

Change the lending deploy to use `lendingGas` for its gas limit (`gasLimit: (lendingGas * 12n) / 10n`).

In the read-back, read `contract.liquidationBonusBps()` and `contract.staleSettleDelay()` too, compare `policy` with `policyAddress` instead of `ZeroAddress`, and compare the two new values with `args[7]` and `args[8]` (as `BigInt`).

In `record`, replace `pricePolicy: ZeroAddress,` with:

```js
      pricePolicy: policyAddress,
      liquidationBonusBps: Number(args[7]),
      staleSettleDelay: Number(args[8]),
      ...(cp
        ? {
            policyTxHash,
            council: {
              reporter: getAddress(reporter),
              policyId: COUNCIL_POLICY_ID,
              maxAge: cp.maxAge,
              maxChangeBps: cp.maxChangeBps,
              minInterval: cp.minInterval,
            },
            policyConstructorArgs: policyArgs.map((a) =>
              Array.isArray(a) ? a.map(String) : String(a),
            ),
          }
        : {}),
```

Replace `liveWebConfig` with:

```js
/// Web config for a live deployment record (what the page fetches as /deployment.json).
export function liveWebConfig(record, rpcUrl = BSC.rpcUrl) {
  const council = record.pricePolicy && record.pricePolicy !== ZeroAddress;
  return {
    version: council ? 3 : 2,
    demo: false,
    ...(council
      ? { policy: "council", liquidationBonusBps: record.liquidationBonusBps }
      : { oracleFree: true }),
    chainId: record.chainId,
    rpcUrl,
    deployedAt: record.deployedAt,
    feeWallet: record.feeWallet,
    feeBps: record.feeBps,
    addresses: {
      usdt: record.usdt,
      wbmb: record.wbmb,
      lending: record.lending,
      ...(council ? { oracle: record.pricePolicy } : {}),
    },
  };
}
```

In the CLI block, pass `reporter: process.env.REPORTER,` and replace the `profile:` line with:

```js
    profile:
      (process.argv.includes("--council") ? "council" : "") +
        (process.argv.includes("--test-market")
          ? process.argv.includes("--council")
            ? "-test"
            : "test"
          : "") || "main",
```

Update the header comment of the file: first line becomes `// Deploys a P2PLending market to BNB Smart Chain mainnet (chain 56): oracle-free by default,` / `// or with the council price policy (--council, needs REPORTER=0x…).`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run compile && node --test tests/real/deploy-rehearsal.test.mjs`
Expected: 22 pass (18 previous + 4 new).

Run: `npm run deploy:bsc -- --council` (no key, no REPORTER)
Expected: exits 1 with the `REPORTER` message. Nothing is sent.

Run: `REPORTER=0x000000000000000000000000000000000000dEaD npm run deploy:bsc -- --council`
Expected: prints token checks, a gas estimate for both contracts, and `키가 없어 예상 비용만 계산했습니다. 아무것도 전송하지 않았습니다.`

- [ ] **Step 6: Commit**

```bash
npx prettier --write config/bsc.mjs scripts/deploy-bsc.mjs tests/real/deploy-rehearsal.test.mjs
git add config/bsc.mjs scripts/deploy-bsc.mjs tests/real/deploy-rehearsal.test.mjs
git commit -m "feat(deploy): council market profiles deploy the price policy and the market"
```

---

### Task 5: Web app — council market in the local demo

**Files:**
- Modify: `scripts/deploy.mjs` (`saveDeployment`)
- Modify: `scripts/dev.mjs` (`MARKET=council`)
- Modify: `index.html` (ids on the two price labels)
- Modify: `src/app.js`
- Create: `playwright.council.config.js`
- Create: `tests/browser-council/app.spec.js`
- Modify: `package.json` (`test:browser`)

**Interfaces:**
- Consumes: `deployCouncilFixture`, `COUNCIL_REPORTER_INDEX`, `COUNCIL_MAX_AGE` (Task 2); `COUNCIL_POLICY_ID`, `submitCouncilReport` (Task 1); `CouncilPricePolicy` ABI in `public/abis.json` (written by `compile`).
- Produces: web config shape for a council market — `{ version: 3, demo, policy: "council", chainId, rpcUrl, feeWallet, feeBps, liquidationBonusBps, addresses: { usdt, wbmb, lending, oracle }, demoAccounts?, oracle?: { contract: "CouncilPricePolicy", reporterIndex, maxAge } }`. In `src/app.js`: `council()` and `vault()` helpers. Task 6 relies on both.

- [ ] **Step 1: Write the failing browser tests**

`playwright.council.config.js`:

```js
import { defineConfig } from "@playwright/test";
// Council-price market UI against a local chain with mock tokens.
export default defineConfig({
  testDir: "./tests/browser-council",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: {
    baseURL: "http://127.0.0.1:5185",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/dev.mjs",
    url: "http://127.0.0.1:5185",
    timeout: 120000,
    reuseExistingServer: false,
    env: { RPC_PORT: "18562", APP_PORT: "5185", MARKET: "council" },
  },
});
```

`tests/browser-council/app.spec.js`:

```js
import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "serial" });
async function ready(page) {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("로컬 체인 준비 완료");
}
async function account(page, n) {
  await page.locator("#demo-account").selectOption(String(n));
  await expect(page.locator("#account-label")).toHaveText(`체험 지갑 ${n}`);
}
async function commit(page, done) {
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-submit").click();
  await expect(page.locator("#status")).toContainText(done);
  await expect(page.locator("#confirm-dialog")).not.toBeVisible();
}
async function setPrice(page, value) {
  await page.locator(".lab summary").click();
  await page.locator("#lab-price").fill(String(value));
  await page.locator("#set-price").click();
  await expect(page.locator("#status")).toContainText("가격을 반영");
  await page.locator(".lab summary").click();
}

test("council market shows the council price, a fee tab and the fixed margins", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  await expect(page.locator("#current-label")).toContainText("카운슬 가격");
  await expect(page.locator("#current-price")).toHaveText("100");
  await expect(page.locator("#price-state")).toContainText("유효");
  await expect(page.locator('[data-tab="burn"]')).toHaveText("수수료");
  await expect(page.locator(".principle-tags")).toContainText(
    "수수료 이자의 5%",
  );
  await page.locator('[data-tab="borrow"]').click();
  await expect(page.locator('[data-offer="2"]')).toContainText("담보 여유");
  await expect(page.locator('[data-offer="2"]')).toContainText("40%");
  expect(errors).toEqual([]);
});

test("borrower takes a lend offer, price falls, top-up rescues, further fall settles with a 5% bonus", async ({
  page,
}) => {
  await ready(page);
  await account(page, 1);
  await page.locator('[data-tab="borrow"]').click();
  await page.locator('[data-fill-amount="2"]').fill("600");
  await page.locator('[data-offer="2"] [data-action="fill"]').click();
  await expect(page.locator("#confirm-body")).toContainText(
    "배정 담보: 10 WBMB",
  );
  await commit(page, "부분 체결 완료");
  await page.locator('[data-tab="mine"]').click();
  // debt 600 / (10 WBMB * 0.8) = 75
  await expect(page.locator('[data-loan="1"]')).toContainText("청산 가격");
  await expect(page.locator('[data-loan="1"]')).toContainText("75");
  await setPrice(page, 74);
  await page.locator('[data-topup-amount="1"]').fill("1");
  await page.locator('[data-loan="1"] [data-action="topup"]').click();
  await commit(page, "담보 추가 완료");
  await page.locator('[data-loan="1"] [data-action="settle"]').click();
  await expect(page.locator("#status")).toContainText(
    "가격 청산 조건에 해당하지 않습니다",
  );
  await setPrice(page, 63);
  await page.locator('[data-loan="1"] [data-action="settle"]').click();
  // 600 * 1.05 / 63 = 10 WBMB to the lender, 1 back to the borrower
  // The seeded offer charges 10% APR, so a few seconds of interest may show in the last digits.
  await expect(page.locator("#confirm-body")).toContainText(
    /대출자 귀속 10(\.0000\d+)? WBMB/,
  );
  await expect(page.locator("#confirm-body")).toContainText(
    /차입자 반환 (1|0\.9999\d+) WBMB/,
  );
  await expect(page.locator("#confirm-body")).toContainText("보너스 5%");
  await commit(page, "WBMB 정산 완료");
  await expect(page.locator(".claim-box")).toContainText(
    /(1|0\.9999\d+) WBMB/,
  );
});

test("an expired council price blocks new fills and says why", async ({
  page,
}) => {
  await ready(page);
  await page.locator(".lab summary").click();
  await page.locator("#advance-week").click();
  await expect(page.locator("#status")).toContainText("7일이 경과");
  await expect(page.locator("#price-state")).toContainText("가격 만료");
  await account(page, 1);
  await page.locator('[data-tab="borrow"]').click();
  await page.locator('[data-offer="2"] [data-action="fill"]').click();
  await expect(page.locator("#status")).toContainText("가격이 만료");
});

test("posting a lend offer uses the council margins and shows no collateral field", async ({
  page,
}) => {
  await ready(page);
  await account(page, 2);
  await page.locator("#open-offer").click();
  await page.locator('#offer-form [name="side"]').selectOption("1");
  await expect(page.locator("#collateral-field")).toBeHidden();
  await expect(page.locator("#terms-note")).toContainText("60%");
  await expect(page.locator("#terms-note")).toContainText("80%");
  await expect(page.locator("#terms-note")).toContainText("5%");
});
```

The ids and messages above are the real ones: `#open-offer` opens `#offer-dialog` holding `#offer-form`; `txAction` reports success as `<title> 완료`; a `HEALTHY` revert is shown as `현재 대출은 가격 청산 조건에 해당하지 않습니다.`

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test -c playwright.council.config.js`
Expected: FAIL — `scripts/dev.mjs` ignores `MARKET=council` and serves the SignedPricePolicy demo, so test 1 fails at `#current-label` / `카운슬 가격` and the others on missing ids (`#advance-week`).

- [ ] **Step 3: Serve the council fixture locally**

In `scripts/dev.mjs`, import `deployCouncilFixture` and replace the fixture selection with:

```js
  // MARKET=fixed runs the oracle-free market, MARKET=council the council-price market.
  const fixture =
    process.env.MARKET === "fixed"
      ? await deployFixedFixture(provider, { seed: true })
      : process.env.MARKET === "council"
        ? await deployCouncilFixture(provider, { seed: true })
        : await deployFixture(provider, { seed: true });
```

In `scripts/deploy.mjs` `saveDeployment`, add this branch at the very top of the function (the council fixture has both `oracle` and `feeWallet`; the signed-price fixture has no `feeWallet`):

```js
  if (f.oracle && f.feeWallet) {
    const council = {
      version: 3,
      demo: true,
      policy: "council",
      chainId: 31337,
      rpcUrl,
      deployedAt: new Date().toISOString(),
      feeWallet: f.feeWallet,
      feeBps: 500,
      liquidationBonusBps: 500,
      addresses: {
        usdt: f.usdt.target,
        wbmb: f.wbmb.target,
        lending: f.lending.target,
        oracle: f.oracle.target,
      },
      demoAccounts: f.addresses.slice(1),
      oracle: {
        contract: "CouncilPricePolicy",
        reporterIndex: COUNCIL_REPORTER_INDEX,
        maxAge: COUNCIL_MAX_AGE,
      },
    };
    fs.writeFileSync(filename, JSON.stringify(council, null, 2) + "\n");
    return;
  }
```

- [ ] **Step 4: Label ids and a one-week button in `index.html`**

Give the two price label `<span>`s ids so the app can rename them:

```html
          <span id="week-label">7일 구간평균 최저가 · 모의</span
          ><strong id="week-price">—</strong><small>USDT / WBMB</small>
```

```html
          <span id="current-label">현재 평가가격 · 모의</span><strong id="current-price">—</strong
```

Next to the existing `#advance-day` button add, in the same markup style, a hidden button:

```html
          <button id="advance-week" class="button outline small" hidden>
            7일 경과 (가격 갱신 없음)</button
          >
```

- [ ] **Step 5: Teach `src/app.js` the council market**

Add to the imports at the top of the file:

```js
import { COUNCIL_POLICY_ID, submitCouncilReport } from "./council-signing.mjs";
```

Below `const fixed = …` add:

```js
// Council-price market: collateral and liquidation follow the relayed Mobick council price.
const council = () => config?.policy === "council";
// Markets whose fees go to a plain fee wallet (no burner contract).
const vault = () => fixed() || council();
let bonusPct = "0";
let priceLive = true;
```

Then make these edits. Each names the existing expression to change.

1. `feeWord`: `fixed()` → `vault()`.
2. `refresh()`, replace `if (!fixed()) { … }` with:

```js
    if (council()) {
      const [current, validUntil, confirmedAt] = await Promise.all([
        contracts.oracle.current(),
        contracts.oracle.validUntil(),
        contracts.oracle.confirmedAt(),
      ]);
      priceLive = latest <= Number(validUntil);
      const [opening] = priceLive
        ? await contracts.oracle.prices()
        : [current];
      $("#week-price").textContent = fmt(opening);
      $("#current-price").textContent = fmt(current);
      $("#price-state").textContent = priceLive
        ? `카운슬 확정 ${date(confirmedAt)} · 유효 ${date(validUntil)}까지`
        : "가격 만료 · 신규 체결과 가격 정산 중단";
    } else if (!fixed()) {
      // (keep the existing SignedPricePolicy block here unchanged)
    }
```

3. `offerCard`: replace the `헤어컷` cell `` `<div><dt>헤어컷</dt><dd>${percent(o.terms.haircutBps)}%</dd></div>` `` with `` `<div><dt>${council() ? "담보 여유" : "헤어컷"}</dt><dd>${percent(o.terms.haircutBps)}%</dd></div>` ``.
4. `loanCard`: inside the `<dl>`, after the `고정 연이율` cell, add a liquidation price for active priced loans:

```js
${council() && l.status === 1 && Number(l.terms.mode) === 0 && l.collateral > 0n ? `<div><dt>청산 가격</dt><dd>${fmt((l.debt * 10000n * 100000000n) / (l.collateral * BigInt(l.terms.liquidationBps)))} USDT 이하</dd></div>` : ""}
```

   and replace the final non-fixed `loan-detail` text with a council variant: when `council()`, show `` `카운슬 가격이 청산 가격 이하로 내려가거나 유예 종료(${date(due)})까지 갚지 않으면, 부채에 보너스 ${bonusPct}%를 더한 만큼의 WBMB가 대출자에게 가고 나머지는 돌려받습니다. 담보를 추가하면 청산 가격이 내려갑니다.` ``.
5. `render()`: in `descriptions.burn` and in the `else if (fixed())` fee-tab branch, `fixed()` → `vault()`.
6. `handleAction("fill")`: before `quoteFill`, add

```js
    if (council() && !priceLive)
      throw new Error("카운슬 가격이 만료되어 지금은 체결할 수 없습니다.");
```

7. `handleAction("settle")`: replace the confirmation text with one that names the bonus and the stale escape:

```js
      `대출 #${id}를 WBMB로 종료합니다.\n대출자 귀속 ${fmt(q.toLender, 8, 8)} WBMB\n차입자 반환 ${fmt(q.toBorrower, 8, 8)} WBMB\n종료 부채 ${fmt(q.debt, 18, 8)} USDT${council() ? (q.price === 0n ? "\n가격이 오래 끊겨 담보 전부가 대출자에게 갑니다." : `\n적용 가격 ${fmt(q.price)} USDT · 보너스 ${bonusPct}% 포함`) : ""}\nUSDT가 지급되는 것이 아니며 이 대출의 채권은 컨트랙트에서 종료됩니다.`,
```

8. `handleAction("flush")`: `fixed()` → `vault()`.
9. `syncOfferForm()`: hide the mode selector for council too (`hidden = vault()`), and set the note:

```js
  $("#terms-note").textContent = fixed()
    ? /* existing oracle-free text, unchanged */
    : council()
      ? `카운슬 가격 기준으로 담보 가치의 60%까지 빌려줍니다. 부채가 담보 가치의 80% 이상이 되거나 만기·유예 1일 후 미상환이면 정산되어, 부채에 보너스 ${bonusPct}%를 더한 만큼의 WBMB가 대출자에게 가고 나머지는 차입자에게 돌아갑니다. 단리 APR이며 지급 이자의 ${feePct}%가 별도 수수료입니다.`
      : /* existing demo text, unchanged */;
```

10. `form.onsubmit`: `mode = fixed() ? 1 : council() ? 0 : Number(form.elements.mode.value)`; `haircutBps: fixed() ? 0 : council() ? 4000 : 1000`; `liquidationBps: fixed() ? 0 : council() ? 8000 : 9500`.
11. `labAction()`: after the `if (fixed()) { … }` block add a council block, and wire the new button:

```js
    if (council()) {
      const price = seconds
        ? await contracts.oracle.current()
        : amount($("#lab-price").value);
      if (seconds) {
        await read.send("evm_increaseTime", [seconds]);
        await read.send("evm_mine", []);
      }
      // `refreshPrice` false leaves the price to expire, to show what an outage looks like.
      if (refreshPrice) {
        const reporter = await read.getSigner(config.oracle.reporterIndex);
        const t = Number((await read.getBlock("latest")).timestamp);
        await (
          await submitCouncilReport(
            contracts.oracle.connect(reporter),
            {
              policyId: COUNCIL_POLICY_ID,
              roundId: Number(await contracts.oracle.lastRoundId()) + 1,
              price,
              confirmedAt: t,
              validUntil: t + Number(config.oracle.maxAge) - 60,
            },
            [reporter],
          )
        ).wait();
      }
      await refresh();
      status(
        seconds
          ? `${seconds / 86400}일이 경과했습니다.`
          : "모의 카운슬 가격을 반영했습니다.",
        "success",
      );
      return;
    }
```

   Change the signature to `async function labAction(seconds, refreshPrice = true)` and add `$("#advance-week").onclick = () => labAction(7 * 86400, false);`.
12. `errorMessage`: the `STALE_PRICE` text mentions a "모의 가격" and a lab, which is wrong on a live page. Replace that entry and add one for the new revert:

```js
    STALE_PRICE: config?.demo
      ? "모의 가격이 만료됐습니다. 실험실에서 가격을 갱신하세요. 상환·담보 추가·수령은 계속 가능합니다."
      : "가격이 만료되어 지금은 체결·가격 정산을 할 수 없습니다. 상환·담보 추가·수령은 계속 가능합니다.",
    BAD_GRACE: "이 시장은 유예 1일 이상인 조건만 게시할 수 있습니다.",
```

13. `init()`:
    - `demoOk`: last clause becomes `(fixed() || (council() ? config.oracle?.contract === "CouncilPricePolicy" : config.oracle?.contract === "SignedPricePolicy"))`.
    - `names`: `fixed()` branch unchanged; add a council branch `{ lending: "P2PLending", usdt: null, wbmb: null, oracle: "CouncilPricePolicy" }` before the demo default.
    - Change `if (fixed()) {` (the on-chain verification block) to `if (vault()) {`. Inside it, replace `BigInt(policy) !== 0n` with `(council() ? !same(policy, config.addresses.oracle) : BigInt(policy) !== 0n)`. Wrap the two "hide price boxes / hide lab price" loops in `if (fixed())`. For council add:

```js
    if (council()) {
      bonusPct = percent(await contracts.lending.liquidationBonusBps());
      $("#week-label").textContent = "체결 기준가";
      $("#current-label").textContent = "카운슬 가격";
      $("#advance-week").hidden = false;
      $("#footer-version").textContent = "WBMB Commons · 카운슬 가격형 v1";
    }
```

      and make the existing `$("#footer-version").textContent = "WBMB Commons · 만기형 v1";` apply only when `fixed()`.

- [ ] **Step 6: Run the council browser tests**

Run: `npx playwright test -c playwright.council.config.js`
Expected: 4 passed.

- [ ] **Step 7: Run the other browser suites to prove nothing regressed**

Change `package.json` `test:browser` to:

```json
"test:browser": "playwright test && playwright test -c playwright.fixed.config.js && playwright test -c playwright.council.config.js",
```

Run: `npm run build && npm run test:browser`
Expected: 6 + 4 + 4 passed.

- [ ] **Step 8: Commit**

```bash
npx prettier --write src/app.js index.html scripts/dev.mjs scripts/deploy.mjs playwright.council.config.js tests/browser-council/app.spec.js package.json
git add src/app.js index.html scripts/dev.mjs scripts/deploy.mjs playwright.council.config.js tests/browser-council package.json
git commit -m "feat(web): council-price market in the local demo"
```

---

### Task 6: Live build and live rehearsal for the council market

**Files:**
- Modify: `src/app.js` (`liveOk` in `init()`)
- Modify: `scripts/build-live.mjs`
- Modify: `scripts/dev-live-rehearsal.mjs`
- Create: `playwright.live-council.config.js`
- Create: `tests/browser-live-council/app.spec.js`
- Modify: `package.json` (`test:live`, `build:live:council`)

**Interfaces:**
- Consumes: `liveWebConfig(record)` council shape and `deployBsc({ profile: "council", reporter })` (Task 4); `relayCouncil` (Task 3); `council()`/`vault()` in `src/app.js` (Task 5).
- Produces: `__PINNED__` gains an optional `oracle` address. `RECORD` env selects the record for `build-live.mjs` (default `deployments/bsc.json`). `MARKET=council` selects the council market in `dev-live-rehearsal.mjs`.

- [ ] **Step 1: Write the failing live tests**

`playwright.live-council.config.js`: copy `playwright.live.config.js` with `testDir: "./tests/browser-live-council"`, `baseURL`/`url` `http://127.0.0.1:5186`, and `env: { RPC_PORT: "18563", APP_PORT: "5186", MARKET: "council" }`.

`tests/browser-live-council/app.spec.js`:

```js
import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "serial" });
const RPC = "http://127.0.0.1:18563";
// Mock EIP-1193 wallet backed by an unlocked local account. `index` picks the account.
async function wallet(page, index) {
  await page.addInitScript(
    ({ rpc, index }) => {
      const listeners = {};
      window.ethereum = {
        request: async ({ method, params = [] }) => {
          const actual =
            method === "eth_requestAccounts" ? "eth_accounts" : method;
          const r = await fetch(rpc, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: actual, params }),
          });
          const data = await r.json();
          if (data.error) throw data.error;
          return actual === "eth_accounts" ? [data.result[index]] : data.result;
        },
        on: (name, fn) => (listeners[name] = fn),
        removeListener: (name) => delete listeners[name],
      };
    },
    { rpc: RPC, index },
  );
}
async function open(page) {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText(
    "BNB Smart Chain 연결 완료",
  );
}
async function connect(page) {
  await page.locator("#connect").click();
  await expect(page.locator("#account-label")).toHaveText("연결된 지갑");
}
async function commit(page, done) {
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-submit").click();
  await expect(page.locator("#status")).toContainText(done, { timeout: 40000 });
}

test("live council page shows the relayed price and no demo controls", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await expect(page.locator(".demo-banner")).toContainText("실제 자금");
  await expect(page.locator(".lab")).toBeHidden();
  await expect(page.locator("#current-label")).toContainText("카운슬 가격");
  await expect(page.locator("#current-price")).toHaveText("112.3");
  await expect(page.locator("#price-state")).toContainText("유효");
  expect(errors).toEqual([]);
});

test("lender posts, borrower fills at the council price and tops up", async ({
  browser,
}) => {
  const lender = await browser.newPage();
  await wallet(lender, 2);
  await open(lender);
  await connect(lender);
  await lender.locator("#open-offer").click();
  await lender.locator('#offer-form [name="side"]').selectOption("1");
  await lender.locator('#offer-form [name="total"]').fill("673.8");
  await lender.locator('#offer-form [name="minFill"]').fill("10");
  await lender.locator('#offer-form button[type="submit"]').click();
  await commit(lender, "거래 게시 완료");
  const borrower = await browser.newPage();
  await wallet(borrower, 1);
  await open(borrower);
  await connect(borrower);
  await borrower.locator('[data-tab="borrow"]').click();
  await borrower.locator('[data-fill-amount="1"]').fill("673.8");
  await borrower.locator('[data-offer="1"] [data-action="fill"]').click();
  // 673.8 / (112.3 * 0.6) = 10 WBMB
  await expect(borrower.locator("#confirm-body")).toContainText(
    "배정 담보: 10 WBMB",
  );
  await commit(borrower, "부분 체결 완료");
  await borrower.locator('[data-tab="mine"]').click();
  await expect(borrower.locator('[data-loan="1"]')).toContainText("청산 가격");
  await borrower.locator('[data-topup-amount="1"]').fill("1");
  await borrower.locator('[data-loan="1"] [data-action="topup"]').click();
  await commit(borrower, "담보 추가 완료");
});

test("rejects a swapped oracle address", async ({ page }) => {
  await page.route("**/deployment.json", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.addresses.oracle = "0x000000000000000000000000000000000000dEaD";
    await route.fulfill({ response, json });
  });
  await page.goto("/");
  await expect(page.locator("#status")).toContainText(
    "허용되지 않은 배포 설정입니다",
  );
});
```

The form's submit button opens the confirmation dialog; `commit` then confirms it. The other form fields keep their defaults.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test -c playwright.live-council.config.js`
Expected: FAIL — the page shows `허용되지 않은 배포 설정입니다` (live mode only accepts the oracle-free market) or the server ignores `MARKET`.

- [ ] **Step 3: Accept a pinned council market in `src/app.js`**

In `init()`, update the comment above `liveOk` to `// Live mode exists for the oracle-free and the council-price market on an allow-listed chain.` and replace the `fixed() &&` line inside `liveOk` with:

```js
    (fixed() ||
      (council() && sameAddress(config.addresses?.oracle, PINNED?.oracle))) &&
```

- [ ] **Step 4: Build from a chosen record**

In `scripts/build-live.mjs`:

```js
const recordFile = process.env.RECORD || "deployments/bsc.json";
if (!fs.existsSync(recordFile))
  throw new Error(
    `${recordFile} 이 없습니다. 먼저 npm run deploy:bsc -- --broadcast 로 배포하세요.`,
  );
```

Read the record from `recordFile`. Write `abis.json` with `CouncilPricePolicy` added when the record has a price policy:

```js
const council = record.pricePolicy && BigInt(record.pricePolicy) !== 0n;
fs.writeFileSync(
  `${publicDir}/abis.json`,
  JSON.stringify({
    P2PLending: abis.P2PLending,
    ...(council ? { CouncilPricePolicy: abis.CouncilPricePolicy } : {}),
  }) + "\n",
);
```

Add `...(council ? { oracle: record.pricePolicy } : {})` to `pinned`. Use `outDir: process.env.OUT_DIR || "dist-live"`.

Add to `package.json`: `"build:live:council": "RECORD=deployments/bsc-council.json OUT_DIR=dist-live-council node scripts/build-live.mjs"`. Add `dist-live-council/` to `.gitignore` next to `dist-live/`.

- [ ] **Step 5: Rehearse the council market on the chain-56 replica**

In `scripts/dev-live-rehearsal.mjs`, import `relayCouncil` from `./relay-council.mjs`. After creating `deployer`, when `process.env.MARKET === "council"`:

```js
  const councilMarket = process.env.MARKET === "council";
  const reporter = Wallet.createRandom();
  if (councilMarket)
    await local.send("hardhat_setBalance", [
      reporter.address,
      "0x16345785D8A0000",
    ]);
```

Pass `...(councilMarket ? { profile: "council", reporter: reporter.address } : {})` to `deployBsc`. After the deployment, publish the first price through the real relay code with a fixed API answer (the rehearsal must not depend on the live API):

```js
  if (councilMarket)
    await relayCouncil({
      rpcUrl: url,
      policy: record.pricePolicy,
      secret: reporter.privateKey,
      broadcast: true,
      log: () => {},
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          price: 112.3,
          date: "rehearsal",
          confirmedAt: "2026-01-01T00:00:00.000Z",
        }),
      }),
    });
```

`confirmedAt` must not be later than the local chain's clock, which follows the real clock; this date is in the past. Write `abis.json` with `CouncilPricePolicy` included when `councilMarket`, and add `...(councilMarket ? { oracle: record.pricePolicy } : {})` to the `__PINNED__` object.

- [ ] **Step 6: Run the live suites**

Change `package.json` `test:live` to `"playwright test -c playwright.live.config.js && playwright test -c playwright.live-council.config.js"`.

Run: `npm run test:live`
Expected: 5 passed (oracle-free) then 3 passed (council). Needs network access to read the real token bytecode.

Run: `npm run build:live`
Expected: builds `dist-live/` for the existing oracle-free market exactly as before.

- [ ] **Step 7: Commit**

```bash
npx prettier --write src/app.js scripts/build-live.mjs scripts/dev-live-rehearsal.mjs playwright.live-council.config.js tests/browser-live-council/app.spec.js package.json
git add src/app.js scripts/build-live.mjs scripts/dev-live-rehearsal.mjs playwright.live-council.config.js tests/browser-live-council package.json .gitignore
git commit -m "feat(web): live build and rehearsal for the council-price market"
```

---

### Task 7: Real-token run, full verification and documentation

**Files:**
- Modify: `tests/real/real-tokens.test.mjs` (append a second `describe`)
- Modify: `docs/MAINNET.md`, `docs/VALIDATION.md`, `docs/IMPLEMENTATION.md`, `README.md`

**Interfaces:**
- Consumes: everything above. Produces documentation only.

- [ ] **Step 1: Write the real-token council test**

Append to `tests/real/real-tokens.test.mjs`, reusing the file's `installRealToken`, `give` and `ERC20`. Add the imports `Wallet` (ethers), `COUNCIL_POLICY_ID`, `submitCouncilReport` (`../../src/council-signing.mjs`):

```js
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
```

- [ ] **Step 2: Run it**

Run: `npm run compile && node --test tests/real/real-tokens.test.mjs`
Expected: previous tests plus 1 new pass. Because this test is written after the code it exercises, also confirm it can fail: temporarily change `wb(9)` to `wb(8)`, run, see the assertion fail, and restore it.

- [ ] **Step 3: Run everything**

Run each and record the pass counts and the two runtime sizes:

```bash
npm test
npm run test:real
npm run build
npm run test:browser
npm run test:live
npm audit
```

Expected: all pass; `P2PLending` and `CouncilPricePolicy` runtime bytes both under 24,576; audit reports 0 vulnerabilities. If anything fails, stop and fix it before writing the docs.

- [ ] **Step 4: Update the documentation**

Write for an operator who has not seen this plan. Use the counts and sizes measured in Step 3, not estimates.

`docs/MAINNET.md` — add a section `## 8. 카운슬 가격형 시장` covering:
- what it does (the six bullets from the spec's sections 1 and 5, in plain Korean: council price, 60% lending limit and 80% liquidation line on the screen, lender gets debt + 5% in WBMB and the rest returns, top-up, 7-day escape when the price is stale);
- deployment commands, each marked with whether it sends anything:

```bash
# 예상 비용만 (전송 없음)
REPORTER=0x중계지갑주소 npm run deploy:bsc -- --council --test-market
# 실제 배포 (BNB 사용)
DEPLOYER_KEY_FILE=/경로/키파일 DEPLOYER_INDEX=0 DEPLOYER_EXPECT=0x배포지갑 FEE_WALLET=0x수수료지갑 REPORTER=0x중계지갑주소 npm run deploy:bsc -- --council --test-market --broadcast
# 첫 가격 등록: 드라이런 → 전송
RELAY_KEY_FILE=/경로/중계키 npm run relay:council -- --test-market
RELAY_KEY_FILE=/경로/중계키 npm run relay:council -- --test-market --broadcast
```

- that the market cannot fill any offer until the relay has published the first price;
- how to run the relay on a timer (one line of cron running every 30 minutes, with `--broadcast`), that the relay wallet needs a little BNB, and that the relay exits non-zero and sends nothing when the council price moves more than 30% at once — a person must then check;
- the risks from the spec's section 9, each as one sentence.

`docs/VALIDATION.md` — the line `npm run test:real | 12 passed` in the 실전 버전 section is stale (18 at commit 6cc30c8: 4 + 10 + 4); correct it. Then add `## 카운슬 가격형 시장 검증 (2026-10-02)` with a table of the Step 3 commands and their measured results, the two runtime sizes, and the sentence that nothing was sent to mainnet and the live council API was read only by hand.

`docs/IMPLEMENTATION.md` — add `## 카운슬 가격형 시장 (v0.3, 2026-10-02)` listing the `CouncilPricePolicy` rejection table (from the spec's section 4), the three `P2PLending` changes, the 9-argument constructor, and what the contract does **not** prove (that the reporter copied the council price faithfully; that 1 USD = 1 USDT; that WBMB = BMB).

`README.md` — add `MARKET=council npm run dev`, `npm run relay:council` and `npm run build:live:council` to the command list, one line each, matching the existing list's style.

- [ ] **Step 5: Commit**

```bash
npx prettier --write tests/real/real-tokens.test.mjs docs/MAINNET.md docs/VALIDATION.md docs/IMPLEMENTATION.md README.md
git add tests/real/real-tokens.test.mjs docs/MAINNET.md docs/VALIDATION.md docs/IMPLEMENTATION.md README.md
git commit -m "docs: council-price market deployment, relay operation and validation"
```

---

## After the plan

Not part of this plan, and each needs the user's explicit instruction because it spends real money:

1. Deploy the council **test** market to BSC (`--council --test-market --broadcast`) and publish the first price.
2. Small live check on the test market (fill, top-up, price-based settlement).
3. Deploy the council **main** market with a fresh fee wallet and a dedicated relay wallet; start the relay timer.
