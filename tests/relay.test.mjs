import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { JsonRpcProvider, Wallet } from "ethers";
import { deployContract, us } from "../scripts/deploy.mjs";
import { BSC } from "../config/bsc.mjs";
import {
  COUNCIL_POLICY_ID,
  submitCouncilReport,
} from "../src/council-signing.mjs";
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
    const p = plan(api("118"), chain({ ...soon, validUntil: now + 3600 }));
    assert.equal(p.action, "submit");
    assert.equal(p.report.price, us("112.3"));
    assert.equal(p.report.confirmedAt, CONFIRMED);
  });
  it("a change beyond the on-chain limit moves one maximum step, unattended", () => {
    const up = plan(api("146", CONFIRMED + 60), chain());
    assert.deepEqual(
      [up.action, up.step, up.report.price, up.report.confirmedAt],
      ["submit", true, us("145.99"), CONFIRMED], // 112.3 × 1.3
    );
    assert.match(up.reason, /한도 30%만큼 단계 이동/);
    const down = plan(api("78.6", CONFIRMED + 60), chain());
    assert.deepEqual(
      [down.action, down.step, down.report.price],
      ["submit", true, us("78.61")], // 112.3 × 0.7
    );
  });
  it("refuses a confirmation time in the future or older than the chain's", () => {
    assert.throws(() => plan(api("112.3", now + 10), chain()), /확정 시각/);
    assert.throws(() => plan(api("118", CONFIRMED - 10), chain()), /확정 시각/);
  });

  // Operator mode: `step` is only ever set by a person running --step.
  const stepPlan = (a, c) =>
    planRelay({
      api: a,
      chain: c,
      now,
      policyId: COUNCIL_POLICY_ID,
      step: true,
    });
  it("step: moves one maximum step up and carries the chain's confirmedAt", () => {
    const p = stepPlan(api("200", CONFIRMED + 60), chain());
    assert.equal(p.action, "submit");
    assert.equal(p.step, true);
    // 112.3 + floor(112.3 * 30%) = 145.99
    assert.deepEqual(p.report, {
      policyId: COUNCIL_POLICY_ID,
      roundId: 4,
      price: us("145.99"),
      confirmedAt: CONFIRMED,
      validUntil: now + MAX_AGE - 600,
    });
  });
  it("step: moves one maximum step down", () => {
    const p = stepPlan(api("50", CONFIRMED + 60), chain());
    assert.equal(p.action, "submit");
    assert.equal(p.step, true);
    // 112.3 - floor(112.3 * 30%) = 78.61
    assert.equal(p.report.price, us("78.61"));
    assert.equal(p.report.confirmedAt, CONFIRMED);
  });
  it("step: the step is floored, so it never exceeds what the contract accepts", () => {
    const current = 1000000000000000003n;
    for (const target of [current * 5n, 1n]) {
      const p = stepPlan(
        { price: target, confirmedAt: CONFIRMED },
        chain({ current, maxChangeBps: 3333 }),
      );
      const diff =
        p.report.price > current
          ? p.report.price - current
          : current - p.report.price;
      assert.equal(diff, (current * 3333n) / 10000n);
      // The contract's own test: diff * BPS <= current * maxChangeBps, and one unit more fails it.
      assert.ok(diff * 10000n <= current * 3333n);
      assert.ok((diff + 1n) * 10000n > current * 3333n);
    }
  });
  it("step: waits when the last change is too recent, but still refreshes an expiring price", () => {
    const soon = { changedAt: now - 60 };
    const waiting = stepPlan(api("200"), chain(soon));
    assert.equal(waiting.action, "wait");
    assert.equal(waiting.report, undefined);
    const p = stepPlan(api("200"), chain({ ...soon, validUntil: now + 3600 }));
    assert.equal(p.action, "submit");
    assert.equal(p.step, undefined);
    assert.equal(p.report.price, us("112.3"));
    assert.equal(p.report.confirmedAt, CONFIRMED);
  });
  it("step: an API confirmedAt older than the chain's no longer blocks", () => {
    // Within the limit: the council price itself, under the chain's confirmedAt.
    const within = stepPlan(api("118", CONFIRMED - 10), chain());
    assert.equal(within.action, "submit");
    assert.equal(within.report.price, us("118"));
    assert.equal(within.report.confirmedAt, CONFIRMED);
    // Beyond the limit: one step, also under the chain's confirmedAt.
    const beyond = stepPlan(api("200", CONFIRMED - 10), chain());
    assert.equal(beyond.report.price, us("145.99"));
    assert.equal(beyond.report.confirmedAt, CONFIRMED);
  });
  it("step: changes nothing when the council price is within the limit", () => {
    for (const [a, c] of [
      [api(), chain()],
      [api(), chain({ validUntil: now + MAX_AGE / 3 - 1 })],
      [api("118", CONFIRMED + 60), chain()],
      [api("145.99", CONFIRMED + 60), chain()],
      [api("118"), chain({ changedAt: now - 60 })],
      [
        api(),
        chain({ lastRoundId: 0, current: 0n, confirmedAt: 0, validUntil: 0 }),
      ],
    ])
      assert.deepEqual(stepPlan(a, c), plan(a, c));
  });
  it("step: still refuses a confirmation time in the future", () => {
    assert.throws(() => stepPlan(api("200", now + 10), chain()), /확정 시각/);
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
      run({
        broadcast: true,
        fetchImpl: async () => ({ ok: false, status: 503 }),
      }),
      /503/,
    );
    assert.equal(await local.getTransactionCount(reporter.address), 0);
  });
  it("ends with a Korean error when the API does not answer in time", async () => {
    const before = await local.getTransactionCount(reporter.address);
    const hangs = (url, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
    await assert.rejects(
      run({ broadcast: true, fetchImpl: hangs, apiTimeoutMs: 50 }),
      /카운슬 가격 API가 응답하지 않았습니다/,
    );
    assert.equal(await local.getTransactionCount(reporter.address), before);
  });
  it("ends with a Korean error when the API request fails", async () => {
    const before = await local.getTransactionCount(reporter.address);
    await assert.rejects(
      run({
        broadcast: true,
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      }),
      /카운슬 가격 API가 응답하지 않았습니다.*fetch failed/,
    );
    assert.equal(await local.getTransactionCount(reporter.address), before);
  });
  it("reports a sent but unconfirmed transaction with its hash", async () => {
    // A fresh policy keeps round 1 of the shared one for the broadcast test below.
    const fresh = await deployContract("CouncilPricePolicy", admin, [
      [reporter.address],
      1,
      COUNCIL_POLICY_ID,
      6 * 86400,
      3000,
      43200,
    ]);
    await local.send("evm_setAutomine", [false]);
    try {
      await assert.rejects(
        run({ broadcast: true, policy: fresh.target, confirmTimeoutMs: 300 }),
        (e) =>
          /확인되지 않았습니다/.test(e.message) &&
          /0x[0-9a-f]{64}/.test(e.message),
      );
    } finally {
      await local.send("evm_setAutomine", [true]);
      await local.send("evm_mine", []);
    }
    assert.equal(await fresh.lastRoundId(), 1n);
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

// The limits the real market is deployed with (config/bsc.mjs): 30% per change, 12 hours apart.
describe("relayCouncil with the deployed limits, on a local chain", () => {
  const url = "http://127.0.0.1:18564";
  const { maxAge, maxChangeBps, minInterval } = BSC.council;
  const T0 = "2026-01-01T00:00:00.000Z";
  const T1 = "2026-02-01T00:00:00.000Z";
  const T2 = "2026-03-01T00:00:00.000Z";
  const secs = (iso) => Math.floor(Date.parse(iso) / 1000);
  let server, local, oracle;
  const reporter = Wallet.createRandom();
  const run = (price, confirmedAt, over = {}) =>
    relayCouncil({
      rpcUrl: url,
      chainId: 31337,
      policy: oracle.target,
      secret: reporter.privateKey,
      broadcast: true,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ price, date: "test", confirmedAt }),
      }),
      log: () => {},
      ...over,
    });
  const state = async () => ({
    round: await oracle.lastRoundId(),
    previous: await oracle.previous(),
    current: await oracle.current(),
    confirmedAt: await oracle.confirmedAt(),
    validUntil: await oracle.validUntil(),
    changedAt: await oracle.changedAt(),
  });
  const sent = () => local.getTransactionCount(reporter.address);
  const advance = async (seconds) => {
    await local.send("evm_increaseTime", [seconds]);
    await local.send("evm_mine", []);
  };

  before(async () => {
    server = await network.createServer(undefined, "127.0.0.1", 18564);
    await server.listen();
    local = new JsonRpcProvider(url, 31337, {
      staticNetwork: true,
      cacheTimeout: -1,
    });
    oracle = await deployContract(
      "CouncilPricePolicy",
      await local.getSigner(0),
      [
        [reporter.address],
        1,
        COUNCIL_POLICY_ID,
        maxAge,
        maxChangeBps,
        minInterval,
      ],
    );
    await local.send("hardhat_setBalance", [
      reporter.address,
      "0x16345785D8A0000",
    ]);
  });
  after(async () => {
    local?.destroy();
    await server?.close();
  });

  it("the policy under test carries the deployed limits", async () => {
    assert.deepEqual(
      [maxAge, maxChangeBps, minInterval],
      [6 * 86400, 3000, 86400],
    );
    assert.equal(await oracle.maxChangeBps(), 3000n);
    assert.equal(await oracle.minInterval(), 86400n);
  });
  it("a changed price waits for minInterval, then the contract accepts it", async () => {
    await run(100, T0);
    assert.equal((await state()).current, us(100));
    const before = await sent();
    const early = await run(110, T1);
    assert.equal(early.action, "wait");
    assert.equal(await sent(), before);
    assert.equal((await state()).current, us(100));
    await advance(minInterval);
    const r = await run(110, T1);
    assert.equal(r.broadcast, true);
    const s = await state();
    assert.equal(s.round, 2n);
    assert.equal(s.current, us(110));
    assert.equal(s.previous, us(100));
    assert.equal(s.confirmedAt, BigInt(secs(T1)));
    assert.equal(
      s.changedAt,
      BigInt((await local.getBlock("latest")).timestamp),
    );
  });
  it("a same-price refresh extends validUntil and does not reset changedAt", async () => {
    const before = await state();
    assert.equal((await run(110, T1)).action, "none");
    assert.equal(await oracle.lastRoundId(), 2n);
    // Less than a third of maxAge left, but not expired.
    await advance((2 * maxAge) / 3);
    const r = await run(110, T1);
    assert.equal(r.action, "submit");
    assert.equal(r.broadcast, true);
    const s = await state();
    assert.equal(s.round, 3n);
    assert.ok(s.validUntil > before.validUntil);
    // now + maxAge - 600, where `now` is the block the relay read just before its own.
    const mined = (await local.getBlock("latest")).timestamp;
    assert.ok(s.validUntil < BigInt(mined + maxAge - 600));
    assert.ok(s.validUntil > BigInt(mined + maxAge - 660));
    assert.equal(s.changedAt, before.changedAt);
    assert.equal(s.current, before.current);
    assert.equal(s.previous, before.previous);
    assert.equal(s.confirmedAt, before.confirmedAt);
  });
  it("an over-limit dry run without --step plans the same step and sends nothing", async () => {
    const before = await state();
    const nonce = await sent();
    // 110 -> 180 is +63.6%, beyond the 30% the contract can ever accept in one report.
    const r = await run(180, T2, { broadcast: false });
    assert.deepEqual(
      { action: r.action, broadcast: r.broadcast, step: r.step },
      { action: "submit", broadcast: false, step: true },
    );
    assert.equal(await sent(), nonce);
    assert.deepEqual(await state(), before);
  });
  it("a --step dry run prints the planned step and sends nothing", async () => {
    const before = await state();
    const nonce = await sent();
    const lines = [];
    const r = await run(180, T2, {
      step: true,
      broadcast: false,
      log: (l) => lines.push(String(l)),
    });
    assert.deepEqual(
      { action: r.action, broadcast: r.broadcast, step: r.step },
      { action: "submit", broadcast: false, step: true },
    );
    const text = lines.join("\n");
    assert.match(text, /카운슬 180\.0 · 체인 110\.0/);
    assert.match(text, /가격 143\.0/);
    assert.match(text, /카운슬 확정 가격이 아닙니다/);
    assert.equal(await sent(), nonce);
    assert.deepEqual(await state(), before);
  });
  it("one --step lands exactly on the limit and the contract accepts it", async () => {
    const before = await state();
    const limit =
      before.current + (before.current * BigInt(maxChangeBps)) / 10000n;
    assert.equal(limit, us(143));
    // One unit beyond the limit is what the contract refuses.
    const t = (await local.getBlock("latest")).timestamp;
    await assert.rejects(
      submitCouncilReport(
        oracle.connect(reporter.connect(local)),
        {
          policyId: COUNCIL_POLICY_ID,
          roundId: Number(before.round) + 1,
          price: limit + 1n,
          confirmedAt: Number(before.confirmedAt),
          validUntil: t + 3600,
        },
        [reporter],
      ),
      /PRICE_JUMP/,
    );
    const r = await run(180, T2, { step: true });
    assert.equal(r.broadcast, true);
    assert.equal(r.step, true);
    const s = await state();
    assert.equal(s.round, before.round + 1n);
    assert.equal(s.current, limit);
    assert.equal(s.previous, us(110));
    // The intermediate price is not a council confirmation: the chain's time is kept.
    assert.equal(s.confirmedAt, BigInt(secs(T1)));
  });
  it("after minInterval the next ordinary run reaches the council price", async () => {
    const nonce = await sent();
    assert.equal((await run(180, T2)).action, "wait");
    assert.equal((await run(180, T2)).action, "wait");
    assert.equal(await sent(), nonce);
    await advance(minInterval);
    // 143 -> 180 is +25.9%: within the limit, so no --step is needed.
    const r = await run(180, T2);
    assert.equal(r.broadcast, true);
    assert.equal(r.step, false);
    const s = await state();
    assert.equal(s.current, us(180));
    assert.equal(s.previous, us(143));
    assert.equal(s.confirmedAt, BigInt(secs(T2)));
    assert.equal((await run(180, T2)).action, "none");
  });
});

// The CLI's record file can be overridden, so an operator can relay to a market other than
// the default one.
describe("relay CLI record selection", () => {
  it("RELAY_RECORD names the record file the CLI reads", async () => {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("node", ["scripts/relay-council.mjs"], {
      env: { ...process.env, RELAY_RECORD: "deployments/does-not-exist.json" },
      encoding: "utf8",
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /deployments\/does-not-exist\.json/);
  });
  it("without RELAY_RECORD, --test-market reads the MOVN council test record", async () => {
    const { spawnSync } = await import("node:child_process");
    // Run from an empty directory: the record path is relative to the working directory,
    // so the CLI reports the file it looked for (the real record now exists in the repo).
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-"));
    const r = spawnSync(
      "node",
      [path.resolve("scripts/relay-council.mjs"), "--test-market"],
      { cwd, env: { ...process.env, RELAY_RECORD: "" }, encoding: "utf8" },
    );
    fs.rmSync(cwd, { recursive: true, force: true });
    assert.match(r.stderr + r.stdout, /bsc-council-movn-test\.json/);
  });
});
