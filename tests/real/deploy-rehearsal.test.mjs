// Rehearses scripts/deploy-bsc.mjs end to end on a local chain that reports chain id 56 and
// carries the real USDT/WBMB bytecode. Uses a throwaway key. Nothing is sent to mainnet.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { network } from "hardhat";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  toBeHex,
} from "ethers";
import { BSC } from "../../config/bsc.mjs";
import {
  deployBsc,
  liveWebConfig,
  loadDeployer,
} from "../../scripts/deploy-bsc.mjs";
import { artifact } from "../../scripts/deploy.mjs";

describe("mainnet deploy script rehearsal (local chain id 56)", () => {
  const url = "http://127.0.0.1:18556";
  let server, local, outDir;
  const wallet = Wallet.createRandom();
  const logs = [];
  const log = (line) => logs.push(line);

  before(async () => {
    server = await network.createServer("bscReplica", "127.0.0.1", 18556);
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
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "wbmb-deploy-"));
  });
  after(async () => {
    local?.destroy();
    await server?.close();
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("without a key it only estimates and sends nothing", async () => {
    const r = await deployBsc({ rpcUrl: url, log });
    assert.equal(r.broadcast, false);
    assert.ok(r.gas > 2_000_000n);
  });

  it("with a key but no --broadcast it reports the wallet and still sends nothing", async () => {
    const r = await deployBsc({
      rpcUrl: url,
      secret: wallet.privateKey,
      outDir,
      log,
    });
    assert.equal(r.broadcast, false);
    assert.equal(r.from, wallet.address);
    assert.equal(await local.getTransactionCount(wallet.address), 0);
    assert.equal(fs.existsSync(path.join(outDir, "bsc.json")), false);
  });

  it("refuses to broadcast when the wallet cannot pay for gas", async () => {
    await assert.rejects(
      deployBsc({
        rpcUrl: url,
        secret: wallet.privateKey,
        broadcast: true,
        outDir,
        log,
      }),
      /BNB 잔액 부족/,
    );
  });

  it("broadcast deploys the oracle-free market with the deployer as fee wallet and records it", async () => {
    await local.send("hardhat_setBalance", [
      wallet.address,
      "0x16345785D8A0000",
    ]); // 0.1 BNB
    const r = await deployBsc({
      rpcUrl: url,
      secret: wallet.privateKey,
      broadcast: true,
      outDir,
      confirmations: 1,
      log,
    });
    assert.equal(r.broadcast, true);
    const record = JSON.parse(
      fs.readFileSync(path.join(outDir, "bsc.json"), "utf8"),
    );
    assert.equal(record.lending, r.lending);
    assert.equal(record.feeWallet, wallet.address);
    const lending = new Contract(
      record.lending,
      artifact("P2PLending").abi,
      local,
    );
    assert.equal(await lending.usdt(), BSC.usdt);
    assert.equal(await lending.wbmb(), BSC.wbmb);
    assert.equal(await lending.pricePolicy(), ZeroAddress);
    assert.equal(await lending.feeVault(), wallet.address);
    assert.equal(await lending.oracleFree(), true);
    const web = liveWebConfig(record);
    assert.deepEqual(
      {
        demo: web.demo,
        oracleFree: web.oracleFree,
        chainId: web.chainId,
        lending: web.addresses.lending,
      },
      { demo: false, oracleFree: true, chainId: 56, lending: record.lending },
    );
  });

  it("refuses to overwrite an existing deployment record", async () => {
    await assert.rejects(
      deployBsc({
        rpcUrl: url,
        secret: wallet.privateKey,
        broadcast: true,
        outDir,
        confirmations: 1,
        log,
      }),
      /이미 배포 기록/,
    );
  });

  it("rejects an RPC that is not chain 56 and unusable fee wallets before sending anything", async () => {
    const other = await network.createServer("default", "127.0.0.1", 18558);
    await other.listen();
    try {
      await assert.rejects(
        deployBsc({
          rpcUrl: "http://127.0.0.1:18558",
          secret: wallet.privateKey,
          broadcast: true,
          outDir,
          log,
        }),
        /56/,
      );
    } finally {
      await other.close();
    }
    const nonce = await local.getTransactionCount(wallet.address);
    for (const bad of ["0x1234", BSC.usdt, BSC.wbmb, ZeroAddress])
      await assert.rejects(
        deployBsc({
          rpcUrl: url,
          secret: wallet.privateKey,
          feeWallet: bad,
          broadcast: true,
          outDir: outDir + "-x",
          log,
        }),
        /FEE_WALLET/,
      );
    assert.equal(await local.getTransactionCount(wallet.address), nonce);
  });

  it("never prints or stores the private key, and accepts a separate fee wallet", async () => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "wbmb-deploy-"));
    const other = Wallet.createRandom().address;
    const r = await deployBsc({
      rpcUrl: url,
      secret: wallet.privateKey,
      feeWallet: other,
      broadcast: true,
      outDir,
      confirmations: 1,
      log,
    });
    assert.equal(r.feeWallet, other);
    const everything =
      logs.join("\n") + fs.readFileSync(path.join(outDir, "bsc.json"), "utf8");
    assert.equal(everything.includes(wallet.privateKey.slice(2)), false);
  });

  it("loads mnemonics and rejects unreadable keys without echoing them", async () => {
    const phrase = Wallet.createRandom().mnemonic.phrase;
    assert.ok(
      (await loadDeployer(phrase, local).getAddress()).startsWith("0x"),
    );
    assert.equal(loadDeployer("", local), null);
    assert.throws(
      () => loadDeployer("not-a-real-key-123", local),
      (e) =>
        !e.message.includes("not-a-real-key-123") &&
        /키를 읽을 수 없습니다/.test(e.message),
    );
  });
});
