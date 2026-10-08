// Rehearses scripts/deploy-swap-bsc.mjs on a local chain that reports chain id 56 and carries
// the real MOVN/WBMB bytecode, then checks what a live page build takes from the record.
// Uses a throwaway key. Nothing is sent to mainnet.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { network } from "hardhat";
import { Contract, JsonRpcProvider, Wallet, toBeHex } from "ethers";
import { BSC } from "../../config/bsc.mjs";
import { deploySwapBsc } from "../../scripts/deploy-swap-bsc.mjs";
import {
  liveAbiNames,
  livePinned,
  liveWebConfig,
} from "../../scripts/deploy-bsc.mjs";
import { artifact } from "../../scripts/deploy.mjs";

describe("trade board deploy script rehearsal (local chain id 56)", () => {
  const url = "http://127.0.0.1:18567";
  let server, local, outDir;
  const wallet = Wallet.createRandom();
  const feeWallet = Wallet.createRandom().address;
  const log = () => {};
  const run = (options) =>
    deploySwapBsc({ rpcUrl: url, outDir, confirmations: 1, log, ...options });
  // A council market record on the same chain and tokens, as build-live reads it.
  const market = {
    chainId: 56,
    lending: Wallet.createRandom().address,
    pricePolicy: Wallet.createRandom().address,
    movn: BSC.movn,
    wbmb: BSC.wbmb,
    feeWallet,
    feeBps: 500,
    profile: "council-test",
    liquidationBonusBps: 1000,
    settlementFee: true,
    deployedAt: "2026-10-08T00:00:00.000Z",
  };

  before(async () => {
    server = await network.createServer("bscReplica", "127.0.0.1", 18567);
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
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "wbmb-swap-deploy-"));
  });
  after(async () => {
    local?.destroy();
    await server?.close();
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("without a key it only estimates and sends nothing", async () => {
    const r = await run({ feeWallet });
    assert.equal(r.broadcast, false);
    assert.ok(r.gas > 500_000n);
  });

  it("needs a fee wallet that is a real wallet address", async () => {
    await assert.rejects(run({ secret: wallet.privateKey }), /FEE_WALLET/);
    await assert.rejects(
      run({ secret: wallet.privateKey, feeWallet: BSC.movn }),
      /FEE_WALLET/,
    );
  });

  it("with a key but no --broadcast it reports the wallet and still sends nothing", async () => {
    const r = await run({ secret: wallet.privateKey, feeWallet });
    assert.equal(r.broadcast, false);
    assert.equal(r.from, wallet.address);
    assert.equal(await local.getTransactionCount(wallet.address), 0);
    assert.deepEqual(fs.readdirSync(outDir), []);
  });

  it("refuses to broadcast when the wallet cannot pay for gas", async () => {
    await assert.rejects(
      run({ secret: wallet.privateKey, feeWallet, broadcast: true }),
      /BNB 잔액 부족/,
    );
  });

  it("broadcast deploys the test board, reads its settings back and records it", async () => {
    await local.send("hardhat_setBalance", [
      wallet.address,
      "0x16345785D8A0000",
    ]); // 0.1 BNB
    const r = await run({
      secret: wallet.privateKey,
      feeWallet,
      broadcast: true,
    });
    assert.equal(r.broadcast, true);
    const record = JSON.parse(
      fs.readFileSync(path.join(outDir, "bsc-swap-test.json"), "utf8"),
    );
    assert.equal(record.swap, r.swap);
    assert.equal(record.profile, "test");
    assert.equal(record.feeWallet, feeWallet);
    assert.equal(record.feeBps, 50);
    assert.deepEqual(record.constructorArgs, [
      BSC.movn,
      BSC.wbmb,
      feeWallet,
      "50",
    ]);
    const swap = new Contract(record.swap, artifact("P2PSwap").abi, local);
    assert.equal(await swap.movn(), BSC.movn);
    assert.equal(await swap.wbmb(), BSC.wbmb);
    assert.equal(await swap.feeVault(), feeWallet);
    assert.equal(await swap.feeBps(), 50n);
    // a second run never overwrites the record
    await assert.rejects(
      run({ secret: wallet.privateKey, feeWallet, broadcast: true }),
      /이미 배포 기록이 있습니다/,
    );
    // the main board is recorded in its own file
    await run({
      profile: "main",
      secret: wallet.privateKey,
      feeWallet,
      broadcast: true,
    });
    assert.deepEqual(fs.readdirSync(outDir).sort(), [
      "bsc-swap-test.json",
      "bsc-swap.json",
    ]);
  });

  it("a live build takes the trade contract, its fee wallet and fee rate from the record", async () => {
    const record = JSON.parse(
      fs.readFileSync(path.join(outDir, "bsc-swap-test.json"), "utf8"),
    );
    // without a trade record nothing changes
    assert.equal(liveWebConfig(market).addresses.swap, undefined);
    assert.equal(livePinned(market).swap, undefined);
    assert.deepEqual(liveAbiNames(market), [
      "P2PLending",
      "CouncilPricePolicy",
    ]);
    assert.equal(
      liveWebConfig(market, url, record).addresses.swap,
      record.swap,
    );
    const pinned = livePinned(market, url, record);
    assert.equal(pinned.swap, record.swap);
    assert.equal(pinned.swapFeeVault, feeWallet);
    assert.equal(pinned.swapFeeBps, 50);
    assert.deepEqual(liveAbiNames(market, record), [
      "P2PLending",
      "CouncilPricePolicy",
      "P2PSwap",
    ]);
  });

  it("a trade record for other tokens or another chain is refused", async () => {
    const record = JSON.parse(
      fs.readFileSync(path.join(outDir, "bsc-swap-test.json"), "utf8"),
    );
    for (const wrong of [
      { ...record, wbmb: BSC.movn },
      { ...record, movn: wallet.address },
      { ...record, chainId: 97 },
      { ...record, swap: undefined },
    ]) {
      assert.throws(() => liveWebConfig(market, url, wrong), /직거래 기록/);
      assert.throws(() => livePinned(market, url, wrong), /직거래 기록/);
    }
  });
});
