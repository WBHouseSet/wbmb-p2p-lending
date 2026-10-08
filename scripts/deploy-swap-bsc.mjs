// Deploys the WBMB/MOVN trade board (P2PSwap) to BNB Smart Chain mainnet (chain 56).
//
//   Dry run (no key needed, sends nothing):   FEE_WALLET=0x… npm run deploy:bsc:swap
//   Dry run with your wallet's numbers:       DEPLOYER_KEY_FILE=/path/key FEE_WALLET=0x… npm run deploy:bsc:swap
//   Real deployment (spends real BNB):        DEPLOYER_KEY_FILE=/path/key FEE_WALLET=0x… npm run deploy:bsc:swap -- --broadcast
//
// The small-amount test board is the default and is recorded in deployments/bsc-swap-test.json;
// --main records the board for real use in deployments/bsc-swap.json. The two differ only in
// that file: the contract has no time limits to shorten.
// FEE_WALLET receives the trade fees for good and has no default. The key rules
// (DEPLOYER_INDEX / DEPLOYER_EXPECT, never printed or stored) are those of deploy-bsc.mjs.
import fs from "node:fs";
import path from "node:path";
import {
  ContractFactory,
  JsonRpcProvider,
  formatUnits,
  getAddress,
} from "ethers";
import { BSC } from "../config/bsc.mjs";
import { artifact } from "./deploy.mjs";
import { compile } from "./compile.mjs";
import { checkedDeployer, ownWallet, verifyTokens } from "./deploy-bsc.mjs";

export const SWAP_PROFILES = {
  test: { file: "bsc-swap-test.json" },
  main: { file: "bsc-swap.json" },
};

export async function deploySwapBsc({
  profile = "test",
  rpcUrl = BSC.rpcUrl,
  secret,
  index = 0,
  expectAddress,
  feeWallet,
  broadcast = false,
  outDir = "deployments",
  confirmations = 3,
  log = console.log,
} = {}) {
  const provider = new JsonRpcProvider(rpcUrl, BSC.chainId, {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  try {
    if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(BSC.chainId))
      throw new Error("RPC가 BNB Smart Chain(56)이 아닙니다.");
    if (!Object.hasOwn(SWAP_PROFILES, profile))
      throw new Error("알 수 없는 profile 입니다.");
    await verifyTokens(provider, log);
    const deployer = await checkedDeployer(
      secret,
      provider,
      index,
      expectAddress,
    );
    // Trade fees can never be redirected after deployment, so the wallet is always named.
    if (!ownWallet(feeWallet))
      throw new Error(
        "FEE_WALLET 에 직거래 수수료를 받을 지갑 주소를 지정해야 합니다. 직접 관리하는 지갑이어야 합니다.",
      );
    const fee = getAddress(feeWallet);
    const from = deployer ? await deployer.getAddress() : null;
    const recordFile = path.join(outDir, SWAP_PROFILES[profile].file);
    if (broadcast && fs.existsSync(recordFile))
      throw new Error(
        `이미 배포 기록이 있습니다: ${recordFile}. 다시 배포하려면 이 파일을 먼저 다른 곳으로 옮기세요.`,
      );
    const args = [BSC.movn, BSC.wbmb, fee, BSC.swapFeeBps];
    const a = artifact("P2PSwap");
    const factory = new ContractFactory(
      a.abi,
      a.bytecode,
      deployer || provider,
    );
    const gas = await provider.estimateGas({
      ...(await factory.getDeployTransaction(...args)),
      from: from || undefined,
    });
    const gasPrice = (await provider.getFeeData()).gasPrice;
    const cost = gas * gasPrice;
    log(
      `배포 가스  ${gas} × ${formatUnits(gasPrice, 9)} gwei ≈ ${formatUnits(cost, 18)} BNB`,
    );
    log(`수수료 지갑 ${fee} · 수수료 ${BSC.swapFeeBps / 100}%`);
    if (!deployer) {
      log("키가 없어 예상 비용만 계산했습니다. 아무것도 전송하지 않았습니다.");
      return { broadcast: false, gas, gasPrice, cost };
    }
    const balance = await provider.getBalance(from);
    log(`배포 지갑  ${from} · 잔액 ${formatUnits(balance, 18)} BNB`);
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
    // Printed before any further RPC call so the address is never lost to a flaky read.
    log(`컨트랙트   ${address} (블록 ${receipt.blockNumber}) · 설정 확인 중…`);
    // Read back what was actually deployed instead of trusting the inputs.
    const [movn, wbmb, vault, feeBps] = await Promise.all([
      contract.movn(),
      contract.wbmb(),
      contract.feeVault(),
      contract.feeBps(),
    ]);
    if (
      movn !== BSC.movn ||
      wbmb !== BSC.wbmb ||
      vault !== fee ||
      feeBps !== BigInt(BSC.swapFeeBps)
    )
      throw new Error(
        "배포된 컨트랙트의 설정이 예상과 다릅니다. 사용하지 마세요: " + address,
      );
    const record = {
      network: "bsc",
      chainId: BSC.chainId,
      swap: address,
      deployer: from,
      feeWallet: fee,
      feeBps: BSC.swapFeeBps,
      profile,
      movn: BSC.movn,
      wbmb: BSC.wbmb,
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
    fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + "\n");
    log(`배포 완료  ${address} (블록 ${receipt.blockNumber})`);
    log(`기록       ${recordFile}`);
    return { broadcast: true, ...record };
  } finally {
    provider.destroy();
  }
}

if (process.argv[1]?.endsWith("deploy-swap-bsc.mjs")) {
  compile(); // never deploy a stale artifact
  const file = process.env.DEPLOYER_KEY_FILE;
  const secret = file
    ? fs.readFileSync(file, "utf8")
    : process.env.DEPLOYER_KEY;
  deploySwapBsc({
    rpcUrl: process.env.BSC_RPC_URL || BSC.rpcUrl,
    secret,
    index: Number(process.env.DEPLOYER_INDEX || 0),
    expectAddress: process.env.DEPLOYER_EXPECT,
    feeWallet: process.env.FEE_WALLET,
    broadcast: process.argv.includes("--broadcast"),
    profile: process.argv.includes("--main") ? "main" : "test",
  }).catch((e) => {
    console.error("실패:", e.shortMessage || e.message);
    process.exit(1);
  });
}
