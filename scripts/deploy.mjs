import fs from "node:fs";
import { ContractFactory, ZeroAddress, parseUnits } from "ethers";
import { demoPriceReport } from "../src/prices.mjs";
import {
  POLICY_ID,
  toReport,
  hashSyntheticData,
  submitReport,
} from "../src/report-signing.mjs";
import {
  COUNCIL_POLICY_ID,
  submitCouncilReport,
} from "../src/council-signing.mjs";

export const us = (x) => parseUnits(String(x), 18);
export const wb = (x) => parseUnits(String(x), 8);
export function artifact(name) {
  return JSON.parse(fs.readFileSync(`artifacts/${name}.json`, "utf8"));
}
export async function deployContract(name, signer, args = []) {
  const a = artifact(name);
  const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(
    ...args,
  );
  await c.waitForDeployment();
  return c;
}
export async function assertLocal(provider) {
  if ((await provider.getNetwork()).chainId !== 31337n)
    throw new Error("로컬 체인 31337만 허용합니다.");
  await provider.send("hardhat_metadata", []); // reject a remote chain merely reusing this ID
}
// Local reporters are node accounts 4-6; any two must sign each report.
export const REPORTER_INDICES = [4, 5, 6];
export const THRESHOLD = 2;
export const MAX_AGE = 7200;
/// Publishes a synthetic report in which both sources show `low`/`current` unless overridden.
export async function publishPricesWith(
  provider,
  oracle,
  signers,
  low,
  current,
  overrides = {},
) {
  const pr = demoPriceReport(
    Number((await provider.getBlock("latest")).timestamp),
  );
  const values = {
    dexLow: low,
    cexLow: low,
    dexCurrent: current,
    cexCurrent: current,
    ...overrides,
  };
  const report = {
    ...toReport(pr, {
      roundId: Number(await oracle.lastRoundId()) + 1,
      validUntil: pr.windowEnd + MAX_AGE,
      rawDataHash: hashSyntheticData({ windowEnd: pr.windowEnd, ...values }),
    }),
    ...values,
  };
  return (await submitReport(oracle, report, signers)).wait();
}
export async function deployFixture(provider, { seed = false } = {}) {
  await assertLocal(provider);
  const accounts = await Promise.all(
    [0, 1, 2, 3].map((i) => provider.getSigner(i)),
  );
  const [admin, borrower, lender, lender2] = accounts;
  const addresses = await Promise.all(accounts.map((a) => a.getAddress()));
  const usdt = await deployContract("MockToken", admin, [
    "Demo USDT",
    "dUSDT",
    18,
  ]);
  const wbmb = await deployContract("MockToken", admin, [
    "Demo WBMB",
    "dWBMB",
    8,
  ]);
  const reporters = await Promise.all(
    REPORTER_INDICES.map((i) => provider.getSigner(i)),
  );
  const reporterAddresses = await Promise.all(
    reporters.map((r) => r.getAddress()),
  );
  const oracle = await deployContract("SignedPricePolicy", admin, [
    reporterAddresses,
    THRESHOLD,
    POLICY_ID,
    10000,
    1000,
    MAX_AGE,
  ]);
  const report = demoPriceReport(
    Number((await provider.getBlock("latest")).timestamp),
  );
  const publishPrices = (low, current, overrides) =>
    publishPricesWith(
      provider,
      oracle,
      reporters.slice(0, THRESHOLD),
      low,
      current,
      overrides,
    );
  await publishPrices(report.weekLow, report.current);
  const burner = await deployContract("MockFeeBurner", admin, [
    usdt.target,
    wbmb.target,
    oracle.target,
  ]);
  const lending = await deployContract("P2PLending", admin, [
    usdt.target,
    wbmb.target,
    oracle.target,
    burner.target,
    500,
    3600,
    86400,
    0,
    7 * 86400,
  ]);
  for (const address of addresses) {
    await (await usdt.mint(address, us(10000))).wait();
    await (await wbmb.mint(address, wb(100))).wait();
  }
  await (await wbmb.mint(burner.target, wb(10000))).wait();
  const terms = {
    aprBps: 1200,
    haircutBps: 1000,
    liquidationBps: 9500,
    duration: 30 * 86400,
    grace: 86400,
    mode: 0,
  };
  if (seed) {
    const block = await provider.getBlock("latest");
    const expires = block.timestamp + 7 * 86400;
    await (await wbmb.connect(borrower).approve(lending.target, wb(10))).wait();
    await (
      await lending
        .connect(borrower)
        .createOffer(0, us(900), wb(10), us(10), expires, terms)
    ).wait();
    await (await usdt.connect(lender).approve(lending.target, us(1000))).wait();
    await (
      await lending
        .connect(lender)
        .createOffer(1, us(1000), 0, us(10), expires, {
          ...terms,
          aprBps: 1000,
          duration: 14 * 86400,
        })
    ).wait();
  }
  return {
    provider,
    accounts,
    addresses,
    admin,
    borrower,
    lender,
    lender2,
    usdt,
    wbmb,
    oracle,
    burner,
    lending,
    terms,
    report,
    reporters,
    reporterAddresses,
    publishPrices,
  };
}
export const FIXED_TERMS = {
  aprBps: 1200,
  haircutBps: 0,
  liquidationBps: 0,
  duration: 30 * 86400,
  grace: 86400,
  mode: 1,
};
/// Oracle-free market with mock tokens: the same contract configuration intended for mainnet.
export async function deployFixedFixture(provider, { seed = false } = {}) {
  await assertLocal(provider);
  const accounts = await Promise.all(
    [0, 1, 2, 3].map((i) => provider.getSigner(i)),
  );
  const [admin, borrower, lender] = accounts;
  const addresses = await Promise.all(accounts.map((a) => a.getAddress()));
  const usdt = await deployContract("MockToken", admin, [
    "Demo USDT",
    "dUSDT",
    18,
  ]);
  const wbmb = await deployContract("MockToken", admin, [
    "Demo WBMB",
    "dWBMB",
    8,
  ]);
  const feeWallet = addresses[0];
  const lending = await deployContract("P2PLending", admin, [
    usdt.target,
    wbmb.target,
    ZeroAddress,
    feeWallet,
    500,
    3600,
    86400,
    0,
    0,
  ]);
  for (const address of addresses) {
    await (await usdt.mint(address, us(10000))).wait();
    await (await wbmb.mint(address, wb(100))).wait();
  }
  if (seed) {
    const block = await provider.getBlock("latest");
    const expires = block.timestamp + 7 * 86400;
    await (await wbmb.connect(borrower).approve(lending.target, wb(10))).wait();
    await (
      await lending
        .connect(borrower)
        .createOffer(0, us(900), wb(10), us(10), expires, FIXED_TERMS)
    ).wait();
    await (await usdt.connect(lender).approve(lending.target, us(1000))).wait();
    await (
      await lending
        .connect(lender)
        .createOffer(1, us(1000), wb(12), us(10), expires, FIXED_TERMS)
    ).wait();
  }
  return { provider, accounts, addresses, usdt, wbmb, lending, feeWallet };
}
export const COUNCIL_TERMS = {
  aprBps: 1200,
  haircutBps: 5000,
  liquidationBps: 7000,
  duration: 30 * 86400,
  grace: 86400,
  mode: 0,
};
export const COUNCIL_BONUS_BPS = 1000;
export const COUNCIL_REPORTER_INDEX = 4;
export const COUNCIL_MAX_AGE = 6 * 86400;
/// Council-price market with mock tokens. The local policy has no change interval and a wide
/// change limit so the lab can move the price freely; the limits themselves are tested in
/// tests/council.test.mjs. The default terms and bonus are the ones the web page and the BSC
/// deployment use; a test may pass its own.
export async function deployCouncilFixture(
  provider,
  { seed = false, terms = COUNCIL_TERMS, bonusBps = COUNCIL_BONUS_BPS } = {},
) {
  await assertLocal(provider);
  const accounts = await Promise.all(
    [0, 1, 2, 3].map((i) => provider.getSigner(i)),
  );
  const [admin, borrower, lender, lender2] = accounts;
  const addresses = await Promise.all(accounts.map((a) => a.getAddress()));
  const usdt = await deployContract("MockToken", admin, [
    "Demo USDT",
    "dUSDT",
    18,
  ]);
  const wbmb = await deployContract("MockToken", admin, [
    "Demo WBMB",
    "dWBMB",
    8,
  ]);
  const reporter = await provider.getSigner(COUNCIL_REPORTER_INDEX);
  const reporterAddress = await reporter.getAddress();
  const oracle = await deployContract("CouncilPricePolicy", admin, [
    [reporterAddress],
    1,
    COUNCIL_POLICY_ID,
    COUNCIL_MAX_AGE,
    9000,
    0,
  ]);
  const publishPrice = async (price) => {
    const t = Number((await provider.getBlock("latest")).timestamp);
    const report = {
      policyId: COUNCIL_POLICY_ID,
      roundId: Number(await oracle.lastRoundId()) + 1,
      price,
      confirmedAt: t,
      validUntil: t + COUNCIL_MAX_AGE - 60,
    };
    return (
      await submitCouncilReport(oracle.connect(reporter), report, [reporter])
    ).wait();
  };
  await publishPrice(us(100));
  const feeWallet = addresses[0];
  const lending = await deployContract("P2PLending", admin, [
    usdt.target,
    wbmb.target,
    oracle.target,
    feeWallet,
    500,
    3600,
    86400,
    bonusBps,
    7 * 86400,
  ]);
  for (const address of addresses) {
    await (await usdt.mint(address, us(10000))).wait();
    await (await wbmb.mint(address, wb(100))).wait();
  }
  if (seed) {
    const block = await provider.getBlock("latest");
    // 30 days, not 7: the browser lab jumps a week forward and the seeded offers must survive it.
    const expires = block.timestamp + 30 * 86400;
    await (await wbmb.connect(borrower).approve(lending.target, wb(10))).wait();
    await (
      await lending
        .connect(borrower)
        .createOffer(0, us(350), wb(10), us(10), expires, terms)
    ).wait();
    await (await usdt.connect(lender).approve(lending.target, us(1000))).wait();
    await (
      await lending
        .connect(lender)
        .createOffer(1, us(1000), 0, us(10), expires, {
          ...terms,
          aprBps: 1000,
          duration: 14 * 86400,
        })
    ).wait();
  }
  return {
    provider,
    accounts,
    addresses,
    admin,
    borrower,
    lender,
    lender2,
    usdt,
    wbmb,
    oracle,
    lending,
    feeWallet,
    terms,
    bonusBps,
    reporter,
    reporterAddress,
    publishPrice,
  };
}
export function saveDeployment(f, rpcUrl, filename = "public/deployment.json") {
  if (f.oracle && f.feeWallet) {
    const council = {
      version: 3,
      demo: true,
      policy: "council",
      chainId: 31337,
      rpcUrl,
      deployedAt: new Date().toISOString(),
      feeWallet: f.feeWallet,
      feeBps: 500,
      liquidationBonusBps: f.bonusBps,
      settlementFee: true,
      addresses: {
        usdt: f.usdt.target,
        wbmb: f.wbmb.target,
        lending: f.lending.target,
        oracle: f.oracle.target,
      },
      demoAccounts: f.addresses.slice(1),
      oracle: {
        contract: "CouncilPricePolicy",
        reporterIndex: COUNCIL_REPORTER_INDEX,
        maxAge: COUNCIL_MAX_AGE,
      },
    };
    fs.writeFileSync(filename, JSON.stringify(council, null, 2) + "\n");
    return;
  }
  if (!f.oracle) {
    const fixed = {
      version: 2,
      demo: true,
      oracleFree: true,
      chainId: 31337,
      rpcUrl,
      deployedAt: new Date().toISOString(),
      feeWallet: f.feeWallet,
      feeBps: 500,
      addresses: {
        usdt: f.usdt.target,
        wbmb: f.wbmb.target,
        lending: f.lending.target,
      },
      demoAccounts: f.addresses.slice(1),
    };
    fs.writeFileSync(filename, JSON.stringify(fixed, null, 2) + "\n");
    return;
  }
  const config = {
    version: 1,
    demo: true,
    chainId: 31337,
    rpcUrl,
    deployedAt: new Date().toISOString(),
    addresses: {
      usdt: f.usdt.target,
      wbmb: f.wbmb.target,
      oracle: f.oracle.target,
      burner: f.burner.target,
      lending: f.lending.target,
    },
    demoAccounts: f.addresses.slice(1),
    oracle: {
      contract: "SignedPricePolicy",
      reporters: f.reporterAddresses,
      reporterIndices: REPORTER_INDICES,
      threshold: THRESHOLD,
      policyId: POLICY_ID,
      maxAge: MAX_AGE,
    },
    pricePolicy:
      "서명 보고서 2-of-3 · 모의 7일 30분 구간평균 최저가 (실제 시장 데이터 아님)",
    report: f.report,
  };
  fs.writeFileSync(
    filename,
    JSON.stringify(
      config,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ) + "\n",
  );
}
