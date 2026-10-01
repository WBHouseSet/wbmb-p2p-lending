import fs from "node:fs";
import { ContractFactory, parseUnits } from "ethers";
import { demoPriceReport } from "../src/prices.mjs";

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
  const oracle = await deployContract("MockPricePolicy", admin);
  const report = demoPriceReport(
    Number((await provider.getBlock("latest")).timestamp),
  );
  await (await oracle.setPrices(report.weekLow, report.current)).wait();
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
  };
}
export function saveDeployment(f, rpcUrl, filename = "public/deployment.json") {
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
    pricePolicy: "모의 7일 · 30분 구간평균 최저가 (실제 시장 데이터 아님)",
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
