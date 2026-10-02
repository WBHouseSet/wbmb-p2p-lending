// Rehearsal of the LIVE web mode: a local chain reporting chain id 56 with the real
// USDT/WBMB bytecode, the contract deployed by the real deploy script (throwaway key),
// and the page running with demo=false. Nothing is sent to mainnet.
import fs from "node:fs";
import path from "node:path";
import { network } from "hardhat";
import {
  AbiCoder,
  Contract,
  JsonRpcProvider,
  Wallet,
  keccak256,
  toBeHex,
} from "ethers";
import { createServer } from "vite";
import { compile } from "./compile.mjs";
import {
  deployBsc,
  liveAbiNames,
  livePinned,
  liveWebConfig,
} from "./deploy-bsc.mjs";
import { relayCouncil } from "./relay-council.mjs";
import { us, wb } from "./deploy.mjs";
import { BSC } from "../config/bsc.mjs";

compile();
const rpcPort = Number(process.env.RPC_PORT || 18557);
const appPort = Number(process.env.APP_PORT || 5184);
const url = `http://127.0.0.1:${rpcPort}`;
const rpc = await network.createServer("bscReplica", "127.0.0.1", rpcPort);
await rpc.listen();
const local = new JsonRpcProvider(url, 56, {
  staticNetwork: true,
  cacheTimeout: -1,
});
const real = new JsonRpcProvider(process.env.BSC_RPC_URL || BSC.rpcUrl, 56, {
  staticNetwork: true,
});
const BALANCE = ["function balanceOf(address) view returns (uint256)"];
async function give(token, who, amount) {
  const c = new Contract(token, BALANCE, local);
  for (let slot = 0; slot < 16; slot++) {
    const key = keccak256(
      AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [who, slot]),
    );
    const old = await local.getStorage(token, key);
    await local.send("hardhat_setStorageAt", [token, key, toBeHex(amount, 32)]);
    if ((await c.balanceOf(who)) === amount) return;
    await local.send("hardhat_setStorageAt", [token, key, old]);
  }
  throw new Error("balance slot not found");
}
let web;
try {
  for (const token of [BSC.usdt, BSC.wbmb]) {
    await local.send("hardhat_setCode", [token, await real.getCode(token)]);
    for (let slot = 0; slot < 16; slot++) {
      const value = await real.getStorage(token, slot);
      if (BigInt(value) !== 0n)
        await local.send("hardhat_setStorageAt", [token, toBeHex(slot), value]);
    }
  }
  real.destroy();
  // The rehearsal chain starts empty each run, so its previous record is meaningless.
  fs.rmSync(`.local/rehearsal-${appPort}`, { recursive: true, force: true });
  const deployer = Wallet.createRandom();
  await local.send("hardhat_setBalance", [
    deployer.address,
    "0x16345785D8A0000",
  ]);
  const councilMarket = process.env.MARKET === "council";
  // Throwaway reporter: the council market is rehearsed with the real relay code.
  const reporter = Wallet.createRandom();
  if (councilMarket)
    await local.send("hardhat_setBalance", [
      reporter.address,
      "0x16345785D8A0000",
    ]);
  const record = await deployBsc({
    rpcUrl: url,
    secret: deployer.privateKey,
    broadcast: true,
    confirmations: 1,
    outDir: `.local/rehearsal-${appPort}`,
    ...(councilMarket
      ? { profile: "council", reporter: reporter.address }
      : {}),
  });
  // The first price comes from the real relay with a fixed API answer, so the rehearsal
  // never depends on the live API. confirmedAt is in the past: the chain follows the real clock.
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
  const accounts = await local.send("eth_accounts", []);
  for (const who of accounts.slice(1, 3)) {
    await give(BSC.usdt, who, us(5000));
    await give(BSC.wbmb, who, wb(50));
  }
  const publicDir = path.resolve(`.local/web-${appPort}`);
  fs.mkdirSync(publicDir, { recursive: true });
  const abis = JSON.parse(fs.readFileSync("public/abis.json", "utf8"));
  fs.writeFileSync(
    path.join(publicDir, "abis.json"),
    JSON.stringify(
      Object.fromEntries(
        liveAbiNames(record).map((name) => [name, abis[name]]),
      ),
    ) + "\n",
  );
  fs.writeFileSync(
    path.join(publicDir, "deployment.json"),
    JSON.stringify(liveWebConfig(record, url), null, 2) + "\n",
  );
  web = await createServer({
    publicDir,
    define: {
      __PINNED__: JSON.stringify(livePinned(record)),
    },
    server: { host: "127.0.0.1", port: appPort, strictPort: true },
  });
  await web.listen();
  console.log(
    `\n실서비스 화면 리허설: http://127.0.0.1:${appPort} (로컬 체인 id 56, 실제 토큰 코드 복제)\n`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await web.close();
      local.destroy();
      await rpc.close();
      process.exit(0);
    });
} catch (e) {
  if (web) await web.close();
  local.destroy();
  await rpc.close();
  throw e;
}
