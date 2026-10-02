import { network } from "hardhat";
import { JsonRpcProvider } from "ethers";
import { createServer } from "vite";
import { compile } from "./compile.mjs";
import {
  deployFixture,
  deployFixedFixture,
  deployCouncilFixture,
  saveDeployment,
} from "./deploy.mjs";
import fs from "node:fs";
import path from "node:path";

compile();
const rpcPort = Number(process.env.RPC_PORT || 18545);
const appPort = Number(process.env.APP_PORT || 5180);
const rpc = await network.createServer(undefined, "127.0.0.1", rpcPort);
await rpc.listen();
const url = `http://127.0.0.1:${rpcPort}`;
const provider = new JsonRpcProvider(url, undefined, { cacheTimeout: -1 });
provider.pollingInterval = 50;
let web;
async function stop() {
  if (web) await web.close();
  provider.destroy();
  await rpc.close();
}
try {
  // MARKET=fixed runs the oracle-free market, MARKET=council the council-price market.
  const fixture =
    process.env.MARKET === "fixed"
      ? await deployFixedFixture(provider, { seed: true })
      : process.env.MARKET === "council"
        ? await deployCouncilFixture(provider, { seed: true })
        : await deployFixture(provider, { seed: true });
  const publicDir = path.resolve(`.local/web-${appPort}`);
  fs.mkdirSync(publicDir, { recursive: true });
  fs.copyFileSync("public/abis.json", path.join(publicDir, "abis.json"));
  saveDeployment(fixture, url, path.join(publicDir, "deployment.json"));
  if (appPort === 5180) saveDeployment(fixture, url);
  web = await createServer({
    publicDir,
    server: { host: "127.0.0.1", port: appPort, strictPort: true },
  });
  await web.listen();
  console.log(
    `\nWBMB P2P 로컬 체험: http://127.0.0.1:${appPort}\nRPC: ${url} (chain 31337)\n모의 토큰만 사용합니다. 종료 후 체인 상태는 사라집니다.\n`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => stop().then(() => process.exit(0)));
} catch (e) {
  await stop();
  throw e;
}
