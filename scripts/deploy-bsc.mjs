// Deploys a P2PLending market to BNB Smart Chain mainnet (chain 56): oracle-free by default,
// or with the council price policy (--council, needs REPORTER=0x…).
//
//   Dry run (no key needed, sends nothing):   npm run deploy:bsc
//   Dry run with your wallet's numbers:       DEPLOYER_KEY_FILE=/path/key npm run deploy:bsc
//   Real deployment (spends real BNB):        DEPLOYER_KEY_FILE=/path/key npm run deploy:bsc -- --broadcast
//
// For a mnemonic, DEPLOYER_INDEX picks the wallet (1 = second) and DEPLOYER_EXPECT must be
// that wallet's address; the script refuses to sign with any other address.
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
import { compile } from "./compile.mjs";
import { COUNCIL_POLICY_ID } from "../src/council-signing.mjs";

const TOKEN_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export const isMnemonic = (text) => text.includes(" ");
// First line of a key file that is not blank or a `#` comment.
export const secretLine = (secret) =>
  String(secret || "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#")) || "";

/// `index` selects the wallet of a mnemonic (0 = first, 1 = second, as wallet apps list them).
export function loadDeployer(secret, provider, index = 0) {
  const text = secretLine(secret);
  if (!text) return null;
  if (!Number.isInteger(index) || index < 0 || index > 99)
    throw new Error("DEPLOYER_INDEX 는 0~99 사이 정수여야 합니다.");
  try {
    return isMnemonic(text)
      ? HDNodeWallet.fromPhrase(
          text,
          undefined,
          `m/44'/60'/0'/0/${index}`,
        ).connect(provider)
      : new Wallet(text.startsWith("0x") ? text : "0x" + text, provider);
  } catch {
    // Never echo the secret or the library's message, which may quote it.
    throw new Error(
      "배포 지갑 키를 읽을 수 없습니다. 16진수 개인키 또는 니모닉이어야 합니다.",
    );
  }
}

// "main" is the oracle-free market for real use. "test" differs only in short minimums, so a
// full default-and-settle cycle can be checked in minutes. The council profiles add a price
// policy fed by the council price relay.
export const PROFILES = {
  main: { file: "bsc.json", minDuration: 3600, minGrace: 86400 },
  test: { file: "bsc-test.json", minDuration: 300, minGrace: 300 },
  council: {
    file: "bsc-council.json",
    minDuration: 3600,
    minGrace: 86400,
    council: BSC.council,
  },
  "council-test": {
    file: "bsc-council-test.json",
    minDuration: 300,
    minGrace: 300,
    council: { ...BSC.council, minInterval: 300, staleSettleDelay: 300 },
  },
};

