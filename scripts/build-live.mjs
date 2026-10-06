// Builds the static site for a live BSC deployment record (RECORD, default
// deployments/bsc-movn.json) into OUT_DIR (default dist-live).
import fs from "node:fs";
import { build } from "vite";
import { compile } from "./compile.mjs";
import { liveAbiNames, livePinned, liveWebConfig } from "./deploy-bsc.mjs";

const recordFile = process.env.RECORD || "deployments/bsc-movn.json";
if (!fs.existsSync(recordFile))
  throw new Error(
    `${recordFile} 이 없습니다. 해당 마켓을 먼저 배포해야 합니다 (배포 방법은 docs/MAINNET.md 참고).`,
  );
compile();
const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
const outDir = process.env.OUT_DIR || "dist-live";
const publicDir = ".local/web-live";
fs.mkdirSync(publicDir, { recursive: true });
// Only the lending ABI (and the price policy for a council market) is needed live;
// mock ABIs stay out of the bundle.
const abis = JSON.parse(fs.readFileSync("public/abis.json", "utf8"));
fs.writeFileSync(
  `${publicDir}/abis.json`,
  JSON.stringify(
    Object.fromEntries(liveAbiNames(record).map((name) => [name, abis[name]])),
  ) + "\n",
);
const web = liveWebConfig(record, process.env.BSC_RPC_URL);
fs.writeFileSync(
  `${publicDir}/deployment.json`,
  JSON.stringify(web, null, 2) + "\n",
);
// Addresses and the RPC endpoint are compiled into the bundle; the page refuses a
// deployment.json that differs. Changing the endpoint therefore means building again.
await build({
  publicDir,
  define: {
    __PINNED__: JSON.stringify(livePinned(record, web.rpcUrl)),
    // QR (WalletConnect) connection is offered only when a project id is given at build time.
    __WC_PROJECT_ID__: JSON.stringify(
      process.env.WALLETCONNECT_PROJECT_ID || "",
    ),
  },
  build: { outDir, emptyOutDir: true },
});
console.log(
  `\n실서비스용 정적 파일: ${outDir}/ (컨트랙트 ` + record.lending + ")",
);
