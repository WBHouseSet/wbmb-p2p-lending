// First real-money check of a deployed market, using two wallets of ONE mnemonic
// (index 0 borrows, index 1 lends), so funds only move between the operator's own wallets.
//
//   Plan and balance check (sends nothing):  DEPLOYER_KEY_FILE=… node scripts/live-test.mjs
//   Run the cycle with real funds:           DEPLOYER_KEY_FILE=… node scripts/live-test.mjs --execute
//   After maturity + grace, settle loan B:   DEPLOYER_KEY_FILE=… node scripts/live-test.mjs --settle --execute
//
// Loan B (lend offer, never repaid) exercises default and settlement.
// Loan A (borrow request) exercises interest-only payment, full repayment, claims and fees.
import fs from "node:fs";
import path from "node:path";
import { Contract, JsonRpcProvider, formatUnits, parseUnits } from "ethers";
import { BSC } from "../config/bsc.mjs";
import { artifact } from "./deploy.mjs";
import { loadDeployer } from "./deploy-bsc.mjs";

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const LENDER_GAS_UNITS = 1_500_000n; // gas the lender wallet needs for its half of the cycle

export async function runLiveTest({
  rpcUrl = BSC.rpcUrl,
  secret,
  lendingAddress,
  principal = "0.01",
  collateral = "0.0001",
  duration = 1800,
  grace = 300,
  settle = false,
  execute = false,
  stateFile = ".local/live-test-state.json",
  sleep = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000)),
  log = console.log,
} = {}) {
  const provider = new JsonRpcProvider(rpcUrl, BSC.chainId, {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  try {
    const borrower = loadDeployer(secret, provider, 0);
    const lender = loadDeployer(secret, provider, 1);
    if (!borrower || borrower.address === lender.address)
      throw new Error("두 지갑이 필요합니다. 키 파일은 니모닉이어야 합니다.");
    const B = borrower.address,
      L = lender.address;
    if ((await provider.getCode(lendingAddress)) === "0x")
      throw new Error("대출 컨트랙트가 없습니다: " + lendingAddress);
    const lending = new Contract(
      lendingAddress,
      artifact("P2PLending").abi,
      provider,
    );
    const movn = new Contract(BSC.movn, ERC20, provider);
    const wbmb = new Contract(BSC.wbmb, ERC20, provider);
    const [onMovn, onWbmb, oracleFree, minDuration, minGrace, feeVault] =
      await Promise.all([
        lending.movn(),
        lending.wbmb(),
        lending.oracleFree(),
        lending.minDuration(),
        lending.minGrace(),
        lending.feeVault(),
      ]);
    if (onMovn !== BSC.movn || onWbmb !== BSC.wbmb || !oracleFree)
      throw new Error("이 컨트랙트는 예상한 오라클 없는 시장이 아닙니다.");
    if (BigInt(duration) < minDuration || BigInt(grace) < minGrace)
      throw new Error(
        `이 시장의 최소 기간은 ${minDuration}초, 최소 유예는 ${minGrace}초입니다.`,
      );
    const p = parseUnits(principal, 18),
      c = parseUnits(collateral, 8);
    const terms = {
      aprBps: 10000, // 100% APR so a minute of interest is visible on a tiny loan
      haircutBps: 0,
      liquidationBps: 0,
      duration,
      grace,
      mode: 1,
    };
    const u = (n) => formatUnits(n, 18),
      w = (n) => formatUnits(n, 8);
    const balances = async () => {
      const [bb, lb, bu, lu, bw, lw, fu] = await Promise.all([
        provider.getBalance(B),
        provider.getBalance(L),
        movn.balanceOf(B),
        movn.balanceOf(L),
        wbmb.balanceOf(B),
        wbmb.balanceOf(L),
        movn.balanceOf(feeVault),
      ]);
      return { bb, lb, bu, lu, bw, lw, fu };
    };
    const show = (title, x) =>
      log(
        `${title}\n  빌리는 지갑 ${B}: BNB ${u(x.bb)} · MOVN ${u(x.bu)} · WBMB ${w(x.bw)}\n  빌려주는 지갑 ${L}: BNB ${u(x.lb)} · MOVN ${u(x.lu)} · WBMB ${w(x.lw)}`,
      );
    const gasPrice = (await provider.getFeeData()).gasPrice;
    let gasSpent = 0n,
      gasUsed = 0n;
    const send = async (label, promise) => {
      const tx = await promise;
      const receipt = await tx.wait(1);
      if (receipt.status !== 1) throw new Error(`${label} 실패: ${tx.hash}`);
      gasSpent += receipt.gasUsed * receipt.gasPrice;
      gasUsed += receipt.gasUsed;
      log(`  ✓ ${label} · gas ${receipt.gasUsed} · ${tx.hash}`);
      return receipt;
    };
    const expect = (what, actual, wanted) => {
      if (actual !== wanted)
        throw new Error(
          `${what}: 예상 ${wanted}, 실제 ${actual}. 테스트를 중단합니다.`,
        );
      log(`  = ${what} 확인`);
    };
    const conserved = async () => {
      const [lu, lw] = await lending.liabilities();
      const [hu, hw] = await Promise.all([
        movn.balanceOf(lendingAddress),
        wbmb.balanceOf(lendingAddress),
      ]);
      if (hu < lu || hw < lw)
        throw new Error(
          "컨트랙트 보유 잔액이 장부보다 적습니다. 즉시 중단합니다.",
        );
      log(
        `  = 컨트랙트 보유 잔액 ≥ 장부 (MOVN ${u(hu)}/${u(lu)}, WBMB ${w(hw)}/${w(lw)})`,
      );
    };
    const opts = { gasPrice };
    const now = async () => (await provider.getBlock("latest")).timestamp;
    const start = await balances();
    show("현재 잔액", start);

    // ── settle phase ────────────────────────────────────────────────
    if (settle) {
      if (!fs.existsSync(stateFile))
        throw new Error("진행 중인 테스트 기록이 없습니다: " + stateFile);
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (state.lending !== lendingAddress)
        throw new Error("기록의 컨트랙트 주소가 다릅니다.");
      const left = state.dueAt - (await now());
      log(
        `대출 B #${state.loanB}: 유예 종료 ${new Date(state.dueAt * 1000).toLocaleString("ko-KR")}`,
      );
      if (left >= 0) {
        log(
          `아직 ${Math.ceil((left + 1) / 60)}분 남았습니다. 그 뒤에 다시 실행하세요.`,
        );
        return { settled: false, secondsLeft: left };
      }
      if (!execute) {
        log(
          "정산할 수 있습니다. --execute 를 붙이면 실행합니다. 아무것도 전송하지 않았습니다.",
        );
        return { settled: false, secondsLeft: 0 };
      }
      const before_ = await wbmb.balanceOf(L);
      await send(
        "정산 settle (누구나 호출 가능)",
        lending.connect(borrower).settle(state.loanB, opts),
      );
      expect(
        "대출 B 상태 = WBMB 정산 완료",
        Number((await lending.getLoan(state.loanB)).status),
        3,
      );
      await send(
        "빌려준 쪽 담보 수령 claimWBMB",
        lending.connect(lender).claimWBMB(opts),
      );
      expect("빌려준 지갑 WBMB 증가", (await wbmb.balanceOf(L)) - before_, c);
      await conserved();
      fs.renameSync(
        stateFile,
        stateFile.replace(/\.json$/, `.done-${state.loanB}.json`),
      );
      show("정산 후 잔액", await balances());
      log(`가스비 합계 ${u(gasSpent)} BNB`);
      return { settled: true, loanB: state.loanB, gasSpent, gasUsed };
    }

    // ── open phase ──────────────────────────────────────────────────
    if (fs.existsSync(stateFile))
      throw new Error(
        "이미 진행 중인 테스트가 있습니다. 먼저 --settle 로 마무리하세요: " +
          stateFile,
      );
    const GAS_FLOAT = gasPrice * LENDER_GAS_UNITS; // BNB moved to the lender wallet for gas
    const lenderNeedsGas = start.lb < GAS_FLOAT;
    const problems = [];
    if (start.bw < 2n * c)
      problems.push(
        `빌리는 지갑에 WBMB ${w(2n * c)} 필요 (현재 ${w(start.bw)})`,
      );
    if (start.lu < 2n * p)
      problems.push(
        `빌려주는 지갑에 MOVN ${u(2n * p)} 필요 (현재 ${u(start.lu)})`,
      );
    const gasNeed = gasPrice * 3_500_000n + (lenderNeedsGas ? GAS_FLOAT : 0n);
    if (start.bb < gasNeed)
      problems.push(
        `빌리는 지갑에 BNB ${u(gasNeed)} 필요 (현재 ${u(start.bb)})`,
      );
    log(
      `계획: 원금 ${principal} MOVN · 담보 ${collateral} WBMB · 기간 ${duration / 60}분 · 유예 ${grace / 60}분 · 대출 2건(A 상환, B 미상환)`,
    );
    if (problems.length) {
      for (const x of problems) log("  부족: " + x);
      return { ready: false, problems };
    }
    if (!execute) {
      log(
        "준비됐습니다. --execute 를 붙이면 실제 자금으로 실행합니다. 아무것도 전송하지 않았습니다.",
      );
      return { ready: true, problems };
    }
    if (lenderNeedsGas)
      await send(
        "빌려주는 지갑에 가스비 BNB 전송",
        borrower.sendTransaction({ to: L, value: GAS_FLOAT, gasPrice }),
      );
    const asB = lending.connect(borrower),
      asL = lending.connect(lender);
    const expiry = async () => (await now()) + 3600;
    const deadline = async () => (await now()) + 600;

    log(
      "대출 B: 빌려주는 쪽이 게시, 빌리는 쪽이 담보를 맡기고 체결 (상환하지 않음)",
    );
    await send(
      "MOVN 승인",
      movn.connect(lender).approve(lendingAddress, p, opts),
    );
    await send(
      "대출 제안 게시",
      asL.createOffer(1, p, c, p, await expiry(), terms, opts),
    );
    const offerB = await lending.offerCount();
    expect(
      "미체결 MOVN 에스크로",
      (await lending.getOffer(offerB)).remaining,
      p,
    );
    await send(
      "WBMB 승인",
      wbmb.connect(borrower).approve(lendingAddress, c, opts),
    );
    let before_ = await movn.balanceOf(B);
    await send(
      "체결(빌리기)",
      asB.fillOffer(offerB, p, c, await deadline(), opts),
    );
    const loanB = Number(await lending.loanCount());
    expect("빌린 지갑 MOVN 증가", (await movn.balanceOf(B)) - before_, p);
    const lb = await lending.getLoan(loanB);
    expect("대출 B 담보", lb.collateral, c);
    const dueAt = Number(lb.maturity) + grace;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ lending: lendingAddress, loanB, dueAt }, null, 2) + "\n",
    );
    await conserved();

    log(
      "대출 A: 빌리는 쪽이 게시, 빌려주는 쪽이 체결, 이자만 납부 후 전액 상환",
    );
    await send(
      "WBMB 승인",
      wbmb.connect(borrower).approve(lendingAddress, c, opts),
    );
    await send(
      "차입 요청 게시",
      asB.createOffer(0, p, c, p, await expiry(), terms, opts),
    );
    const offerA = await lending.offerCount();
    await send(
      "MOVN 승인",
      movn.connect(lender).approve(lendingAddress, p, opts),
    );
    await send(
      "체결(빌려주기)",
      asL.fillOffer(offerA, p, c, await deadline(), opts),
    );
    const loanA = Number(await lending.loanCount());
    log("  … 이자가 쌓이도록 60초 대기");
    await sleep(60);
    const cap = 2n * p;
    await send(
      "MOVN 승인(상환)",
      movn.connect(borrower).approve(lendingAddress, cap, opts),
    );
    await send("이자만 납부", asB.repay(loanA, 0, cap, opts));
    const paidInterest = await lending.claimableMOVN(L);
    if (paidInterest <= 0n) throw new Error("이자가 지급되지 않았습니다.");
    log(
      `  = 지급된 이자 ${u(paidInterest)} MOVN, 쌓인 수수료 ${u(await lending.feeBalance())} MOVN`,
    );
    await send("전액 상환", asB.repay(loanA, p, cap, opts));
    expect(
      "대출 A 상태 = 상환 완료",
      Number((await lending.getLoan(loanA)).status),
      2,
    );
    before_ = await wbmb.balanceOf(B);
    await send("담보 수령 claimWBMB", asB.claimWBMB(opts));
    expect("빌린 지갑 담보 반환", (await wbmb.balanceOf(B)) - before_, c);
    before_ = await movn.balanceOf(L);
    const owed = await lending.claimableMOVN(L);
    await send("원금·이자 수령 claimMOVN", asL.claimMOVN(opts));
    expect("빌려준 지갑 MOVN 수령", (await movn.balanceOf(L)) - before_, owed);
    if (owed <= p) throw new Error("대출자가 받은 금액이 원금 이하입니다.");
    const fee = await lending.feeBalance();
    before_ = await movn.balanceOf(feeVault);
    await send("수수료 이동 flushFees", asL.flushFees(opts));
    expect(
      "수수료 지갑 MOVN 증가",
      (await movn.balanceOf(feeVault)) - before_,
      fee,
    );

    log("게시 취소: 미체결 담보 회수");
    await send(
      "WBMB 승인",
      wbmb.connect(borrower).approve(lendingAddress, c, opts),
    );
    await send(
      "차입 요청 게시",
      asB.createOffer(0, p, c, p, await expiry(), terms, opts),
    );
    await send(
      "게시 취소 closeOffer",
      asB.closeOffer(await lending.offerCount(), opts),
    );
    before_ = await wbmb.balanceOf(B);
    await send("미체결 담보 수령", asB.claimWBMB(opts));
    expect("취소한 담보 반환", (await wbmb.balanceOf(B)) - before_, c);
    await conserved();

    const end = await balances();
    show("1단계 후 잔액", end);
    log(
      `가스비 합계 ${u(gasSpent)} BNB · 대출 B #${loanB} 는 ${new Date(dueAt * 1000).toLocaleString("ko-KR")} 이후 --settle 로 정산합니다.`,
    );
    return {
      ready: true,
      executed: true,
      loanA,
      loanB,
      dueAt,
      gasSpent,
      gasUsed,
      interest: owed - p,
      fee,
    };
  } finally {
    provider.destroy();
  }
}

if (process.argv[1]?.endsWith("live-test.mjs")) {
  const file = process.env.DEPLOYER_KEY_FILE;
  const recordFile = process.env.MARKET_RECORD || "deployments/bsc-movn-test.json";
  if (!file || !fs.existsSync(recordFile)) {
    console.error(
      `DEPLOYER_KEY_FILE 과 배포 기록(${recordFile})이 필요합니다.`,
    );
    process.exit(1);
  }
  runLiveTest({
    rpcUrl: process.env.BSC_RPC_URL || BSC.rpcUrl,
    secret: fs.readFileSync(file, "utf8"),
    lendingAddress: JSON.parse(fs.readFileSync(recordFile, "utf8")).lending,
    settle: process.argv.includes("--settle"),
    execute: process.argv.includes("--execute"),
  }).catch((e) => {
    console.error("실패:", e.shortMessage || e.message);
    process.exit(1);
  });
}
