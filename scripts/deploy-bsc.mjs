// Deploys the oracle-free P2PLending market to BNB Smart Chain mainnet (chain 56).
//
//   Dry run (no key needed, sends nothing):   npm run deploy:bsc
//   Dry run with your wallet's numbers:       DEPLOYER_KEY_FILE=/path/key npm run deploy:bsc
//   Real deployment (spends real BNB):        DEPLOYER_KEY_FILE=/path/key npm run deploy:bsc -- --broadcast
//
// The key file holds a hex private key or a mnemonic. It is read at run time, never
// printed, never written anywhere. FEE_WALLET defaults to the deployer address.
import fs from "node:fs";
import path from "node:path";
import {
  Contract,
  ContractFactory,
  HDNodeWallet,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  formatUnits,
  getAddress,
  isAddress,
} from "ethers";
import { BSC } from "../config/bsc.mjs";
import { artifact } from "./deploy.mjs";

const TOKEN_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export function loadDeployer(secret, provider) {
  const text = String(secret || "").trim();
  if (!text) return null;
  try {
    return text.includes(" ")
      ? HDNodeWallet.fromPhrase(text).connect(provider)
      : new Wallet(text.startsWith("0x") ? text : "0x" + text, provider);
  } catch {
    // Never echo the secret or the library's message, which may quote it.
    throw new Error(
      "배포 지갑 키를 읽을 수 없습니다. 16진수 개인키 또는 니모닉이어야 합니다.",
    );
  }
}

export async function deployBsc({
  rpcUrl = BSC.rpcUrl,
  secret,
  feeWallet,
  broadcast = false,
  outDir = "deployments",
  confirmations = 3,
  log = console.log,
} = {}) {
  const provider = new JsonRpcProvider(rpcUrl, BSC.chainId, {
    staticNetwork: true,
  });
  try {
    if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(BSC.chainId))
      throw new Error("RPC가 BNB Smart Chain(56)이 아닙니다.");
    for (const [name, address, decimals] of [
      ["USDT", BSC.usdt, 18n],
      ["WBMB", BSC.wbmb, 8n],
    ]) {
      const token = new Contract(address, TOKEN_ABI, provider);
      if (
        (await provider.getCode(address)) === "0x" ||
        (await token.decimals()) !== decimals
      )
        throw new Error(`${name} 토큰 확인 실패: ${address}`);
      log(
        `토큰 확인  ${name} ${address} (${await token.symbol()}, ${decimals} decimals)`,
      );
    }
    const deployer = loadDeployer(secret, provider);
    const from = deployer ? await deployer.getAddress() : null;
    const fee = feeWallet ? getAddress(feeWallet) : from;
    if (feeWallet && !isAddress(feeWallet))
      throw new Error("FEE_WALLET 주소가 올바르지 않습니다.");
    const args = [
      BSC.usdt,
      BSC.wbmb,
      ZeroAddress,
      fee || "0x000000000000000000000000000000000000dEaD",
      BSC.feeBps,
    ];
    const a = artifact("P2PLending");
    const factory = new ContractFactory(
      a.abi,
      a.bytecode,
      deployer || provider,
    );
    const request = await factory.getDeployTransaction(...args);
    const gas = await provider.estimateGas({
      ...request,
      from: from || undefined,
    });
    const gasPrice = (await provider.getFeeData()).gasPrice;
    const cost = gas * gasPrice;
    log(
      `배포 가스  ${gas} × ${formatUnits(gasPrice, 9)} gwei ≈ ${formatUnits(cost, 18)} BNB`,
    );
    if (!deployer) {
      log("키가 없어 예상 비용만 계산했습니다. 아무것도 전송하지 않았습니다.");
      return { broadcast: false, gas, gasPrice, cost };
    }
    const balance = await provider.getBalance(from);
    log(`배포 지갑  ${from} · 잔액 ${formatUnits(balance, 18)} BNB`);
    log(`수수료 지갑 ${fee}${fee === from ? " (배포 지갑과 동일)" : ""}`);
    if (!broadcast) {
      log(
        "--broadcast 가 없어 전송하지 않았습니다. 위 내용이 맞으면 --broadcast 를 붙여 다시 실행하세요.",
      );
      return {
        broadcast: false,
        from,
        feeWallet: fee,
        gas,
        gasPrice,
        cost,
        balance,
      };
    }
    if (balance < (cost * 12n) / 10n)
      throw new Error(
        `BNB 잔액 부족: 최소 ${formatUnits((cost * 12n) / 10n, 18)} BNB 필요`,
      );
    const contract = await factory.deploy(...args, {
      gasLimit: (gas * 12n) / 10n,
      gasPrice,
    });
    const hash = contract.deploymentTransaction().hash;
    log(`전송됨     ${hash} · 확정 대기 중…`);
    const receipt = await contract.deploymentTransaction().wait(confirmations);
    if (receipt.status !== 1) throw new Error("배포 거래가 실패했습니다.");
    const address = await contract.getAddress();
    // Read back what was actually deployed instead of trusting the inputs.
    const [usdt, wbmb, policy, vault, feeBps] = await Promise.all([
      contract.usdt(),
      contract.wbmb(),
      contract.pricePolicy(),
      contract.feeVault(),
      contract.feeBps(),
    ]);
    if (
      usdt !== BSC.usdt ||
      wbmb !== BSC.wbmb ||
      policy !== ZeroAddress ||
      vault !== fee ||
      feeBps !== BigInt(BSC.feeBps)
    )
      throw new Error(
        "배포된 컨트랙트의 설정이 예상과 다릅니다. 사용하지 마세요: " + address,
      );
    const record = {
      network: "bsc",
      chainId: BSC.chainId,
      lending: address,
      deployer: from,
      feeWallet: fee,
      feeBps: BSC.feeBps,
      usdt: BSC.usdt,
      wbmb: BSC.wbmb,
      pricePolicy: ZeroAddress,
      txHash: hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      deployedAt: new Date().toISOString(),
      compiler: {
        solc: "0.8.37",
        optimizerRuns: 200,
        viaIR: true,
        evmVersion: "cancun",
      },
      constructorArgs: args.map(String),
    };
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, "bsc.json"),
      JSON.stringify(record, null, 2) + "\n",
    );
    log(`배포 완료  ${address} (블록 ${receipt.blockNumber})`);
    log(`기록       ${path.join(outDir, "bsc.json")}`);
    return { broadcast: true, ...record };
  } finally {
    provider.destroy();
  }
}

/// Web config for a live deployment record (what the page fetches as /deployment.json).
export function liveWebConfig(record, rpcUrl = BSC.rpcUrl) {
  return {
    version: 2,
    demo: false,
    oracleFree: true,
    chainId: record.chainId,
    rpcUrl,
    deployedAt: record.deployedAt,
    feeWallet: record.feeWallet,
    feeBps: record.feeBps,
    addresses: {
      usdt: record.usdt,
      wbmb: record.wbmb,
      lending: record.lending,
    },
  };
}

if (process.argv[1]?.endsWith("deploy-bsc.mjs")) {
  const file = process.env.DEPLOYER_KEY_FILE;
  const secret = file
    ? fs.readFileSync(file, "utf8")
    : process.env.DEPLOYER_KEY;
  deployBsc({
    rpcUrl: process.env.BSC_RPC_URL || BSC.rpcUrl,
    secret,
    feeWallet: process.env.FEE_WALLET,
    broadcast: process.argv.includes("--broadcast"),
  }).catch((e) => {
    console.error("실패:", e.shortMessage || e.message);
    process.exit(1);
  });
}
