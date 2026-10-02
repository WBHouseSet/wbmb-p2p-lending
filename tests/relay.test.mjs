import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { JsonRpcProvider, Wallet } from "ethers";
import { deployContract, us } from "../scripts/deploy.mjs";
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
    const p = plan(api("118"), chain({ ...soon, validUntil: now + 3600 }));
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
      run({
        broadcast: true,
        fetchImpl: async () => ({ ok: false, status: 503 }),
      }),
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