export async function deployBsc({
  profile = "main",
  rpcUrl = BSC.rpcUrl,
  secret,
  index = 0,
  expectAddress,
  feeWallet,
  reporter,
  broadcast = false,
  outDir = "deployments",
  confirmations = 3,
  log = console.log,
} = {}) {
  const provider = new JsonRpcProvider(rpcUrl, BSC.chainId, {
    staticNetwork: true,
    // Two deployments follow each other: a cached pending nonce would make the second reuse it.
    cacheTimeout: -1,
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
    const deployer = loadDeployer(secret, provider, index);
    if (deployer) {
      // A mnemonic holds many wallets (the first may be a busy trading wallet). The caller
      // must name the one they mean, and nothing proceeds unless the key resolves to it.
      if (isMnemonic(secretLine(secret)) && !expectAddress)
        throw new Error(
          "니모닉을 쓸 때는 DEPLOYER_EXPECT 에 사용할 지갑 주소를 반드시 지정해야 합니다.",
        );
      if (
        expectAddress &&
        (!isAddress(expectAddress) ||
          getAddress(expectAddress) !== (await deployer.getAddress()))
      )
        throw new Error(
          "서명 지갑이 예상 주소와 다릅니다. DEPLOYER_INDEX 와 DEPLOYER_EXPECT 를 확인하세요. 아무것도 전송하지 않았습니다.",
        );
    }
    const from = deployer ? await deployer.getAddress() : null;
    if (
      feeWallet !== undefined &&
      (!isAddress(feeWallet) ||
        [BSC.usdt, BSC.wbmb, ZeroAddress].includes(getAddress(feeWallet)))
    )
      throw new Error(
        "FEE_WALLET 주소가 올바르지 않습니다. 직접 관리하는 지갑 주소여야 합니다.",
      );
    const fee = feeWallet ? getAddress(feeWallet) : from;
    if (!Object.hasOwn(PROFILES, profile))
      throw new Error("알 수 없는 profile 입니다.");
    const limits = PROFILES[profile];
    const cp = limits.council;
    if (
      cp &&
      (!isAddress(reporter) ||
        [BSC.usdt, BSC.wbmb, ZeroAddress].includes(getAddress(reporter)))
    )
      throw new Error(
        "REPORTER 에 가격 중계 지갑 주소를 지정해야 합니다. 직접 관리하는 지갑이어야 합니다.",
      );
    const policyArgs = cp && [
      [getAddress(reporter)],
      1,
      COUNCIL_POLICY_ID,
      cp.maxAge,
      cp.maxChangeBps,
      cp.minInterval,
    ];
    const policyArtifact = cp && artifact("CouncilPricePolicy");
    const policyFactory =
      cp &&
      new ContractFactory(
        policyArtifact.abi,
        policyArtifact.bytecode,
        deployer || provider,
      );
    const recordFile = path.join(outDir, limits.file);
    if (broadcast && fs.existsSync(recordFile))
      throw new Error(
        `이미 배포 기록이 있습니다: ${recordFile}. 다시 배포하려면 이 파일을 먼저 다른 곳으로 옮기세요.`,
      );
    // Before the policy exists, a token address stands in so gas can still be estimated.
    const lendingArgs = (policyAddress) => [
      BSC.usdt,
      BSC.wbmb,
      cp ? policyAddress : ZeroAddress,
      fee || "0x000000000000000000000000000000000000dEaD",
      BSC.feeBps,
      limits.minDuration,
      limits.minGrace,
      cp ? cp.liquidationBonusBps : 0,
      cp ? cp.staleSettleDelay : 0,
    ];
    let args = lendingArgs(BSC.usdt);
    const a = artifact("P2PLending");
    const factory = new ContractFactory(
      a.abi,
      a.bytecode,
      deployer || provider,
    );
    const request = await factory.getDeployTransaction(...args);
    const lendingGas = await provider.estimateGas({
      ...request,
      from: from || undefined,
    });
    const policyGas = cp
      ? await provider.estimateGas({
          ...(await policyFactory.getDeployTransaction(...policyArgs)),
          from: from || undefined,
        })
      : 0n;
    const gas = lendingGas + policyGas;
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
    let policyAddress = ZeroAddress,
      policyTxHash = null;
    if (cp) {
      const policy = await policyFactory.deploy(...policyArgs, {
        gasLimit: (policyGas * 12n) / 10n,
        gasPrice,
      });
      policyTxHash = policy.deploymentTransaction().hash;
      log(`가격 컨트랙트 전송됨 ${policyTxHash} · 확정 대기 중…`);
      const policyReceipt = await policy
        .deploymentTransaction()
        .wait(confirmations);
      if (policyReceipt.status !== 1)
        throw new Error("가격 컨트랙트 배포 거래가 실패했습니다.");
      policyAddress = await policy.getAddress();
      // Printed at once: if the next step fails this address is still on record in the log.
      log(`가격 컨트랙트 ${policyAddress} (블록 ${policyReceipt.blockNumber})`);
      const [isRep, threshold, maxAge, maxChange, minInterval] =
        await Promise.all([
          policy.isReporter(getAddress(reporter)),
          policy.threshold(),
          policy.maxAge(),
          policy.maxChangeBps(),
          policy.minInterval(),
        ]);
      if (
        !isRep ||
        threshold !== 1n ||
        maxAge !== BigInt(cp.maxAge) ||
        maxChange !== BigInt(cp.maxChangeBps) ||
        minInterval !== BigInt(cp.minInterval)
      )
        throw new Error(
          "배포된 가격 컨트랙트의 설정이 예상과 다릅니다. 사용하지 마세요: " +
            policyAddress,
        );
      args = lendingArgs(policyAddress);
    }
    const contract = await factory.deploy(...args, {
      gasLimit: (lendingGas * 12n) / 10n,
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
    const [
      usdt,
      wbmb,
      policy,
      vault,
      feeBps,
      minDuration,
      minGrace,
      bonus,
      staleDelay,
    ] = await Promise.all([
      contract.usdt(),
      contract.wbmb(),
      contract.pricePolicy(),
      contract.feeVault(),
      contract.feeBps(),
      contract.minDuration(),
      contract.minGrace(),
      contract.liquidationBonusBps(),
      contract.staleSettleDelay(),
    ]);
    if (
      usdt !== BSC.usdt ||
      wbmb !== BSC.wbmb ||
      policy !== policyAddress ||
      vault !== fee ||
      feeBps !== BigInt(BSC.feeBps) ||
      minDuration !== BigInt(limits.minDuration) ||
      minGrace !== BigInt(limits.minGrace) ||
      bonus !== BigInt(args[7]) ||
      staleDelay !== BigInt(args[8])
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
      profile,
      minDuration: limits.minDuration,
      minGrace: limits.minGrace,
      usdt: BSC.usdt,
      wbmb: BSC.wbmb,
      pricePolicy: policyAddress,
      liquidationBonusBps: Number(args[7]),
      staleSettleDelay: Number(args[8]),
      ...(cp
        ? {
            // This build charges the fee at settlement too; older records lack the flag and the page stays silent.
            settlementFee: true,
            policyTxHash,
            council: {
              reporter: getAddress(reporter),
              policyId: COUNCIL_POLICY_ID,
              maxAge: cp.maxAge,
              maxChangeBps: cp.maxChangeBps,
              minInterval: cp.minInterval,
            },
            policyConstructorArgs: policyArgs.map((a) =>
              Array.isArray(a) ? a.map(String) : String(a),
            ),
          }
        : {}),
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

/// Web config for a live deployment record (what the page fetches as /deployment.json).
export function liveWebConfig(record, rpcUrl = BSC.rpcUrl) {
  const council = isCouncilRecord(record);
  return {
    version: council ? 3 : 2,
    demo: false,
    ...(council
      ? {
          policy: "council",
          liquidationBonusBps: record.liquidationBonusBps,
          settlementFee: record.settlementFee === true,
        }
      : { oracleFree: true }),
    chainId: record.chainId,
    rpcUrl,
    deployedAt: record.deployedAt,
    feeWallet: record.feeWallet,
    feeBps: record.feeBps,
    addresses: {
      usdt: record.usdt,
      wbmb: record.wbmb,
      lending: record.lending,
      ...(council ? { oracle: record.pricePolicy } : {}),
    },
  };
}

const isCouncilRecord = (record) =>
  Boolean(record.pricePolicy) && BigInt(record.pricePolicy) !== 0n;

/// The values compiled into a live bundle as __PINNED__. The price contract is pinned
/// only for a council record, so the build alone decides which market the page accepts.
/// `rpcUrl` must be the URL given to liveWebConfig: the page reads every term, quote and
/// price through it, so a fetched file may not point those reads anywhere else.
export function livePinned(record, rpcUrl = BSC.rpcUrl) {
  return {
    chainId: record.chainId,
    lending: record.lending,
    usdt: record.usdt,
    wbmb: record.wbmb,
    feeWallet: record.feeWallet,
    rpcUrl,
    ...(isCouncilRecord(record) ? { oracle: record.pricePolicy } : {}),
  };
}

/// Names of the contract ABIs a live page needs (mock ABIs stay out of the bundle).
export function liveAbiNames(record) {
  return isCouncilRecord(record)
    ? ["P2PLending", "CouncilPricePolicy"]
    : ["P2PLending"];
}

if (process.argv[1]?.endsWith("deploy-bsc.mjs")) {
  compile(); // never deploy a stale artifact
  const file = process.env.DEPLOYER_KEY_FILE;
  const secret = file
    ? fs.readFileSync(file, "utf8")
    : process.env.DEPLOYER_KEY;
  deployBsc({
    rpcUrl: process.env.BSC_RPC_URL || BSC.rpcUrl,
    secret,
    index: Number(process.env.DEPLOYER_INDEX || 0),
    expectAddress: process.env.DEPLOYER_EXPECT,
    feeWallet: process.env.FEE_WALLET,
    reporter: process.env.REPORTER,
    broadcast: process.argv.includes("--broadcast"),
    profile:
      (process.argv.includes("--council") ? "council" : "") +
        (process.argv.includes("--test-market")
          ? process.argv.includes("--council")
            ? "-test"
            : "test"
          : "") || "main",
  }).catch((e) => {
    console.error("실패:", e.shortMessage || e.message);
    process.exit(1);
  });
}
