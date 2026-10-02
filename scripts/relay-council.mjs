// Copies the Mobick council price to the CouncilPricePolicy contract. Run it on a timer;
// each run checks once and exits.
//
//   Dry run (sends nothing):   RELAY_KEY_FILE=/path/key npm run relay:council
//   Real submission:           RELAY_KEY_FILE=/path/key npm run relay:council -- --broadcast
//   Test market:               add --test-market
//   Operator only:             add --step (never on the timer; see docs/MAINNET.md 8.3)
//
// --step is for the case the timer refuses: the council price is further from the on-chain
// price than the contract accepts in one report. Each run then moves the on-chain price one
// maximum step toward it. The price sent is not a council price; the operator vouches for it.
//
// For a mnemonic, RELAY_INDEX picks the wallet and RELAY_EXPECT must be that wallet's address.
// The key is read at run time, never printed, never written anywhere.
import fs from "node:fs";
import {
  Contract,
  JsonRpcProvider,
  formatUnits,
  getAddress,
  isAddress,
} from "ethers";
import { BSC } from "../config/bsc.mjs";
import { artifact } from "./deploy.mjs";
import { isMnemonic, loadDeployer, secretLine } from "./deploy-bsc.mjs";
import { submitCouncilReport } from "../src/council-signing.mjs";
import {
  COUNCIL_API_URL,
  parseCouncilPrice,
  planRelay,
} from "../src/council-relay.mjs";

// How long the council API may take to answer before the run gives up.
export const API_TIMEOUT_MS = 15_000;
// How long to wait for the report transaction to be mined before giving up.
export const CONFIRM_TIMEOUT_MS = 120_000;

