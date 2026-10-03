// Rehearses scripts/live-test.mjs on a local chain that reports chain id 56 and carries the
// real MOVN/WBMB bytecode, with a throwaway mnemonic. Nothing is sent to mainnet.
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
import { runLiveTest } from "../../scripts/live-test.mjs";
import { artifact } from "../../scripts/deploy.mjs";

describe("live test script rehearsal (local chain id 56, real token bytecode)", () => {
  const url = "http://127.0.0.1:18559";
  const phrase = Wallet.createRandom().mnemonic.phrase;
  const at = (n) =>
    HDNodeWallet.fromPhrase(phrase, undefined, `m/44'/60'/0'/0/${n}`).address;
  const BAL = ["function balanceOf(address) view returns (uint256)"];
  let server, local, dir, lendingAddress, stateFile, movn, wbmb;
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
  const run = (extra) =>
    runLiveTest({
      rpcUrl: url,
      secret: phrase,
      lendingAddress,
      stateFile,
      sleep: advance,
      log,
      ...extra,
    });

  before(async () => {
    server = await network.createServer("bscReplica", "127.0.0.1", 18559);
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
    for (const token of [BSC.movn, BSC.wbmb]) {
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
    movn = new Contract(BSC.movn, BAL, local);
    wbmb = new Contract(BSC.wbmb, BAL, local);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbmb-live-"));
    stateFile = path.join(dir, "state.json");
    // local gas price is ~20x BSC's, so fund generously and check the budget in gas units
    await local.send("hardhat_setBalance", [at(0), "0xB1A2BC2EC50000"]); // 0.05 BNB
    const record = await deployBsc({
      rpcUrl: url,
      secret: phrase,
      index: 0,
      expectAddress: at(0),
      profile: "test",
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

  it("reports exactly what is missing and sends nothing when the wallets are not funded", async () => {
    const nonce = await local.getTransactionCount(at(0));
    const r = await run({ execute: true });
    assert.equal(r.ready, false);
    assert.equal(r.problems.length, 2);
    assert.match(r.problems.join("\n"), /WBMB 0\.0002/);
    assert.match(r.problems.join("\n"), /MOVN 0\.02/);
    assert.equal(await local.getTransactionCount(at(0)), nonce);
  });

  it("without --execute it only prints the plan", async () => {
    await give(wbmb, at(0), parseUnits("0.0002", 8));
    await give(movn, at(1), parseUnits("0.02", 18));
    const nonce = await local.getTransactionCount(at(0));
    const r = await run({});
    assert.deepEqual([r.ready, r.executed], [true, undefined]);
    assert.equal(await local.getTransactionCount(at(0)), nonce);
    assert.equal(fs.existsSync(stateFile), false);
  });

  it("runs the full cycle within the gas budget and leaves only loan B open", async () => {
    const r = await run({ execute: true });
    assert.equal(r.executed, true);
    assert.ok(r.interest > 0n && r.fee > 0n);
    const lending = new Contract(
      lendingAddress,
      artifact("P2PLending").abi,
      local,
    );
    assert.equal(Number((await lending.getLoan(r.loanA)).status), 2);
    assert.equal(Number((await lending.getLoan(r.loanB)).status), 1);
    // borrower: both collaterals minus the one locked in loan B; holds loan B's principal minus interest and fee
    assert.equal(await wbmb.balanceOf(at(0)), parseUnits("0.0001", 8));
    // the fee wallet is the borrower wallet, so only the interest left it
    assert.equal(
      await movn.balanceOf(at(0)),
      parseUnits("0.01", 18) - r.interest,
    );
    assert.equal(
      await movn.balanceOf(at(1)),
      parseUnits("0.01", 18) + r.interest,
    );
    // the whole cycle must fit the script's own 3.5M gas budget (0.000175 BNB at 0.05 gwei)
    assert.ok(r.gasUsed < 3_500_000n);
    assert.ok((await local.getBalance(at(0))) > 0n);
    assert.equal(lines.join("\n").includes(phrase), false);
    // a second run is refused while loan B is open
    await assert.rejects(run({ execute: true }), /이미 진행 중인 테스트/);
  });

  it("settlement is refused before maturity + grace and hands the collateral to the lender after", async () => {
    const early = await run({ settle: true, execute: true });
    assert.equal(early.settled, false);
    assert.ok(early.secondsLeft > 0);
    await advance(1800 + 300);
    const dry = await run({ settle: true });
    assert.equal(dry.settled, false);
    const r = await run({ settle: true, execute: true });
    assert.equal(r.settled, true);
    assert.equal(await wbmb.balanceOf(at(1)), parseUnits("0.0001", 8));
    assert.equal(fs.existsSync(stateFile), false);
    const lending = new Contract(
      lendingAddress,
      artifact("P2PLending").abi,
      local,
    );
    assert.equal(await movn.balanceOf(lendingAddress), 0n);
    assert.equal(await wbmb.balanceOf(lendingAddress), 0n);
    assert.equal(Number((await lending.getLoan(r.loanB)).status), 3);
  });
});
