// Runs P2PLending against the REAL USDT and WBMB contracts: their deployed bytecode and
// storage are downloaded from BSC mainnet (read-only) and installed at the same addresses
// on a local chain. Test balances are written straight into local storage.
// Public RPCs do not serve the historical state a full fork needs, hence this replica.
// Nothing here sends a transaction to the real chain.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import {
  BrowserProvider,
  JsonRpcProvider,
  Contract,
  ZeroAddress,
  AbiCoder,
  keccak256,
  formatUnits,
  toBeHex,
} from "ethers";
import { deployContract, us, wb } from "../../scripts/deploy.mjs";
import { BSC } from "../../config/bsc.mjs";

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];

async function installRealToken(local, real, address) {
  const code = await real.getCode(address);
  assert.ok(code.length > 2, "real token code not found");
  await local.send("hardhat_setCode", [address, code]);
  for (let slot = 0; slot < 16; slot++) {
    const value = await real.getStorage(address, slot);
    if (BigInt(value) !== 0n)
      await local.send("hardhat_setStorageAt", [address, toBeHex(slot), value]);
  }
}
// Finds the balances mapping slot by trial, then credits `amount` to `who`.
async function give(local, token, who, amount) {
  for (let slot = 0; slot < 16; slot++) {
    const key = keccak256(
      AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [who, slot]),
    );
    const old = await local.getStorage(token.target, key);
    await local.send("hardhat_setStorageAt", [
      token.target,
      key,
      toBeHex(amount, 32),
    ]);
    if ((await token.balanceOf(who)) === amount) return;
    await local.send("hardhat_setStorageAt", [token.target, key, old]);
  }
  throw new Error("balance slot not found");
}

