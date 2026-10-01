// Builds the static site for the live BSC deployment recorded in deployments/bsc.json.
import fs from "node:fs";
import { build } from "vite";
import { compile } from "./compile.mjs";
import { liveWebConfig } from "./deploy-bsc.mjs";

if (!fs.existsSync("deployments/bsc.json"))
  throw new Error(
    "deployments/bsc.json 이 없습니다. 먼저 npm run deploy:bsc -- --broadcast 로 배포하세요.",
  );
compile();
const record = JSON.parse(fs.readFileSync("deployments/bsc.json", "utf8"));
const publicDir = ".local/web-live";
fs.mkdirSync(publicDir, { recursive: true });
// Only the lending ABI is needed live; mock ABIs stay out of the bundle.
const abis = JSON.parse(fs.readFileSync("public/abis.json", "utf8"));
fs.writeFileSync(
  `${publicDir}/abis.json`,
  JSON.stringify({ P2PLending: abis.P2PLending }) + "\n",
);
fs.writeFileSync(
  `${publicDir}/deployment.json`,
  JSON.stringify(liveWebConfig(record, process.env.BSC_RPC_URL), null, 2) +
    "\n",
);
await build({ publicDir, build: { outDir: "dist-live", emptyOutDir: true } });
console.log(
  "\n실서비스용 정적 파일: dist-live/ (컨트랙트 " + record.lending + ")",
);
