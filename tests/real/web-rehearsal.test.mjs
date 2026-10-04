// Rehearses the real-chain browser check (tests/browser-real) on the chain-56 replica with
// the real MOVN/WBMB bytecode and a throwaway mnemonic, exactly as it will run against BSC:
// the built page is served by the rehearsal server, keys stay in the test process.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AbiCoder,
  Contract,
  HDNodeWallet,
  JsonRpcProvider,
  Wallet,
  keccak256,
  parseUnits,
  toBeHex,
} from "ethers";
import { BSC } from "../../config/bsc.mjs";

describe("real-chain browser check rehearsal (replica, throwaway keys)", () => {
  const RPC_PORT = 18567,
    APP_PORT = 5188;
  const url = `http://127.0.0.1:${RPC_PORT}`;
  const phrase = Wallet.createRandom().mnemonic.phrase;
  const at = (n) =>
    HDNodeWallet.fromPhrase(phrase, undefined, `m/44'/60'/0'/0/${n}`).address;
  const BAL = ["function balanceOf(address) view returns (uint256)"];
  let child, local, dir, keyFile, record;
  async function give(token, who, amount) {
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

  before(async () => {
    child = spawn("node", ["scripts/dev-live-rehearsal.mjs"], {
      env: {
        ...process.env,
        RPC_PORT: String(RPC_PORT),
        APP_PORT: String(APP_PORT),
        MARKET: "council",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const started = Date.now();
    while (!out.includes("실서비스 화면 리허설")) {
      if (child.exitCode !== null)
        throw new Error("rehearsal server exited:\n" + out);
      if (Date.now() - started > 180000)
        throw new Error("rehearsal server did not start:\n" + out);
      await new Promise((r) => setTimeout(r, 500));
    }
    local = new JsonRpcProvider(url, 56, {
      staticNetwork: true,
      cacheTimeout: -1,
    });
    record = JSON.parse(
      fs.readFileSync(
        `.local/rehearsal-${APP_PORT}/bsc-council-movn.json`,
        "utf8",
      ),
    );
    const movn = new Contract(BSC.movn, BAL, local);
    const wbmb = new Contract(BSC.wbmb, BAL, local);
    for (const i of [0, 1])
      await local.send("hardhat_setBalance", [at(i), "0xDE0B6B3A7640000"]); // 1 BNB
    await give(movn, at(0), parseUnits("0.01", 18));
    await give(movn, at(1), parseUnits("1", 18));
    await give(wbmb, at(0), parseUnits("0.01", 8));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbmb-web-rehearsal-"));
    keyFile = path.join(dir, "throwaway.key");
    fs.writeFileSync(keyFile, phrase + "\n", { mode: 0o600 });
  });
  after(async () => {
    local?.destroy();
    child?.kill("SIGTERM");
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the browser-real suite passes against the replica with the real wallet bridge", () => {
    const r = spawnSync(
      "npx",
      [
        "playwright",
        "test",
        "-c",
        "playwright.real.config.js",
        "--reporter=line",
      ],
      {
        env: {
          ...process.env,
          WEB_URL: `http://127.0.0.1:${APP_PORT}`,
          RPC_URL: url,
          KEY_FILE: keyFile,
          RECORD: `.local/rehearsal-${APP_PORT}/bsc-council-movn.json`,
        },
        encoding: "utf8",
        timeout: 600000,
      },
    );
    const text = r.stdout + r.stderr;
    for (const line of text.split("\n"))
      if (/MOVN|posted|filled|passed|failed/.test(line))
        console.log("    " + line.trim());
    assert.equal(r.status, 0, text.slice(-4000));
    assert.match(text, /3 passed/);
    assert.match(text, /market holds MOVN/);
    // The mnemonic never appears in the Playwright output (the page itself is covered by the
    // bridge test: it only ever receives hashes and read results).
    assert.equal(
      text.includes(phrase.split(" ")[0] + " " + phrase.split(" ")[1]),
      false,
    );
  });
});