export async function relayCouncil({
  rpcUrl = BSC.rpcUrl,
  chainId = BSC.chainId,
  policy,
  apiUrl = COUNCIL_API_URL,
  secret,
  index = 0,
  expectAddress,
  broadcast = false,
  step = false,
  apiTimeoutMs = API_TIMEOUT_MS,
  confirmTimeoutMs = CONFIRM_TIMEOUT_MS,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const provider = new JsonRpcProvider(rpcUrl, chainId, {
    staticNetwork: true,
  });
  try {
    if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(chainId))
      throw new Error("RPC의 체인 ID가 예상과 다릅니다.");
    if (!isAddress(policy) || (await provider.getCode(policy)) === "0x")
      throw new Error("가격 컨트랙트 주소가 올바르지 않습니다.");
    const signer = loadDeployer(secret, provider, index);
    if (!signer) throw new Error("RELAY_KEY_FILE 이 필요합니다.");
    if (isMnemonic(secretLine(secret)) && !expectAddress)
      throw new Error(
        "니모닉을 쓸 때는 RELAY_EXPECT 에 사용할 지갑 주소를 반드시 지정해야 합니다.",
      );
    const from = await signer.getAddress();
    if (
      expectAddress &&
      (!isAddress(expectAddress) || getAddress(expectAddress) !== from)
    )
      throw new Error(
        "서명 지갑이 예상 주소와 다릅니다. RELAY_INDEX 와 RELAY_EXPECT 를 확인하세요. 아무것도 전송하지 않았습니다.",
      );
    const oracle = new Contract(
      policy,
      artifact("CouncilPricePolicy").abi,
      signer,
    );
    if (!(await oracle.isReporter(from)))
      throw new Error("이 지갑은 가격 컨트랙트의 보고자가 아닙니다: " + from);
    let response, json;
    try {
      // The signal also covers reading the body, so a stalled answer cannot hang the run.
      response = await fetchImpl(apiUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(apiTimeoutMs),
      });
      if (response.ok) json = await response.json();
    } catch (e) {
      throw new Error(
        `카운슬 가격 API가 응답하지 않았습니다. 아무것도 보내지 않았습니다. (${e?.message || e})`,
        { cause: e },
      );
    }
    if (!response.ok)
      throw new Error(`카운슬 가격 API 응답 오류 (HTTP ${response.status})`);
    const api = parseCouncilPrice(json);
    const [
      block,
      policyId,
      lastRoundId,
      current,
      confirmedAt,
      validUntil,
      changedAt,
      maxAge,
      maxChangeBps,
      minInterval,
    ] = await Promise.all([
      provider.getBlock("latest"),
      oracle.policyId(),
      oracle.lastRoundId(),
      oracle.current(),
      oracle.confirmedAt(),
      oracle.validUntil(),
      oracle.changedAt(),
      oracle.maxAge(),
      oracle.maxChangeBps(),
      oracle.minInterval(),
    ]);
    const plan = planRelay({
      api,
      policyId,
      step,
      now: block.timestamp,
      chain: {
        lastRoundId: Number(lastRoundId),
        current,
        confirmedAt: Number(confirmedAt),
        validUntil: Number(validUntil),
        changedAt: Number(changedAt),
        maxAge: Number(maxAge),
        maxChangeBps: Number(maxChangeBps),
        minInterval: Number(minInterval),
      },
    });
    log(
      `카운슬 ${formatUnits(api.price, 18)} · 체인 ${formatUnits(current, 18)} · ${plan.reason}`,
    );
    if (plan.action !== "submit")
      return { action: plan.action, reason: plan.reason, broadcast: false };
    const stepped = plan.step === true;
    log(
      `보고서   round ${plan.report.roundId} · 가격 ${formatUnits(plan.report.price, 18)} · 유효 ${new Date(plan.report.validUntil * 1000).toISOString()}`,
    );
    if (stepped)
      log(
        `단계 이동 한도 ${Number(maxChangeBps) / 100}% 만큼만 옮깁니다. 이 가격은 카운슬 확정 가격이 아닙니다. 운영자가 보증하는 중간 값입니다.`,
      );
    if (!broadcast) {
      log("--broadcast 가 없어 전송하지 않았습니다.");
      return {
        action: "submit",
        reason: plan.reason,
        broadcast: false,
        step: stepped,
      };
    }
    const tx = await submitCouncilReport(oracle, plan.report, [signer]);
    log(`전송됨   ${tx.hash}`);
    let receipt;
    try {
      receipt = await tx.wait(1, confirmTimeoutMs);
    } catch (e) {
      if (e?.code !== "TIMEOUT") throw e;
      throw new Error(
        `거래를 보냈지만 제한 시간 안에 확인되지 않았습니다: ${tx.hash}. 다음 실행 전에 직접 확인하세요.`,
        { cause: e },
      );
    }
    if (receipt.status !== 1) throw new Error("가격 보고 거래가 실패했습니다.");
    return {
      action: "submit",
      reason: plan.reason,
      broadcast: true,
      step: stepped,
      txHash: tx.hash,
    };
  } finally {
    provider.destroy();
  }
}

if (process.argv[1]?.endsWith("relay-council.mjs")) {
  const recordFile = process.argv.includes("--test-market")
    ? "deployments/bsc-council-test.json"
    : "deployments/bsc-council.json";
  const file = process.env.RELAY_KEY_FILE;
  Promise.resolve()
    .then(() => {
      if (!fs.existsSync(recordFile))
        throw new Error(`배포 기록이 없습니다: ${recordFile}`);
      const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
      return relayCouncil({
        rpcUrl: process.env.BSC_RPC_URL || BSC.rpcUrl,
        policy: record.pricePolicy,
        secret: file ? fs.readFileSync(file, "utf8") : undefined,
        index: Number(process.env.RELAY_INDEX || 0),
        expectAddress: process.env.RELAY_EXPECT,
        broadcast: process.argv.includes("--broadcast"),
        step: process.argv.includes("--step"),
      });
    })
    .catch((e) => {
      console.error("실패:", e.shortMessage || e.message);
      process.exit(1);
    });
}
