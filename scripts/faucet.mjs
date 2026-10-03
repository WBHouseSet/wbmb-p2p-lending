import fs from "node:fs";
import {
  Contract,
  JsonRpcProvider,
  isAddress,
  parseUnits,
  toQuantity,
} from "ethers";
import { assertLocal, artifact } from "./deploy.mjs";

const destination = process.argv[2];
if (!isAddress(destination))
  throw new Error(
    "사용법: node scripts/faucet.mjs 0xPUBLIC_ADDRESS (개인키 입력 금지)",
  );
const config = JSON.parse(
  fs.readFileSync(
    process.env.DEPLOYMENT_FILE || "public/deployment.json",
    "utf8",
  ),
);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(
    new URL(config.rpcUrl).hostname,
  ) ||
  config.demo !== true
)
  throw new Error("로컬 모의 배포만 허용합니다.");
const provider = new JsonRpcProvider(config.rpcUrl, undefined, {
  cacheTimeout: -1,
});
provider.pollingInterval = 50;
try {
  await assertLocal(provider);
  const signer = await provider.getSigner(0);
  await provider.send("hardhat_setBalance", [
    destination,
    toQuantity(parseUnits("10", 18)),
  ]);
  for (const [token, value, decimals] of [
    ["movn", "10000", 18],
    ["wbmb", "100", 8],
  ]) {
    const c = new Contract(
      config.addresses[token],
      artifact("MockToken").abi,
      signer,
    );
    await (await c.mint(destination, parseUnits(value, decimals))).wait();
  }
  console.log(
    `${destination}: 로컬 가스 10 ETH, 모의 10,000 MOVN / 100 WBMB 지급 완료`,
  );
} finally {
  provider.destroy();
}
