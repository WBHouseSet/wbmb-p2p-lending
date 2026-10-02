// Rehearses scripts/live-test-council.mjs on a local chain that reports chain id 56 and carries
// the real USDT/WBMB bytecode, with a throwaway mnemonic. Nothing is sent to mainnet.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { network } from "hardhat";
import {
  AbiCoder,
  Contract,
  HDNodeWallet,
  JsonRpcProvider,
  Wallet,
  keccak256,
  parseUnits,
  toBeHex,
} from "ethers";
import { BSC } from "../../config/bsc.mjs";
import { deployBsc } from "../../scripts/deploy-bsc.mjs";
import { relayCouncil } from "../../scripts/relay-council.mjs";
import { runCouncilLiveTest } from "../../scripts/live-test-council.mjs";
import { artifact } from "../../scripts/deploy.mjs";

describe("council live test script rehearsal (local chain id 56, real token bytecode)", () => {
  const url = "http://127.0.0.1:18565";
  const phrase = Wallet.createRandom().mnemonic.phrase;
  const at = (n) =>
    HDNodeWallet.fromPhrase(phrase, undefined, `m/44'/60'/0'/0/${n}`).address;
  const BAL = ["function balanceOf(address) view returns (uint256)"];
  // 112.3 USDT per WBMB: 0.002 USDT at 50% needs ceil(0.002 / 56.15) = 0.00003562 WBMB
  const EACH = 3562n;
  let server, local, dir, record, lendingAddress, stateFile, usdt, wbmb;
  const lines = [];
  const log = (x) => lines.push(x);
  async function give(token, who, amount) {
    for (let slot = 0; slot < 16; slot++) {
      const key = keccak256(
        AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [who, slot]),
      );
      const old = await local.getStorage(token.target, key);
      await local.send("hardhat_setStorageAt", [
        token.target,
        key,
        toBeHex(amount, 32),
      ]);
      if ((await token.balanceOf(who)) === amount) return;
      await local.send("hardhat_setStorageAt", [token.target, key, old]);
    }
    throw new Error("balance slot not found");
  }
  const advance = async (s) => {
    await local.send("evm_increaseTime", [s]);
    await local.send("evm_mine", []);
  };
  const relay = () =>
    relayCouncil({
      rpcUrl: url,
      policy: record.pricePolicy,
      secret: phrase,
      index: 2,
      expectAddress: at(2),
      broadcast: true,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          price: 112.3,
          confirmedAt: "2026-01-01T00:00:00.000Z",
        }),
      }),
      log: () => {},
    });
  const run = (extra) =>
    runCouncilLiveTest({
      rpcUrl: url,
      secret: phrase,
      lendingAddress,
      stateFile,
      sleep: advance,
      log,
      ...extra,
    });

  before(async () => {
    server = await network.createServer("bscReplica", "127.0.0.1", 18565);
    await server.listen();
    local = new JsonRpcProvider(url, 56, {
      staticNetwork: true,
      cacheTimeout: -1,
    });
    const real = new JsonRpcProvider(
      process.env.BSC_RPC_URL || BSC.rpcUrl,
      56,
      { staticNetwork: true },
    );
    for (const token of [BSC.usdt, BSC.wbmb]) {
      await local.send("hardhat_setCode", [token, await real.getCode(token)]);
      for (let slot = 0; slot < 16; slot++) {
        const value = await real.getStorage(token, slot);
        if (BigInt(value) !== 0n)
          await local.send("hardhat_setStorageAt", [
            token,
            toBeHex(slot),
            value,
          ]);
      }
    }
    real.destroy();
    usdt = new Contract(BSC.usdt, BAL, local);
    wbmb = new Contract(BSC.wbmb, BAL, local);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbmb-live-council-"));
    stateFile = path.join(dir, "state.json");
    // local gas price is ~20x BSC's, so fund generously and check the budget in gas units
    await local.send("hardhat_setBalance", [at(0), "0xB1A2BC2EC50000"]); // 0.05 BNB
    await local.send("hardhat_setBalance", [at(2), "0xB1A2BC2EC50000"]);
    record = await deployBsc({
      rpcUrl: url,
      secret: phrase,
      index: 0,
      expectAddress: at(0),
      profile: "council-test",
      reporter: at(2),
      broadcast: true,
      outDir: dir,
      confirmations: 1,
      log: () => {},
    });
    lendingAddress = record.lending;
  });
  after(async () => {
    local?.destroy();
    await server?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to start before the relay has published a price", async () => {
    await give(wbmb, at(0), parseUnits("0.0001", 8));
    await give(usdt, at(1), parseUnits("0.01", 18));
    const nonce = await local.getTransactionCount(at(0));
    const r = await run({ execute: true });
    assert.equal(r.ready, false);
    assert.match(r.problems.join("\n"), /가격이 등록돼 있지 않습니다/);
    assert.equal(await local.getTransactionCount(at(0)), nonce);
  });

  it("reports exactly what is missing and sends nothing when the wallets are not funded", async () => {
    await relay();
    await give(wbmb, at(0), 0n);
    await give(usdt, at(1), 0n);
    const nonce = await local.getTransactionCount(at(0));
    const r = await run({ execute: true });
    assert.equal(r.ready, false);
    assert.equal(r.problems.length, 2);
    assert.match(r.problems.join("\n"), /WBMB 0\.00008124/);
    assert.match(r.problems.join("\n"), /USDT 0\.004/);
    assert.equal(await local.getTransactionCount(at(0)), nonce);
  });

  it("without --execute it only prints the plan", async () => {
    await give(wbmb, at(0), parseUnits("0.0001", 8));
    await give(usdt, at(1), parseUnits("0.01", 18));
    const nonce = await local.getTransactionCount(at(0));
    const r = await run({});
    assert.deepEqual([r.ready, r.executed], [true, undefined]);
    assert.equal(await local.getTransactionCount(at(0)), nonce);
    assert.equal(fs.existsSync(stateFile), false);
  });

  it("runs the full cycle within the gas budget and leaves only loan B open", async () => {
    const r = await run({ execute: true });
    assert.equal(r.executed, true);
    assert.equal(r.collateral, EACH);
    assert.ok(r.interest > 0n && r.fee > 0n);
    const lending = new Contract(
      lendingAddress,
      artifact("P2PLending").abi,
      local,
    );
    assert.equal(Number((await lending.getLoan(r.loanA)).status), 2);
    const loanB = await lending.getLoan(r.loanB);
    assert.equal(Number(loanB.status), 1);
    assert.equal(loanB.collateral, EACH + 1000n);
    // borrower: everything except loan B's collateral and top-up is back
    assert.equal(
      await wbmb.balanceOf(at(0)),
      parseUnits("0.0001", 8) - EACH - 1000n,
    );
    // the fee wallet is the borrower wallet, so only the interest left it
    assert.equal(
      await usdt.balanceOf(at(0)),
      parseUnits("0.002", 18) - r.interest,
    );
    assert.equal(
      await usdt.balanceOf(at(1)),
      parseUnits("0.008", 18) + r.interest,
    );
    // the whole cycle must fit the script's own 3.5M gas budget (0.000175 BNB at 0.05 gwei)
    assert.ok(r.gasUsed < 3_500_000n);
    assert.equal(lines.join("\n").includes(phrase), false);
    // a second run is refused while loan B is open
    await assert.rejects(run({ execute: true }), /이미 진행 중인 테스트/);
  });

  it("settlement is refused before maturity + grace and without a live price", async () => {
    const early = await run({ settle: true, execute: true });
    assert.equal(early.settled, false);
    assert.ok(early.secondsLeft > 0);
    // Past the price's validity the script must not trigger the all-collateral escape.
    const snapshot = await local.send("evm_snapshot", []);
    await advance(7 * 86400);
    await assert.rejects(run({ settle: true, execute: true }), /가격이 만료돼/);
    assert.equal(fs.existsSync(stateFile), true);
    await local.send("evm_revert", [snapshot]);
  });

  it("after maturity + grace the lender gets debt + 10% and the borrower the rest", async () => {
    await advance(300 + 300);
    const dry = await run({ settle: true });
    assert.equal(dry.settled, false);
    const r = await run({ settle: true, execute: true });
    assert.equal(r.settled, true);
    assert.equal(r.price, parseUnits("112.3", 18));
    // debt = 0.002 USDT + 5 minutes at 100% APR; lender share = debt × 1.1 ÷ 112.3, rounded up
    const debt =
      parseUnits("0.002", 18) +
      (parseUnits("0.002", 18) * 300n + 31536000n - 1n) / 31536000n;
    assert.equal(r.debt, debt);
    const share =
      (debt * 11000n * 10n ** 8n + r.price * 10000n - 1n) / (r.price * 10000n);
    assert.equal(share, 1960n);
    assert.equal(r.toLender, share);
    assert.equal(r.toBorrower, EACH + 1000n - share);
    assert.equal(await wbmb.balanceOf(at(1)), share);
    assert.equal(await wbmb.balanceOf(at(0)), parseUnits("0.0001", 8) - share);
    assert.equal(fs.existsSync(stateFile), false);
    const lending = new Contract(
      lendingAddress,
      artifact("P2PLending").abi,
      local,
    );
    assert.equal(await usdt.balanceOf(lendingAddress), 0n);
    assert.equal(await wbmb.balanceOf(lendingAddress), 0n);
    assert.equal(Number((await lending.getLoan(r.loanB)).status), 3);
  });
});
