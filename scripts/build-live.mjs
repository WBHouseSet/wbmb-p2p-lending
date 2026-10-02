// Builds the static site for a live BSC deployment record (RECORD, default
// deployments/bsc.json) into OUT_DIR (default dist-live).
import fs from "node:fs";
import { build } from "vite";
import { compile } from "./compile.mjs";
import { liveWebConfig } from "./deploy-bsc.mjs";

const recordFile = process.env.RECORD || "deployments/bsc.json";
if (!fs.existsSync(recordFile))
  throw new Error(
    `${recordFile} 이 없습니다. 먼저 npm run deploy:bsc -- --broadcast 로 배포하세요.`,
  );
compile();
const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
const outDir = process.env.OUT_DIR || "dist-live";
const council = record.pricePolicy && BigInt(record.pricePolicy) !== 0n;
const publicDir = ".local/web-live";
fs.mkdirSync(publicDir, { recursive: true });
// Only the lending ABI (and the price policy for a council market) is needed live;
// mock ABIs stay out of the bundle.
const abis = JSON.parse(fs.readFileSync("public/abis.json", "utf8"));
fs.writeFileSync(
  `${publicDir}/abis.json`,
  JSON.stringify({
    P2PLending: abis.P2PLending,
    ...(council ? { CouncilPricePolicy: abis.CouncilPricePolicy } : {}),
  }) + "\n",
);
fs.writeFileSync(
  `${publicDir}/deployment.json`,
  JSON.stringify(liveWebConfig(record, process.env.BSC_RPC_URL), null, 2) +
    "\n",
);
// Addresses are compiled into the bundle; the page refuses a deployment.json that differs.
const pinned = {
  chainId: record.chainId,
  lending: record.lending,
  usdt: record.usdt,
  wbmb: record.wbmb,
  feeWallet: record.feeWallet,
  ...(council ? { oracle: record.pricePolicy } : {}),
};
await build({
  publicDir,
  define: { __PINNED__: JSON.stringify(pinned) },
  build: { outDir, emptyOutDir: true },
});
console.log(
  `\n실서비스용 정적 파일: ${outDir}/ (컨트랙트 ` + record.lending + ")",
);
