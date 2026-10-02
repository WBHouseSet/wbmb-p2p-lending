// Rehearses scripts/deploy-bsc.mjs end to end on a local chain that reports chain id 56 and
// carries the real USDT/WBMB bytecode. Uses a throwaway key. Nothing is sent to mainnet.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { network } from "hardhat";
import {
  HDNodeWallet,
  Contract,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  toBeHex,
} from "ethers";
import { BSC } from "../../config/bsc.mjs";
import {
  deployBsc,
  liveAbiNames,
  livePinned,
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
    // The pin compiled into the bundle carries no price contract for this market.
    assert.deepEqual(Object.keys(livePinned(record)), [
      "chainId",
      "lending",
      "usdt",
      "wbmb",
      "feeWallet",
    ]);
    assert.deepEqual(liveAbiNames(record), ["P2PLending"]);
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

  it("a mnemonic needs an explicit wallet index and expected address, so the first wallet is never used by accident", async () => {
    const phrase = Wallet.createRandom().mnemonic.phrase;
    const at = (n) =>
      HDNodeWallet.fromPhrase(phrase, undefined, `m/44'/60'/0'/0/${n}`).address;
    assert.equal(await loadDeployer(phrase, local, 1).getAddress(), at(1));
    assert.notEqual(at(0), at(1));
    // comment lines in a key file are ignored
    assert.equal(
      await loadDeployer(`# backup\n\n${phrase}\n`, local, 1).getAddress(),
      at(1),
    );
    // no expected address: refused, whatever the index
    await assert.rejects(
      deployBsc({ rpcUrl: url, secret: phrase, index: 1, log }),
      /DEPLOYER_EXPECT/,
    );
    // expected address of the second wallet, but the default (first) index would sign: refused
    await assert.rejects(
      deployBsc({ rpcUrl: url, secret: phrase, expectAddress: at(1), log }),
      /서명 지갑이 예상 주소와 다릅니다/,
    );
    const r = await deployBsc({
      rpcUrl: url,
      secret: phrase,
      index: 1,
      expectAddress: at(1),
      log,
    });
    assert.equal(r.from, at(1));
    assert.equal(r.broadcast, false);
    assert.equal(logs.join("\n").includes(phrase), false);
  });

  it("the test profile deploys a separate market with 5-minute minimums and its own record", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbmb-deploy-"));
    await assert.rejects(
      deployBsc({
        rpcUrl: url,
        secret: wallet.privateKey,
        profile: "nope",
        outDir: dir,
        log,
      }),
      /profile/,
    );
    const r = await deployBsc({
      rpcUrl: url,
      secret: wallet.privateKey,
      profile: "test",
      broadcast: true,
      outDir: dir,
      confirmations: 1,
      log,
    });
    assert.equal(fs.existsSync(path.join(dir, "bsc.json")), false);
    const record = JSON.parse(
      fs.readFileSync(path.join(dir, "bsc-test.json"), "utf8"),
    );
    assert.equal(record.profile, "test");
    assert.deepEqual([record.minDuration, record.minGrace], [300, 300]);
    const lending = new Contract(r.lending, artifact("P2PLending").abi, local);
    assert.equal(await lending.minDuration(), 300n);
    assert.equal(await lending.minGrace(), 300n);
    // the main profile keeps the safe limits
    const main = await deployBsc({
      rpcUrl: url,
      secret: wallet.privateKey,
      broadcast: true,
      outDir: dir,
      confirmations: 1,
      log,
    });
    const mainLending = new Contract(
      main.lending,
      artifact("P2PLending").abi,
      local,
    );
    assert.equal(await mainLending.minDuration(), 3600n);
    assert.equal(await mainLending.minGrace(), 86400n);
    fs.rmSync(dir, { recursive: true, force: true });
  });

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
    // The pin of a council record names the price contract.
    assert.equal(livePinned(record).oracle, record.pricePolicy);
    assert.deepEqual(liveAbiNames(record), [
      "P2PLending",
      "CouncilPricePolicy",
    ]);
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
});
