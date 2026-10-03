// First real-money check of a deployed council-price market, using two wallets of ONE mnemonic
// (index 0 borrows, index 1 lends), so funds only move between the operator's own wallets.
// The price relay must have published a price first, and must keep running until loan B is settled.
//
//   Plan and balance check (sends nothing):  DEPLOYER_KEY_FILE=… node scripts/live-test-council.mjs
//   Run the cycle with real funds:           DEPLOYER_KEY_FILE=… node scripts/live-test-council.mjs --execute
//   After maturity + grace, settle loan B:   DEPLOYER_KEY_FILE=… node scripts/live-test-council.mjs --settle --execute
//
// Loan B (lend offer, never repaid) exercises collateral at the council price, a top-up, and the
// overdue settlement that pays the lender debt + bonus and returns the rest to the borrower.
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
const BPS = 10000n;
const WBMB_UNIT = 10n ** 8n;
const LENDER_GAS_UNITS = 1_500_000n; // gas the lender wallet needs for its half of the cycle
const BORROWER_GAS_UNITS = 3_500_000n;
// The price must outlive loan B by this much, so the settlement is a price settlement.
const PRICE_MARGIN = 3600;
const ceilDiv = (a, b) => (a + b - 1n) / b;

export async function runCouncilLiveTest({
  rpcUrl = BSC.rpcUrl,
  secret,
  lendingAddress,
  principal = "0.002",
  topUp = "0.00001",
  settle = false,
  execute = false,
  stateFile = ".local/live-test-council-state.json",
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
    const usdt = new Contract(BSC.usdt, ERC20, provider);
    const wbmb = new Contract(BSC.wbmb, ERC20, provider);
    const [onUsdt, onWbmb, oracleFree, minDuration, minGrace, feeVault, bonus] =
      await Promise.all([
        lending.usdt(),
        lending.wbmb(),
        lending.oracleFree(),
        lending.minDuration(),
        lending.minGrace(),
        lending.feeVault(),
        lending.liquidationBonusBps(),
      ]);
    if (onUsdt !== BSC.usdt || onWbmb !== BSC.wbmb || oracleFree)
      throw new Error("이 컨트랙트는 예상한 카운슬 가격형 시장이 아닙니다.");
    const policy = new Contract(
      await lending.pricePolicy(),
      artifact("CouncilPricePolicy").abi,
      provider,
    );
    const duration = Number(minDuration),
      grace = Number(minGrace);
    const p = parseUnits(principal, 18),
      extra = parseUnits(topUp, 8);
    // The terms the web page posts, with the shortest period this market accepts.
    const terms = {
      aprBps: 10000, // 100% APR so a minute of interest is visible on a tiny loan
      haircutBps: 5000,
      liquidationBps: 7000,
      duration,
      grace,
      mode: 0,
    };
    const u = (n) => formatUnits(n, 18),
      w = (n) => formatUnits(n, 8);
    const balances = async () => {
      const [bb, lb, bu, lu, bw, lw] = await Promise.all([
        provider.getBalance(B),
        provider.getBalance(L),
        usdt.balanceOf(B),
        usdt.balanceOf(L),
        wbmb.balanceOf(B),
        wbmb.balanceOf(L),
      ]);
      return { bb, lb, bu, lu, bw, lw };
    };
    const show = (title, x) =>
      log(
        `${title}\n  빌리는 지갑 ${B}: BNB ${u(x.bb)} · USDT ${u(x.bu)} · WBMB ${w(x.bw)}\n  빌려주는 지갑 ${L}: BNB ${u(x.lb)} · USDT ${u(x.lu)} · WBMB ${w(x.lw)}`,
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
        usdt.balanceOf(lendingAddress),
        wbmb.balanceOf(lendingAddress),
      ]);
      if (hu < lu || hw < lw)
        throw new Error(
          "컨트랙트 보유 잔액이 장부보다 적습니다. 즉시 중단합니다.",
        );
      log(
        `  = 컨트랙트 보유 잔액 ≥ 장부 (USDT ${u(hu)}/${u(lu)}, WBMB ${w(hw)}/${w(lw)})`,
      );
    };
    // The price that would liquidate this loan: debt reaches liquidationBps of the collateral value.
    const liquidationPrice = async (id) => {
      const loan = await lending.getLoan(id);
      return ceilDiv(
        (await lending.debtOf(id)) * WBMB_UNIT * BPS,
        loan.collateral * loan.terms.liquidationBps,
      );
    };
    const opts = { gasPrice };
    const now = async () => (await provider.getBlock("latest")).timestamp;
    const time = (s) => new Date(Number(s) * 1000).toLocaleString("ko-KR");
    const start = await balances();
    show("현재 잔액", start);
    const priced = await policy.prices().then(
      ([opening, current]) => ({ opening, current }),
      () => null,
    );
    const validUntil = Number(await policy.validUntil());
    log(
      priced
        ? `카운슬 가격 ${u(priced.current)} USDT (체결 기준가 ${u(priced.opening)}) · 유효 ${time(validUntil)}까지`
        : "카운슬 가격이 없거나 만료됐습니다.",
    );

    // ── settle phase ────────────────────────────────────────────────
    if (settle) {
      if (!fs.existsSync(stateFile))
        throw new Error("진행 중인 테스트 기록이 없습니다: " + stateFile);
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (state.lending !== lendingAddress)
        throw new Error("기록의 컨트랙트 주소가 다릅니다.");
      const left = state.dueAt - (await now());
      log(`대출 B #${state.loanB}: 유예 종료 ${time(state.dueAt)}`);
      if (left >= 0) {
        log(
          `아직 ${Math.ceil((left + 1) / 60)}분 남았습니다. 그 뒤에 다시 실행하세요.`,
        );
        return { settled: false, secondsLeft: left };
      }
      // Without a live price the only settlement left is the delayed one at the last price; this check is about the live one.
      if (!priced)
        throw new Error(
          "가격이 만료돼 가격으로 정산할 수 없습니다. 먼저 중계를 실행해 가격을 되살리세요 (npm run relay:council -- --test-market --broadcast). 아무것도 전송하지 않았습니다.",
        );
      if (!execute) {
        log(
          "정산할 수 있습니다. --execute 를 붙이면 실행합니다. 아무것도 전송하지 않았습니다.",
        );
        return { settled: false, secondsLeft: 0 };
      }
      const loanBefore = await lending.getLoan(state.loanB);
      const collateral = loanBefore.collateral;
      const feeBps = await lending.feeBps();
      const [claimL, claimB, claimFee] = await Promise.all([
        lending.claimableWBMB(L),
        lending.claimableWBMB(B),
        lending.claimableWBMB(feeVault),
      ]);
      const receipt = await send(
        "정산 settle (누구나 호출 가능)",
        lending.connect(borrower).settle(state.loanB, opts),
      );
      const events = receipt.logs
        .filter((x) => x.address === lendingAddress)
        .map((x) => lending.interface.parseLog(x));
      const settled = events.find((x) => x?.name === "Settled").args;
      const fee =
        events.find((x) => x?.name === "SettlementFee")?.args.feeWBMB ?? 0n;
      const toLender = settled.lenderWBMB,
        toBorrower = settled.borrowerWBMB;
      log(
        `  = 부채 ${u(settled.debt)} USDT · 정산 가격 ${u(settled.price)} USDT → 대출자 ${w(toLender)} WBMB · 차입자 ${w(toBorrower)} WBMB · 수수료 ${w(fee)} WBMB`,
      );
      expect(
        "대출 B 상태 = WBMB 정산 완료",
        Number((await lending.getLoan(state.loanB)).status),
        3,
      );
      // Recomputed here, not read back: the lender's share is debt + bonus at the settlement price.
      expect(
        `대출자 몫 = (부채 + ${Number(bonus) / 100}%) ÷ 가격`,
        toLender,
        ceilDiv(settled.debt * (BPS + bonus) * WBMB_UNIT, settled.price * BPS),
      );
      // Recomputed here too: the repayment fee on the unpaid interest, at the settlement price, capped at the surplus.
      const feeUsdt = ceilDiv(
        (settled.debt - loanBefore.principal) * feeBps +
          loanBefore.feeRemainder,
        BPS,
      );
      const feeDue = ceilDiv(feeUsdt * WBMB_UNIT, settled.price);
      expect(
        `수수료 = 못 낸 이자의 ${Number(feeBps) / 100}% ÷ 가격 (남은 담보 한도)`,
        fee,
        feeDue < collateral - toLender ? feeDue : collateral - toLender,
      );
      expect(
        "차입자 몫 = 담보 − 대출자 몫 − 수수료",
        toBorrower,
        collateral - toLender - fee,
      );
      // In this test the borrower's wallet may also be the fee wallet; then the fee lands in the same claim.
      const feeToB = B === feeVault ? fee : 0n;
      if (toBorrower <= 0n)
        throw new Error("차입자에게 돌아간 담보가 없습니다.");
      expect(
        "대출자 수령 가능 WBMB 증가",
        (await lending.claimableWBMB(L)) - claimL,
        toLender,
      );
      expect(
        "차입자 수령 가능 WBMB 증가",
        (await lending.claimableWBMB(B)) - claimB,
        toBorrower + feeToB,
      );
      if (!feeToB)
        expect(
          "수수료 지갑 수령 가능 WBMB 증가",
          (await lending.claimableWBMB(feeVault)) - claimFee,
          fee,
        );
      let before_ = await wbmb.balanceOf(L);
      await send(
        "빌려준 쪽 담보 수령 claimWBMB",
        lending.connect(lender).claimWBMB(opts),
      );
      expect(
        "빌려준 지갑 WBMB 증가",
        (await wbmb.balanceOf(L)) - before_,
        claimL + toLender,
      );
      before_ = await wbmb.balanceOf(B);
      await send(
        "빌린 쪽 남은 담보 수령 claimWBMB",
        lending.connect(borrower).claimWBMB(opts),
      );
      expect(
        "빌린 지갑 WBMB 증가",
        (await wbmb.balanceOf(B)) - before_,
        claimB + toBorrower + feeToB,
      );
      await conserved();
      fs.renameSync(
        stateFile,
        stateFile.replace(/\.json$/, `.done-${state.loanB}.json`),
      );
      show("정산 후 잔액", await balances());
      log(`가스비 합계 ${u(gasSpent)} BNB`);
      return {
        settled: true,
        loanB: state.loanB,
        toLender,
        toBorrower,
        fee,
        debt: settled.debt,
        price: settled.price,
        gasSpent,
        gasUsed,
      };
    }

    // ── open phase ──────────────────────────────────────────────────
    if (fs.existsSync(stateFile))
      throw new Error(
        "이미 진행 중인 테스트가 있습니다. 먼저 --settle 로 마무리하세요: " +
          stateFile,
      );
    const problems = [];
    if (!priced)
      problems.push(
        "가격이 등록돼 있지 않습니다. 먼저 중계를 실행하세요 (npm run relay:council -- --test-market --broadcast)",
      );
    else if (validUntil < (await now()) + duration + grace + PRICE_MARGIN)
      problems.push(
        "가격 유효기한이 대출 B 정산 시점보다 짧습니다. 먼저 중계를 실행해 연장하세요",
      );
    // Collateral for one loan at the fill price; the contract's own figure is used when filling.
    const each = priced
      ? ceilDiv(p * WBMB_UNIT * BPS, priced.opening * (BPS - 5000n))
      : 0n;
    const wbmbNeed = 2n * each + extra;
    const GAS_FLOAT = gasPrice * LENDER_GAS_UNITS; // BNB moved to the lender wallet for gas
    const lenderNeedsGas = start.lb < GAS_FLOAT;
    if (priced && start.bw < wbmbNeed)
      problems.push(
        `빌리는 지갑에 WBMB ${w(wbmbNeed)} 필요 (현재 ${w(start.bw)})`,
      );
    if (start.lu < 2n * p)
      problems.push(
        `빌려주는 지갑에 USDT ${u(2n * p)} 필요 (현재 ${u(start.lu)})`,
      );
    const gasNeed =
      gasPrice * BORROWER_GAS_UNITS +
      (lenderNeedsGas ? GAS_FLOAT - start.lb : 0n);
    if (start.bb < gasNeed)
      problems.push(
        `빌리는 지갑에 BNB ${u(gasNeed)} 필요 (현재 ${u(start.bb)})`,
      );
    log(
      `계획: 원금 ${principal} USDT · 담보 약 ${w(each)} WBMB(대출 B는 ${topUp} 추가) · 기간 ${duration / 60}분 · 유예 ${grace / 60}분 · 대출 2건(A 상환, B 미상환)`,
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
        borrower.sendTransaction({
          to: L,
          value: GAS_FLOAT - start.lb,
          gasPrice,
        }),
      );
    const asB = lending.connect(borrower),
      asL = lending.connect(lender);
    const expiry = async () => (await now()) + 3600;
    const deadline = async () => (await now()) + 600;

    log(
      "대출 B: 빌려주는 쪽이 게시, 빌리는 쪽이 카운슬 가격으로 담보를 맡기고 체결 (상환하지 않음)",
    );
    await send(
      "USDT 승인",
      usdt.connect(lender).approve(lendingAddress, p, opts),
    );
    await send(
      "대출 제안 게시",
      asL.createOffer(1, p, 0, p, await expiry(), terms, opts),
    );
    const offerB = await lending.offerCount();
    expect(
      "미체결 USDT 에스크로",
      (await lending.getOffer(offerB)).remaining,
      p,
    );
    const quoted = await lending.quoteFill(offerB, p);
    await send(
      "WBMB 승인",
      wbmb.connect(borrower).approve(lendingAddress, quoted, opts),
    );
    let before_ = await usdt.balanceOf(B);
    await send(
      "체결(빌리기)",
      asB.fillOffer(offerB, p, quoted, await deadline(), opts),
    );
    const loanB = Number(await lending.loanCount());
    expect("빌린 지갑 USDT 증가", (await usdt.balanceOf(B)) - before_, p);
    const lb = await lending.getLoan(loanB);
    const dueAt = Number(lb.maturity) + grace;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ lending: lendingAddress, loanB, dueAt }, null, 2) + "\n",
    );
    const [opening] = await policy.prices();
    // Recomputed here: collateral worth the principal at 50% of the council price.
    expect(
      `대출 B 담보 = 원금 ÷ (가격 ${u(opening)} × 50%)`,
      lb.collateral,
      ceilDiv(p * WBMB_UNIT * BPS, opening * (BPS - 5000n)),
    );
    const healthy = await lending.quoteSettlement(loanB).then(
      () => false,
      (e) => /HEALTHY/.test(e.reason || e.shortMessage || e.message),
    );
    if (!healthy)
      throw new Error("청산선 위의 대출이 정산 가능한 상태입니다. 중단합니다.");
    log("  = 청산선 위에서는 정산 거부(HEALTHY) 확인");
    const priceBefore = await liquidationPrice(loanB);
    await send(
      "WBMB 승인(담보 추가)",
      wbmb.connect(borrower).approve(lendingAddress, extra, opts),
    );
    await send(
      "담보 추가 addCollateral",
      asB.addCollateral(loanB, extra, opts),
    );
    expect(
      "대출 B 담보 증가",
      (await lending.getLoan(loanB)).collateral,
      lb.collateral + extra,
    );
    const priceAfter = await liquidationPrice(loanB);
    if (priceAfter >= priceBefore)
      throw new Error("담보를 추가했는데 청산 가격이 내려가지 않았습니다.");
    log(`  = 청산 가격 ${u(priceBefore)} → ${u(priceAfter)} USDT 로 내려감`);
    await conserved();

    log(
      "대출 A: 빌리는 쪽이 게시, 빌려주는 쪽이 체결, 이자만 납부 후 전액 상환",
    );
    await send(
      "WBMB 승인",
      wbmb.connect(borrower).approve(lendingAddress, each, opts),
    );
    await send(
      "차입 요청 게시",
      asB.createOffer(0, p, each, p, await expiry(), terms, opts),
    );
    const offerA = await lending.offerCount();
    await send(
      "USDT 승인",
      usdt.connect(lender).approve(lendingAddress, p, opts),
    );
    await send(
      "체결(빌려주기)",
      asL.fillOffer(offerA, p, each, await deadline(), opts),
    );
    const loanA = Number(await lending.loanCount());
    log("  … 이자가 쌓이도록 60초 대기");
    await sleep(60);
    const cap = 2n * p;
    await send(
      "USDT 승인(상환)",
      usdt.connect(borrower).approve(lendingAddress, cap, opts),
    );
    await send("이자만 납부", asB.repay(loanA, 0, cap, opts));
    const paidInterest = await lending.claimableUSDT(L);
    if (paidInterest <= 0n) throw new Error("이자가 지급되지 않았습니다.");
    log(
      `  = 지급된 이자 ${u(paidInterest)} USDT, 쌓인 수수료 ${u(await lending.feeBalance())} USDT`,
    );
    await send("전액 상환", asB.repay(loanA, p, cap, opts));
    expect(
      "대출 A 상태 = 상환 완료",
      Number((await lending.getLoan(loanA)).status),
      2,
    );
    before_ = await wbmb.balanceOf(B);
    await send("담보 수령 claimWBMB", asB.claimWBMB(opts));
    expect("빌린 지갑 담보 반환", (await wbmb.balanceOf(B)) - before_, each);
    before_ = await usdt.balanceOf(L);
    const owed = await lending.claimableUSDT(L);
    await send("원금·이자 수령 claimUSDT", asL.claimUSDT(opts));
    expect("빌려준 지갑 USDT 수령", (await usdt.balanceOf(L)) - before_, owed);
    if (owed <= p) throw new Error("대출자가 받은 금액이 원금 이하입니다.");
    const fee = await lending.feeBalance();
    before_ = await usdt.balanceOf(feeVault);
    await send("수수료 이동 flushFees", asL.flushFees(opts));
    expect(
      "수수료 지갑 USDT 증가",
      (await usdt.balanceOf(feeVault)) - before_,
      fee,
    );

    log("게시 취소: 미체결 USDT 회수");
    await send(
      "USDT 승인",
      usdt.connect(lender).approve(lendingAddress, p, opts),
    );
    await send(
      "대출 제안 게시",
      asL.createOffer(1, p, 0, p, await expiry(), terms, opts),
    );
    await send(
      "게시 취소 closeOffer",
      asL.closeOffer(await lending.offerCount(), opts),
    );
    before_ = await usdt.balanceOf(L);
    await send("미체결 USDT 수령", asL.claimUSDT(opts));
    expect("취소한 USDT 반환", (await usdt.balanceOf(L)) - before_, p);
    await conserved();

    show("1단계 후 잔액", await balances());
    log(
      `가스비 합계 ${u(gasSpent)} BNB · 대출 B #${loanB} 는 ${time(dueAt)} 이후 --settle 로 정산합니다. 그때까지 가격 중계를 멈추지 마세요.`,
    );
    return {
      ready: true,
      executed: true,
      loanA,
      loanB,
      dueAt,
      collateral: each,
      gasSpent,
      gasUsed,
      interest: owed - p,
      fee,
    };
  } finally {
    provider.destroy();
  }
}

if (process.argv[1]?.endsWith("live-test-council.mjs")) {
  const file = process.env.DEPLOYER_KEY_FILE;
  const recordFile =
    process.env.MARKET_RECORD || "deployments/bsc-council-test.json";
  if (!file || !fs.existsSync(recordFile)) {
    console.error(
      `DEPLOYER_KEY_FILE 과 배포 기록(${recordFile})이 필요합니다.`,
    );
    process.exit(1);
  }
  runCouncilLiveTest({
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