describe("real BSC USDT and WBMB bytecode", () => {
  let c, provider, usdt, wbmb, lending, borrower, lender, feeWallet, A;
  const gas = {};
  const TERMS = {
    aprBps: 1200,
    haircutBps: 0,
    liquidationBps: 0,
    duration: 30 * 86400,
    grace: 86400,
    mode: 1,
  };
  const tx = async (label, p) => {
    const r = await (await p).wait();
    if (label) gas[label] = r.gasUsed;
    return r;
  };
  const now = async () => Number((await provider.getBlock("latest")).timestamp);
  async function advance(s) {
    await provider.send("evm_increaseTime", [s]);
    await provider.send("evm_mine", []);
  }
  async function conserved() {
    const [u, w] = await lending.liabilities();
    assert.equal(await usdt.balanceOf(lending.target), u);
    assert.equal(await wbmb.balanceOf(lending.target), w);
  }

  before(async () => {
    c = await network.create();
    provider = new BrowserProvider(c.provider, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 10;
    const real = new JsonRpcProvider(
      process.env.BSC_RPC_URL || BSC.rpcUrl,
      BSC.chainId,
      { staticNetwork: true },
    );
    const [admin, b, l, f] = await Promise.all(
      [0, 1, 2, 7].map((i) => provider.getSigner(i)),
    );
    borrower = b;
    lender = l;
    feeWallet = f;
    A = {
      borrower: await b.getAddress(),
      lender: await l.getAddress(),
      fee: await f.getAddress(),
    };
    usdt = new Contract(BSC.usdt, ERC20, provider);
    wbmb = new Contract(BSC.wbmb, ERC20, provider);
    await installRealToken(provider, real, BSC.usdt);
    await installRealToken(provider, real, BSC.wbmb);
    real.destroy();
    await give(provider, wbmb, A.borrower, wb(20));
    await give(provider, usdt, A.borrower, us(100));
    await give(provider, usdt, A.lender, us(3000));
    lending = await deployContract("P2PLending", admin, [
      BSC.usdt,
      BSC.wbmb,
      ZeroAddress,
      A.fee,
      BSC.feeBps,
    ]);
    gas.deploy = (await lending.deploymentTransaction().wait()).gasUsed;
  });
  after(async () => {
    if (provider) {
      const price = 100000000n; // 0.1 gwei, BSC floor-level gas price; adjust if the chain price differs
      console.log("\n  gas used (BNB cost at 0.1 gwei):");
      for (const [k, v] of Object.entries(gas))
        console.log(
          `    ${k.padEnd(14)} ${String(v).padStart(8)}  ${formatUnits(v * price, 18)} BNB`,
        );
    }
    provider?.destroy();
    await c?.close();
  });

  it("real tokens have the decimals the contract requires", async () => {
    assert.equal(await usdt.decimals(), 18n);
    assert.equal(await wbmb.decimals(), 8n);
    assert.equal(await wbmb.balanceOf(A.borrower), wb(20));
  });

  it("borrow offer: escrow, partial fill, interest, full repayment, claims — exact balances with real tokens", async () => {
    await tx("approve", wbmb.connect(borrower).approve(lending.target, wb(10)));
    await tx(
      "createOffer",
      lending
        .connect(borrower)
        .createOffer(0, us(900), wb(10), us(10), (await now()) + 604800, TERMS),
    );
    assert.equal(await wbmb.balanceOf(lending.target), wb(10));
    await tx(null, usdt.connect(lender).approve(lending.target, us(90)));
    const before_ = await usdt.balanceOf(A.borrower);
    await tx(
      "fillOffer",
      lending.connect(lender).fillOffer(1, us(90), wb(1), (await now()) + 300),
    );
    assert.equal((await usdt.balanceOf(A.borrower)) - before_, us(90));
    await conserved();
    await advance(30 * 86400);
    const [interest, fee, total] = await lending.quoteRepay(1, us(90));
    assert.equal(interest, 887671232876712329n); // 90 * 12% * 30/365, rounded up
    await tx(null, usdt.connect(borrower).approve(lending.target, total));
    await tx("repay", lending.connect(borrower).repay(1, us(90), total));
    const w0 = await wbmb.balanceOf(A.borrower),
      u0 = await usdt.balanceOf(A.lender),
      f0 = await usdt.balanceOf(A.fee);
    await tx("claimWBMB", lending.connect(borrower).claimWBMB());
    await tx("claimUSDT", lending.connect(lender).claimUSDT());
    await tx("flushFees", lending.flushFees());
    assert.equal((await wbmb.balanceOf(A.borrower)) - w0, wb(1));
    assert.equal((await usdt.balanceOf(A.lender)) - u0, us(90) + interest);
    assert.equal((await usdt.balanceOf(A.fee)) - f0, fee);
    await tx("closeOffer", lending.connect(borrower).closeOffer(1));
    await tx(null, lending.connect(borrower).claimWBMB());
    await conserved();
    assert.equal(await wbmb.balanceOf(lending.target), 0n);
    assert.equal(await usdt.balanceOf(lending.target), 0n);
  });

  it("lend offer: borrower posts the fixed collateral, defaults, lender receives real WBMB after grace", async () => {
    await tx(null, usdt.connect(lender).approve(lending.target, us(1000)));
    await tx(
      null,
      lending
        .connect(lender)
        .createOffer(
          1,
          us(1000),
          wb(12),
          us(10),
          (await now()) + 604800,
          TERMS,
        ),
    );
    const collateral = await lending.quoteFill(2, us(250));
    assert.equal(collateral, wb(3));
    await tx(null, wbmb.connect(borrower).approve(lending.target, collateral));
    await tx(
      null,
      lending
        .connect(borrower)
        .fillOffer(2, us(250), collateral, (await now()) + 300),
    );
    const loan = await lending.loanCount();
    await assert.rejects(lending.settle(loan), /NOT_OVERDUE/);
    await advance(31 * 86400 + 1);
    await tx("settle", lending.settle(loan));
    const w0 = await wbmb.balanceOf(A.lender);
    await tx(null, lending.connect(lender).claimWBMB());
    assert.equal((await wbmb.balanceOf(A.lender)) - w0, wb(3));
    await tx(null, lending.connect(lender).closeOffer(2));
    await tx(null, lending.connect(lender).claimUSDT());
    await conserved();
    assert.equal(await wbmb.balanceOf(lending.target), 0n);
    assert.equal(await usdt.balanceOf(lending.target), 0n);
  });
});
