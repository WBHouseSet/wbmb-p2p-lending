# TLS-Proof Council Price Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The council price reaches the chain as a Primus zkTLS attestation of `https://movnvote.com/api/public/price/latest` that anyone may submit, replacing the operator-held reporter key.

**Architecture:** A new immutable `TlsCouncilPricePolicy` implements the existing `IPricePolicy`, so `P2PLending` is unchanged. It verifies one attestor signature itself against an attestor address fixed at deployment (it does NOT call Primus's upgradeable verifier), pins the attested request and response selector by hash, parses the price out of the attested data, and keeps today's limits (bounded change per interval, validity window, lower-of-two opening price). A relay script produces the attestation off-chain and submits it; it holds no price authority.

**Tech Stack:** Solidity 0.8.37 (solc, viaIR), ethers 6, Hardhat 3 (local chain only), node:test, `@primuslabs/zktls-core-sdk` (dev dependency, relay only).

**Spec:** No separate spec. The design section below is the agreed design (conversation of 2026-10-06); status of each decision is marked.

## Design

Facts checked on 2026-10-06:

- The council API answers over TLS 1.2 with a 76-byte JSON body: `{"price":118.3,"date":"2026-10-05","confirmedAt":"2026-10-05T03:00:50.211Z"}`.
- Primus's verifier on BSC is `0xF24199D5D431bE869af3Da61162CbBb58C389324`, a transparent upgradeable proxy. It has one registered attestor, `0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6`, which is also the contract owner and can add or remove attestors. `verifyAttestation` checks only that one signature recovers to a registered attestor; it checks no timestamp.
- The signed hash is `keccak256(abi.encodePacked(recipient, requestHash, responseHash, data, attConditions, timestamp, additionParams))` with `requestHash = keccak256(abi.encodePacked(url, header, method, body))` and `responseHash = keccak256` of the concatenated `keyName, parseType, parsePath` of every selector (source: `primus-labs/zktls-contracts`, `src/PrimusZKTLS.sol`).

Decisions:

| Decision | Value | Status |
|---|---|---|
| Proof service | Primus (only one with a verifier checked on BSC) | chosen |
| Attestor trust | attestor address fixed in our contract; Primus's proxy is never called | recommended, user has not objected — confirm before any deploy |
| Who may submit | anyone | follows from the goal |
| Attested field | `price` only; the on-chain "confirmed" time becomes the attestation time | my decision (avoids parsing ISO dates on-chain) |
| Move above `maxChangeBps` | clamped to one maximum step toward the attested price, instead of reverting | my decision (a signer can no longer invent the intermediate price) |
| Price change inside `minInterval` | rejected (`TOO_SOON`); a same-price attestation refreshes validity at any time | unchanged behaviour |
| Attestation freshness | at most 1 hour old, strictly newer than the last accepted one | my decision |

What this does NOT give: protection if movnvote.com itself serves a wrong number, or if Primus's single attestor key signs a false attestation. Both stay bounded by `maxChangeBps` per `minInterval`. If Primus rotates its key, no new price is accepted and loans fall back to the existing stale-price settlement; a new policy and market must then be deployed.

Assumptions Task 1 must confirm with a real attestation (stop and report if any is false):

1. `attestation.data` is exactly `{"price":"<decimal>"}` — the selected value as a quoted string, nothing else.
2. `attestation.timestamp` is in milliseconds.
3. The core SDK produces an attestation from Node with no browser, given an app id and secret.
4. The signature is 65 bytes over the raw hash above (no EIP-191 prefix) and recovers to `0xDB73…8eF6`.

## Global Constraints

- `P2PLending.sol`, `IPricePolicy.sol`, `CouncilPricePolicy.sol` and every existing `deployments/*.json` are NOT edited. The existing council market keeps working.
- Limits unchanged from `config/bsc.mjs`: `maxAge` 6 days, `maxChangeBps` 3000, `minInterval` 86400 (300 on the test profile). New: `maxProofAge` 3600 seconds.
- Attested URL is exactly `https://movnvote.com/api/public/price/latest`, method `GET`, empty body.
- Prices are MOVN base units (18 decimals) per whole WBMB, as in `IPricePolicy`.
- Primus credentials live outside the repo in `~/.wbmb-p2p/primus.env` (`PRIMUS_APP_ID`, `PRIMUS_APP_SECRET`); never commit them, never print the secret.
- Nothing is broadcast to BSC before Task 5, and Task 5's deploy step needs the user's explicit go-ahead in that session.
- Dependencies are pinned to exact versions (`npm i -D -E`).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Korean user-facing text; English code comments, matching the files' current style.

## Review Focus

1. An attestation for a different URL, or the same URL with an added request header (for example a `Host` override that could route to another site behind the same certificate), must be rejected — Task 2 test "rejects a foreign request".
2. An attestation signed by any key other than the fixed attestor, including one Primus adds to its own contract later, must be rejected — Task 2 test "rejects other signers".
3. An old attestation replayed after a newer one, or one older than `maxProofAge`, must be rejected, so a past (higher) price cannot be restored — Task 2 test "rejects stale and replayed proofs".
4. Data that is not exactly one plain decimal (`1e3`, `-1`, `1.`, `.5`, 19 decimals, trailing fields, empty) must be rejected, not guessed — Task 2 test "rejects malformed data".
5. A real Primus attestation, unmodified, must be accepted by the contract and yield the API's price — Task 3 (guards against any mismatch between our hash and Primus's).

---

### Task 1: Obtain one real attestation and record the format

**Files:**
- Create: `scripts/attest-council.mjs`
- Create: `src/tls-attestation.mjs`
- Create: `tests/fixtures/primus-council-attestation.json`
- Modify: `package.json` (dev dependency)

**Interfaces:**
- Produces: `fetchCouncilAttestation({ appId, appSecret }) → Promise<Attestation>` (plain object in the Solidity struct's field order and names, including the upstream spelling `reponseResolve`); constants `PRIMUS_ATTESTOR`, `COUNCIL_REQUEST`, `COUNCIL_RESPONSE`; functions `attestationHash(att) → bytes32 hex`, `requestHash(req)`, `responseHash(resolves)`, `recoverAttestor(att) → address`.

**Precondition (user action):** the user creates a project at the Primus Developer Hub and puts the app id and secret in `~/.wbmb-p2p/primus.env`. Without it this task cannot run; stop and ask.

- [ ] **Step 1: Install the SDK and read its README**

```bash
npm i -D -E @primuslabs/zktls-core-sdk
sed -n 1,200p node_modules/@primuslabs/zktls-core-sdk/README.md
```

The calls used in Step 3 come from Primus's published "simple example". If the installed version names them differently, follow the README and keep `fetchCouncilAttestation`'s signature.

- [ ] **Step 2: Write `src/tls-attestation.mjs`**

```js
// Hashing and signature recovery for Primus zkTLS attestations, mirroring PrimusZKTLS.sol.
// Shared by the relay, the tests and the deploy script. No network, no clock.
import {
  concat,
  getAddress,
  keccak256,
  recoverAddress,
  solidityPacked,
  toUtf8Bytes,
} from "ethers";
import { COUNCIL_API_URL } from "./council-relay.mjs";

// The only attestor registered in Primus's BSC verifier on 2026-10-06.
export const PRIMUS_ATTESTOR = getAddress(
  "0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6",
);
export const COUNCIL_REQUEST = {
  url: COUNCIL_API_URL,
  header: "",
  method: "GET",
  body: "",
};
export const COUNCIL_RESPONSE = [
  { keyName: "price", parseType: "", parsePath: "$.price" },
];

export function requestHash(r) {
  return keccak256(
    solidityPacked(
      ["string", "string", "string", "string"],
      [r.url, r.header, r.method, r.body],
    ),
  );
}

export function responseHash(resolves) {
  return keccak256(
    concat(
      resolves.map((x) =>
        solidityPacked(
          ["string", "string", "string"],
          [x.keyName, x.parseType, x.parsePath],
        ),
      ),
    ),
  );
}

export function conditionsHash(att) {
  return keccak256(toUtf8Bytes(att.attConditions));
}

export function attestationHash(a) {
  return keccak256(
    solidityPacked(
      ["address", "bytes32", "bytes32", "string", "string", "uint64", "string"],
      [
        a.recipient,
        requestHash(a.request),
        responseHash(a.reponseResolve),
        a.data,
        a.attConditions,
        a.timestamp,
        a.additionParams,
      ],
    ),
  );
}

export function recoverAttestor(a) {
  return recoverAddress(attestationHash(a), a.signatures[0]);
}
```

- [ ] **Step 3: Write `scripts/attest-council.mjs`**

```js
// Asks Primus for a zkTLS attestation of the council price API and prints it as JSON.
// Usage: node --env-file=$HOME/.wbmb-p2p/primus.env scripts/attest-council.mjs [out.json]
import fs from "node:fs";
import { createRequire } from "node:module";
import { COUNCIL_REQUEST, COUNCIL_RESPONSE } from "../src/tls-attestation.mjs";

const { PrimusCoreTLS } = createRequire(import.meta.url)(
  "@primuslabs/zktls-core-sdk",
);

export async function fetchCouncilAttestation({ appId, appSecret }) {
  if (!appId || !appSecret)
    throw new Error("PRIMUS_APP_ID / PRIMUS_APP_SECRET 가 필요합니다.");
  const zk = new PrimusCoreTLS();
  await zk.init(appId, appSecret);
  const params = zk.generateRequestParams(
    {
      url: COUNCIL_REQUEST.url,
      method: COUNCIL_REQUEST.method,
      header: {},
      body: "",
    },
    COUNCIL_RESPONSE.map(({ keyName, parsePath }) => ({ keyName, parsePath })),
  );
  params.setAttMode({ algorithmType: "proxytls" });
  const att = await zk.startAttestation(params);
  if (!zk.verifyAttestation(att))
    throw new Error("Primus 증명 서명이 검증되지 않았습니다.");
  return att;
}

if (process.argv[1]?.endsWith("attest-council.mjs")) {
  const att = await fetchCouncilAttestation({
    appId: process.env.PRIMUS_APP_ID,
    appSecret: process.env.PRIMUS_APP_SECRET,
  });
  const text = JSON.stringify(att, null, 2);
  if (process.argv[2]) fs.writeFileSync(process.argv[2], text + "\n");
  else console.log(text);
  process.exit(0);
}
```

- [ ] **Step 4: Capture the fixture**

```bash
mkdir -p tests/fixtures
node --env-file=$HOME/.wbmb-p2p/primus.env scripts/attest-council.mjs tests/fixtures/primus-council-attestation.json
```

Expected: a JSON file with `request.url` equal to the council API URL, a `data` string and one 65-byte signature. Read it and confirm it holds no app secret.

- [ ] **Step 5: Check the four assumptions against the fixture and the chain**

```bash
node -e '
import("./src/tls-attestation.mjs").then(async (m) => {
  const { JsonRpcProvider, Contract } = await import("ethers");
  const a = JSON.parse(require("fs").readFileSync("tests/fixtures/primus-council-attestation.json", "utf8"));
  console.log("data      ", a.data);
  console.log("timestamp ", a.timestamp, new Date(Number(a.timestamp)).toISOString());
  console.log("header    ", JSON.stringify(a.request.header), "resolve", JSON.stringify(a.reponseResolve));
  console.log("conditions", a.attConditions, "| addition", a.additionParams);
  console.log("signer    ", m.recoverAttestor(a), "expected", m.PRIMUS_ATTESTOR);
  const abi = ["function verifyAttestation((address recipient,(string url,string header,string method,string body) request,(string keyName,string parseType,string parsePath)[] reponseResolve,string data,string attConditions,uint64 timestamp,string additionParams,(address attestorAddr,string url)[] attestors,bytes[] signatures) attestation) view"];
  const c = new Contract("0xF24199D5D431bE869af3Da61162CbBb58C389324", abi, new JsonRpcProvider("https://bsc-dataseed.binance.org"));
  await c.verifyAttestation(a); console.log("Primus BSC verifier accepts it");
});'
```

Expected: `data` is `{"price":"<number>"}`; the timestamp prints a date within the last minutes when read as milliseconds; `signer` equals `expected`; the last line prints. Then set `COUNCIL_REQUEST.header` and `COUNCIL_RESPONSE[0].parseType` in `src/tls-attestation.mjs` to the fixture's exact strings. If `data`, the timestamp unit or the signer differ from the assumptions, STOP and report: Task 2's contract is written for exactly these.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/attest-council.mjs src/tls-attestation.mjs tests/fixtures/primus-council-attestation.json
git commit -m "feat(tls-price): fetch a Primus attestation of the council price, record a real fixture"
```

---

### Task 2: `TlsCouncilPricePolicy` contract and unit tests

**Files:**
- Create: `contracts/TlsCouncilPricePolicy.sol`
- Create: `tests/tls-council.test.mjs`

**Interfaces:**
- Consumes: `attestationHash`, `requestHash`, `responseHash`, `conditionsHash`, `COUNCIL_REQUEST`, `COUNCIL_RESPONSE` from `src/tls-attestation.mjs`; `deployContract`, `us` from `scripts/deploy.mjs`.
- Produces: contract `TlsCouncilPricePolicy(address attestor, bytes32 requestHash, bytes32 responseHash, bytes32 conditionsHash, uint256 maxAge, uint256 maxChangeBps, uint256 minInterval, uint256 maxProofAge)` with `submit(Attestation)`, the `IPricePolicy` views, and public `attestor`, `requestHash`, `responseHash`, `conditionsHash`, `maxAge`, `maxChangeBps`, `minInterval`, `maxProofAge`, `previous`, `current`, `confirmedAt`, `validUntil`, `changedAt`, `lastRoundId`. Event `ProofAccepted(uint64 indexed roundId, uint256 attested, uint256 price, uint64 confirmedAt, uint64 validUntil)`.

- [ ] **Step 1: Write the failing tests**

`tests/tls-council.test.mjs`:

```js
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { BrowserProvider, Wallet } from "ethers";
import { deployContract, us } from "../scripts/deploy.mjs";
import {
  COUNCIL_REQUEST,
  COUNCIL_RESPONSE,
  attestationHash,
  requestHash,
  responseHash,
} from "../src/tls-attestation.mjs";

describe("TlsCouncilPricePolicy", () => {
  let c, provider, admin, oracle, attestor, snap;
  const MAX_AGE = 6 * 86400;
  const MIN_INTERVAL = 43200;
  const PROOF_AGE = 3600;
  const CONDITIONS = "";
  const tx = async (p) => (await p).wait();
  const now = async () => Number((await provider.getBlock("latest")).timestamp);
  async function advance(s) {
    await provider.send("evm_increaseTime", [s]);
    await provider.send("evm_mine", []);
  }
  // Attestor signs the raw hash, as Primus does (no EIP-191 prefix).
  async function proof(price, over = {}, signer = attestor) {
    const a = {
      recipient: admin.address,
      request: { ...COUNCIL_REQUEST },
      reponseResolve: COUNCIL_RESPONSE.map((x) => ({ ...x })),
      data: `{"price":"${price}"}`,
      attConditions: CONDITIONS,
      timestamp: BigInt(await now()) * 1000n,
      additionParams: "",
      attestors: [],
      ...over,
    };
    a.signatures = [signer.signingKey.sign(attestationHash(a)).serialized];
    return a;
  }
  const submit = async (price, over, signer) =>
    tx(oracle.submit(await proof(price, over, signer)));
  const refuses = (p, reason) => assert.rejects(p, new RegExp(reason));

  before(async () => {
    c = await network.create();
    provider = new BrowserProvider(c.provider, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 10;
    admin = await provider.getSigner(0);
    attestor = Wallet.createRandom();
    const { keccak256, toUtf8Bytes } = await import("ethers");
    oracle = await deployContract("TlsCouncilPricePolicy", admin, [
      attestor.address,
      requestHash(COUNCIL_REQUEST),
      responseHash(COUNCIL_RESPONSE),
      keccak256(toUtf8Bytes(CONDITIONS)),
      MAX_AGE,
      3000,
      MIN_INTERVAL,
      PROOF_AGE,
    ]);
    snap = await provider.send("evm_snapshot", []);
  });
  beforeEach(async () => {
    await provider.send("evm_revert", [snap]);
    snap = await provider.send("evm_snapshot", []);
  });
  after(async () => {
    provider?.destroy();
    await c?.close();
  });

  it("has no price before the first proof and serves it after", async () => {
    await refuses(oracle.prices(), "STALE_PRICE");
    await submit("118.3");
    assert.deepEqual([...(await oracle.prices())], [us("118.3"), us("118.3")]);
    assert.equal(await oracle.lastRoundId(), 1n);
    assert.equal(await oracle.validUntil(), (await oracle.confirmedAt()) + BigInt(MAX_AGE));
  });

  it("rejects other signers", async () => {
    await refuses(submit("118.3", {}, Wallet.createRandom()), "BAD_ATTESTOR");
    const a = await proof("118.3");
    a.data = '{"price":"200"}';
    await refuses(oracle.submit(a), "BAD_ATTESTOR");
    a.signatures = [a.signatures[0], a.signatures[0]];
    await refuses(oracle.submit(a), "BAD_SIGNATURE");
  });

  it("rejects a foreign request", async () => {
    const req = (over) => ({ request: { ...COUNCIL_REQUEST, ...over } });
    await refuses(submit("1", req({ url: "https://evil.example/api/public/price/latest" })), "BAD_REQUEST");
    await refuses(submit("1", req({ header: '{"Host":"evil.example"}' })), "BAD_REQUEST");
    await refuses(submit("1", req({ method: "POST" })), "BAD_REQUEST");
    await refuses(submit("1", req({ body: "x" })), "BAD_REQUEST");
    await refuses(
      submit("1", { reponseResolve: [{ keyName: "price", parseType: "", parsePath: "$.date" }] }),
      "BAD_RESPONSE",
    );
    await refuses(submit("1", { attConditions: '{"op":">"}' }), "BAD_CONDITIONS");
  });

  it("rejects malformed data", async () => {
    for (const data of [
      "", "{}", '{"price":""}', '{"price":"1e3"}', '{"price":"-1"}', '{"price":"1."}',
      '{"price":".5"}', '{"price":"1.2.3"}', '{"price":"1.0000000000000000001"}',
      '{"price":"1","x":"2"}', '{"price":118.3}', ' {"price":"1"}', '{"price":"0"}',
      '{"price":"1000000000001"}',
    ])
      await refuses(submit("1", { data }), "BAD_DATA|BAD_PRICE");
    await submit("0.000000000000000001");
    assert.equal(await oracle.current(), 1n);
  });

  it("rejects stale and replayed proofs", async () => {
    const t = BigInt(await now());
    await refuses(submit("100", { timestamp: (t - BigInt(PROOF_AGE) - 5n) * 1000n }), "BAD_TIME");
    await refuses(submit("100", { timestamp: (t + 600n) * 1000n }), "BAD_TIME");
    const first = await proof("100");
    await tx(oracle.submit(first));
    await refuses(oracle.submit(first), "BAD_TIME");
    await advance(60);
    await submit("100");
    await refuses(oracle.submit(first), "BAD_TIME");
  });

  it("clamps a move above maxChangeBps to one step in either direction", async () => {
    await submit("100");
    await advance(MIN_INTERVAL);
    await submit("200");
    assert.equal(await oracle.current(), us("130"));
    await advance(MIN_INTERVAL);
    await submit("10");
    assert.equal(await oracle.current(), us("91"));
    await advance(MIN_INTERVAL);
    await submit("95");
    assert.equal(await oracle.current(), us("95"));
  });

  it("makes a second change wait minInterval but accepts same-price refreshes any time", async () => {
    await submit("100");
    await advance(60);
    await refuses(submit("101"), "TOO_SOON");
    const before = await oracle.validUntil();
    await submit("100");
    assert.ok((await oracle.validUntil()) > before);
    assert.equal(await oracle.lastRoundId(), 2n);
  });

  it("opening price holds the lower of previous and current for minInterval after a rise", async () => {
    await submit("100");
    await advance(MIN_INTERVAL);
    await submit("110");
    assert.deepEqual([...(await oracle.prices())], [us("100"), us("110")]);
    await advance(MIN_INTERVAL);
    await submit("110");
    assert.deepEqual([...(await oracle.prices())], [us("110"), us("110")]);
  });

  it("goes stale after validUntil and resumes with the next proof", async () => {
    await submit("100");
    await advance(MAX_AGE + 1);
    await refuses(oracle.prices(), "STALE_PRICE");
    assert.equal(await oracle.current(), us("100"));
    await submit("100");
    assert.equal((await oracle.prices())[1], us("100"));
  });

  it("constructor rejects a zero attestor and bad limits", async () => {
    const good = [attestor.address, requestHash(COUNCIL_REQUEST), responseHash(COUNCIL_RESPONSE),
      "0x" + "11".repeat(32), MAX_AGE, 3000, MIN_INTERVAL, PROOF_AGE];
    const bad = (i, v) => good.map((x, j) => (j === i ? v : x));
    const zero = "0x" + "00".repeat(20);
    await refuses(deployContract("TlsCouncilPricePolicy", admin, bad(0, zero)), "BAD_ATTESTOR");
    await refuses(deployContract("TlsCouncilPricePolicy", admin, bad(1, "0x" + "00".repeat(32))), "BAD_HASH");
    for (const [i, v] of [[4, 60], [4, 15 * 86400], [5, 0], [5, 10000], [6, 8 * 86400], [7, 0], [7, 86401]])
      await refuses(deployContract("TlsCouncilPricePolicy", admin, bad(i, v)), "BAD_LIMITS");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run compile && node --test --test-concurrency=1 tests/tls-council.test.mjs`
Expected: FAIL — no artifact named `TlsCouncilPricePolicy`.

- [ ] **Step 3: Write the contract**

`contracts/TlsCouncilPricePolicy.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPricePolicy} from "./IPricePolicy.sol";

/// Field order and names follow Primus's PrimusZKTLS.sol (including its spelling), because the
/// attestor signs a hash over exactly these fields.
struct AttNetworkRequest {
    string url;
    string header;
    string method;
    string body;
}

struct AttNetworkResponseResolve {
    string keyName;
    string parseType;
    string parsePath;
}

struct Attestor {
    address attestorAddr;
    string url;
}

struct Attestation {
    address recipient;
    AttNetworkRequest request;
    AttNetworkResponseResolve[] reponseResolve;
    string data;
    string attConditions;
    uint64 timestamp; // milliseconds
    string additionParams;
    Attestor[] attestors;
    bytes[] signatures;
}

/// Mobick council price proven by a zkTLS attestation of the council's own API. Anyone may
/// submit; there is no reporter key. The attestor, the attested request and all limits are
/// immutable: replacing them means deploying a new policy and a new lending market.
/// It proves the API answered with this number as seen by the attestor. It cannot prove the
/// API was right, nor that the attestor was honest; both are bounded by the change limit.
contract TlsCouncilPricePolicy is IPricePolicy {
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_PRICE = 1e30;

    address public immutable attestor;
    bytes32 public immutable requestHash;
    bytes32 public immutable responseHash;
    bytes32 public immutable conditionsHash;
    uint256 public immutable maxAge;
    uint256 public immutable maxChangeBps;
    uint256 public immutable minInterval;
    uint256 public immutable maxProofAge;

    uint256 public previous;
    uint256 public current;
    uint64 public confirmedAt; // time of the last accepted attestation
    uint64 public validUntil;
    uint64 public changedAt;
    uint64 public lastRoundId;

    event ProofAccepted(uint64 indexed roundId, uint256 attested, uint256 price, uint64 confirmedAt, uint64 validUntil);

    constructor(
        address attestor_,
        bytes32 requestHash_,
        bytes32 responseHash_,
        bytes32 conditionsHash_,
        uint256 maxAge_,
        uint256 maxChangeBps_,
        uint256 minInterval_,
        uint256 maxProofAge_
    ) {
        require(attestor_ != address(0), "BAD_ATTESTOR");
        require(requestHash_ != bytes32(0) && responseHash_ != bytes32(0), "BAD_HASH");
        require(
            maxAge_ >= 1 hours && maxAge_ <= 14 days && maxChangeBps_ >= 1 && maxChangeBps_ < BPS
                && minInterval_ <= 7 days && maxProofAge_ >= 1 && maxProofAge_ <= 1 days,
            "BAD_LIMITS"
        );
        attestor = attestor_; requestHash = requestHash_; responseHash = responseHash_;
        conditionsHash = conditionsHash_; maxAge = maxAge_; maxChangeBps = maxChangeBps_;
        minInterval = minInterval_; maxProofAge = maxProofAge_;
    }

    function hashRequest(AttNetworkRequest calldata r) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(r.url, r.header, r.method, r.body));
    }

    function hashResponse(AttNetworkResponseResolve[] calldata r) public pure returns (bytes32) {
        bytes memory packed;
        for (uint256 i; i < r.length; i++) {
            packed = abi.encodePacked(packed, r[i].keyName, r[i].parseType, r[i].parsePath);
        }
        return keccak256(packed);
    }

    /// Anyone may submit. The request is pinned as a whole (URL, headers, method, body), so a
    /// header that reroutes the request cannot pass as the council API.
    function submit(Attestation calldata a) external {
        bytes32 req = hashRequest(a.request);
        bytes32 res = hashResponse(a.reponseResolve);
        require(req == requestHash, "BAD_REQUEST");
        require(res == responseHash, "BAD_RESPONSE");
        require(keccak256(bytes(a.attConditions)) == conditionsHash, "BAD_CONDITIONS");
        require(a.signatures.length == 1 && a.signatures[0].length == 65, "BAD_SIGNATURE");
        bytes32 digest = keccak256(
            abi.encodePacked(a.recipient, req, res, a.data, a.attConditions, a.timestamp, a.additionParams)
        );
        bytes calldata sig = a.signatures[0];
        require(ecrecover(digest, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64])) == attestor, "BAD_ATTESTOR");
        // Strictly newer than the last accepted proof: an old answer cannot be replayed.
        uint64 at = a.timestamp / 1000;
        require(at > confirmedAt && at <= block.timestamp && block.timestamp - at <= maxProofAge, "BAD_TIME");
        uint256 attested = _parsePrice(a.data);
        require(attested > 0 && attested <= MAX_PRICE, "BAD_PRICE");

        uint256 next = attested;
        if (lastRoundId == 0) {
            previous = attested; changedAt = uint64(block.timestamp);
        } else if (attested != current) {
            require(block.timestamp >= uint256(changedAt) + minInterval, "TOO_SOON");
            // A larger move is taken one maximum step at a time; the next proof continues it.
            uint256 most = (current * maxChangeBps) / BPS;
            if (attested > current) {
                if (attested - current > most) next = current + most;
            } else if (current - attested > most) {
                next = current - most;
            }
            previous = current; changedAt = uint64(block.timestamp);
        }
        current = next; confirmedAt = at; validUntil = at + uint64(maxAge); lastRoundId += 1;
        emit ProofAccepted(lastRoundId, attested, next, at, validUntil);
    }

    /// Accepts exactly {"price":"<digits>[.<1-18 digits>]"} and nothing else.
    function _parsePrice(string calldata data) internal pure returns (uint256 price) {
        bytes calldata b = bytes(data);
        bytes memory head = bytes('{"price":"');
        uint256 n = b.length;
        require(n >= head.length + 3 && n <= head.length + 35, "BAD_DATA");
        for (uint256 i; i < head.length; i++) require(b[i] == head[i], "BAD_DATA");
        require(b[n - 2] == '"' && b[n - 1] == "}", "BAD_DATA");
        uint256 whole; uint256 frac; bool dot;
        for (uint256 i = head.length; i < n - 2; i++) {
            bytes1 ch = b[i];
            if (ch == ".") {
                require(!dot && whole > 0, "BAD_DATA");
                dot = true;
                continue;
            }
            require(ch >= "0" && ch <= "9", "BAD_DATA");
            price = price * 10 + (uint8(ch) - 48);
            if (dot) frac++; else whole++;
        }
        require(whole > 0 && frac <= 18 && (!dot || frac > 0), "BAD_DATA");
        price *= 10 ** (18 - frac);
    }

    /// Opening price stays at the lower of the last two prices for minInterval after a change,
    /// so a fresh rise cannot be borrowed against immediately.
    function prices() external view returns (uint256, uint256) {
        require(validUntil != 0 && block.timestamp <= validUntil, "STALE_PRICE");
        bool held = block.timestamp < uint256(changedAt) + minInterval;
        return (held && previous < current ? previous : current, current);
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm run compile && node --test --test-concurrency=1 tests/tls-council.test.mjs`
Expected: PASS, 10 tests. Then `npm test` — all earlier tests still pass.

- [ ] **Step 5: Commit**

```bash
git add contracts/TlsCouncilPricePolicy.sol tests/tls-council.test.mjs
git commit -m "feat(tls-price): TlsCouncilPricePolicy - council price accepted from a pinned-attestor zkTLS proof"
```

---

### Task 3: The real attestation passes the contract

**Files:**
- Modify: `tests/tls-council.test.mjs` (append a second `describe`)

**Interfaces:**
- Consumes: the Task 1 fixture; `PRIMUS_ATTESTOR`, `conditionsHash`, `requestHash`, `responseHash`, `recoverAttestor` from `src/tls-attestation.mjs`.

- [ ] **Step 1: Add the test**

```js
import fs from "node:fs";
import { parseUnits } from "ethers";
import { PRIMUS_ATTESTOR, conditionsHash, recoverAttestor } from "../src/tls-attestation.mjs";

describe("real Primus attestation", () => {
  const real = JSON.parse(
    fs.readFileSync(new URL("./fixtures/primus-council-attestation.json", import.meta.url), "utf8"),
  );
  it("is signed by the pinned attestor and matches the pinned request", () => {
    assert.equal(recoverAttestor(real), PRIMUS_ATTESTOR);
    assert.equal(requestHash(real.request), requestHash(COUNCIL_REQUEST));
    assert.equal(responseHash(real.reponseResolve), responseHash(COUNCIL_RESPONSE));
  });
  it("is accepted unmodified and yields the API price", async () => {
    const c = await network.create();
    const provider = new BrowserProvider(c.provider, undefined, { cacheTimeout: -1 });
    try {
      const admin = await provider.getSigner(0);
      const oracle = await deployContract("TlsCouncilPricePolicy", admin, [
        PRIMUS_ATTESTOR, requestHash(COUNCIL_REQUEST), responseHash(COUNCIL_RESPONSE),
        conditionsHash(real), 6 * 86400, 3000, 43200, 3600,
      ]);
      // The local chain's clock is moved to just after the attestation was made.
      await provider.send("evm_setNextBlockTimestamp", [Math.floor(Number(real.timestamp) / 1000) + 30]);
      await (await oracle.submit(real)).wait();
      assert.equal(await oracle.current(), parseUnits(JSON.parse(real.data).price, 18));
    } finally {
      provider.destroy();
      await c.close();
    }
  });
});
```

- [ ] **Step 2: Run**

Run: `npm run compile && node --test --test-concurrency=1 tests/tls-council.test.mjs`
Expected: PASS, 12 tests. A `BAD_ATTESTOR` here means our hash differs from Primus's: compare `attestationHash` in `src/tls-attestation.mjs` with `encodeAttestation` in `PrimusZKTLS.sol` field by field before touching the contract.

- [ ] **Step 3: Commit**

```bash
git add tests/tls-council.test.mjs
git commit -m "test(tls-price): a real Primus attestation is accepted unmodified"
```

---

### Task 4: Relay — attest and submit, no price key

**Files:**
- Create: `src/tls-relay.mjs`
- Create: `scripts/relay-tls.mjs`
- Create: `tests/tls-relay.test.mjs`
- Modify: `package.json` (script `"relay:tls": "node scripts/relay-tls.mjs"`)

**Interfaces:**
- Consumes: `fetchCouncilAttestation` (Task 1); `loadDeployer` from `scripts/deploy-bsc.mjs`; `artifact` from `scripts/deploy.mjs`.
- Produces: `planTlsRelay({ apiPrice, chain, now }) → { action: "submit" | "wait" | "none", reason }` where `chain = { lastRoundId, current, validUntil, changedAt, maxAge, minInterval }` (numbers, `current` bigint); `relayTls({ record, rpcUrl, secret, index, expectAddress, broadcast, attest, log })`.

- [ ] **Step 1: Write the failing test** (`tests/tls-relay.test.mjs`)

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planTlsRelay } from "../src/tls-relay.mjs";

const chain = (over = {}) => ({
  lastRoundId: 3, current: 100n, validUntil: 1_000_000, changedAt: 0,
  maxAge: 518400, minInterval: 86400, ...over,
});

describe("planTlsRelay", () => {
  it("submits the first price", () =>
    assert.equal(planTlsRelay({ apiPrice: 100n, chain: chain({ lastRoundId: 0 }), now: 10 }).action, "submit"));
  it("does nothing when the price is unchanged and validity is long", () =>
    assert.equal(planTlsRelay({ apiPrice: 100n, chain: chain(), now: 500_000 }).action, "none"));
  it("refreshes when less than a third of the validity is left", () =>
    assert.equal(planTlsRelay({ apiPrice: 100n, chain: chain(), now: 900_000 }).action, "submit"));
  it("submits a changed price once minInterval has passed", () =>
    assert.equal(planTlsRelay({ apiPrice: 110n, chain: chain(), now: 500_000 }).action, "submit"));
  it("waits with a changed price inside minInterval, without paying for a proof", () =>
    assert.equal(planTlsRelay({ apiPrice: 110n, chain: chain({ changedAt: 490_000 }), now: 500_000 }).action, "wait"));
});
```

Run: `node --test tests/tls-relay.test.mjs` — Expected: FAIL, module not found.

- [ ] **Step 2: Write `src/tls-relay.mjs`**

```js
// Decides whether a new zkTLS proof of the council price is worth producing. Pure: no network,
// no clock. The contract clamps large moves itself, so there is no stepping to plan here.
export function planTlsRelay({ apiPrice, chain, now }) {
  if (chain.lastRoundId === 0)
    return { action: "submit", reason: "첫 가격 등록" };
  if (apiPrice !== chain.current)
    return now >= chain.changedAt + chain.minInterval
      ? { action: "submit", reason: "가격 변경" }
      : { action: "wait", reason: "가격이 바뀌었지만 최소 간격이 지나지 않았습니다." };
  if (chain.validUntil - now < Math.floor(chain.maxAge / 3))
    return { action: "submit", reason: "유효기한 연장" };
  return { action: "none", reason: "변경 없음" };
}
```

Run: `node --test tests/tls-relay.test.mjs` — Expected: PASS, 5 tests.

- [ ] **Step 3: Write `scripts/relay-tls.mjs`**

```js
// Publishes the council price to a TlsCouncilPricePolicy as a zkTLS proof. The wallet only pays
// gas: it cannot choose the price. Dry run unless --broadcast is given.
// Usage: RELAY_KEY_FILE=… RELAY_EXPECT=0x… node --env-file=$HOME/.wbmb-p2p/primus.env scripts/relay-tls.mjs [--broadcast]
import fs from "node:fs";
import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import { BSC } from "../config/bsc.mjs";
import { artifact } from "./deploy.mjs";
import { loadDeployer } from "./deploy-bsc.mjs";
import { fetchCouncilAttestation } from "./attest-council.mjs";
import { COUNCIL_API_URL, parseCouncilPrice } from "../src/council-relay.mjs";
import { planTlsRelay } from "../src/tls-relay.mjs";

export async function relayTls({
  record, rpcUrl = BSC.rpcUrl, secret, index = 0, expectAddress, broadcast = false,
  attest, fetchJson = async () => (await fetch(COUNCIL_API_URL, { signal: AbortSignal.timeout(15000) })).json(),
  log = console.log,
}) {
  const provider = new JsonRpcProvider(rpcUrl, BSC.chainId, { staticNetwork: true });
  try {
    const signer = loadDeployer(secret, provider, index);
    if (broadcast && (!signer || !expectAddress || signer.address !== expectAddress))
      throw new Error("RELAY_EXPECT 가 지갑 주소와 일치해야 전송합니다.");
    const oracle = new Contract(record.pricePolicy, artifact("TlsCouncilPricePolicy").abi, signer ?? provider);
    const [block, lastRoundId, current, validUntil, changedAt, maxAge, minInterval] = await Promise.all([
      provider.getBlock("latest"), oracle.lastRoundId(), oracle.current(), oracle.validUntil(),
      oracle.changedAt(), oracle.maxAge(), oracle.minInterval(),
    ]);
    const api = parseCouncilPrice(await fetchJson());
    const plan = planTlsRelay({
      apiPrice: api.price, now: block.timestamp,
      chain: { lastRoundId: Number(lastRoundId), current, validUntil: Number(validUntil),
        changedAt: Number(changedAt), maxAge: Number(maxAge), minInterval: Number(minInterval) },
    });
    log(`카운슬 ${formatUnits(api.price, 18)} · 체인 ${formatUnits(current, 18)} · ${plan.reason}`);
    if (plan.action !== "submit") return { ...plan, broadcast: false };
    const att = await attest();
    log(`증명 받음 ${att.data} · ${new Date(Number(att.timestamp)).toISOString()}`);
    // The contract's own checks, run without sending: a proof it would refuse costs no gas.
    await oracle.submit.staticCall(att);
    if (!broadcast) {
      log("--broadcast 가 없어 전송하지 않았습니다.");
      return { ...plan, broadcast: false };
    }
    const tx = await oracle.submit(att);
    log(`전송됨   ${tx.hash}`);
    const receipt = await tx.wait(1, 120000);
    if (receipt.status !== 1) throw new Error("가격 증명 거래가 실패했습니다.");
    return { ...plan, broadcast: true, txHash: tx.hash };
  } finally {
    provider.destroy();
  }
}

if (process.argv[1]?.endsWith("relay-tls.mjs")) {
  const file = process.env.RELAY_KEY_FILE;
  const record = JSON.parse(fs.readFileSync(process.env.RELAY_RECORD || "deployments/bsc-tls-movn-test.json", "utf8"));
  relayTls({
    record,
    rpcUrl: process.env.BSC_RPC_URL || BSC.rpcUrl,
    secret: file ? fs.readFileSync(file, "utf8") : undefined,
    index: Number(process.env.RELAY_INDEX || 0),
    expectAddress: process.env.RELAY_EXPECT,
    broadcast: process.argv.includes("--broadcast"),
    attest: () => fetchCouncilAttestation({ appId: process.env.PRIMUS_APP_ID, appSecret: process.env.PRIMUS_APP_SECRET }),
  }).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
}
```

Before writing, read `loadDeployer` in `scripts/deploy-bsc.mjs` and the entry block of `scripts/relay-council.mjs` (lines 186-214) and match their argument handling exactly; the code above assumes `loadDeployer(secret, provider, index)` returns a connected wallet or `undefined`.

- [ ] **Step 4: Run and commit**

Run: `npm test` — Expected: all pass, including `tls-relay` (5) and `tls-council` (12).

```bash
git add src/tls-relay.mjs scripts/relay-tls.mjs tests/tls-relay.test.mjs package.json
git commit -m "feat(tls-price): relay that submits a zkTLS proof and holds no price key"
```

---

### Task 5: Deploy profile, record, and a test market on BSC

**Files:**
- Modify: `scripts/deploy-bsc.mjs` (profiles near line 67, policy deployment near lines 155-285)
- Modify: `config/bsc.mjs`
- Modify: `tests/real/` deploy rehearsal test that covers the council profile (read `tests/real/*.test.mjs` and extend the one exercising `deployBsc({ profile: "council-test" })`)
- Create (by the script, on broadcast): `deployments/bsc-tls-movn-test.json`

**Interfaces:**
- Consumes: `PRIMUS_ATTESTOR`, `COUNCIL_REQUEST`, `COUNCIL_RESPONSE`, `requestHash`, `responseHash` (Task 1); the fixture's `attConditions`.
- Produces: profiles `tls` (`bsc-tls-movn.json`) and `tls-test` (`bsc-tls-movn-test.json`); record key `tls: { attestor, url, requestHash, responseHash, conditionsHash, maxAge, maxChangeBps, minInterval, maxProofAge }` in place of `council.reporter`.

- [ ] **Step 1: Config** — add to `BSC` in `config/bsc.mjs`:

```js
  // zkTLS-proven council price. Fixed at deployment; a Primus key change means a new market.
  tls: {
    maxProofAge: 3600, // a proof older than an hour is refused
  },
```

- [ ] **Step 2: Profiles** — add to `PROFILES` in `scripts/deploy-bsc.mjs`:

```js
  tls: { file: "bsc-tls-movn.json", minDuration: 3600, minGrace: 86400, council: BSC.council, tls: BSC.tls },
  "tls-test": {
    file: "bsc-tls-movn-test.json", minDuration: 300, minGrace: 300,
    council: { ...BSC.council, minInterval: 300, staleSettleDelay: 300 }, tls: BSC.tls,
  },
```

- [ ] **Step 3: Policy deployment** — where `policyArgs` and `policyArtifact` are built for `cp`, branch on `limits.tls`: no `REPORTER` is required; the artifact is `TlsCouncilPricePolicy`; the arguments are

```js
const tlsArgs = [
  PRIMUS_ATTESTOR,
  requestHash(COUNCIL_REQUEST),
  responseHash(COUNCIL_RESPONSE),
  keccak256(toUtf8Bytes(COUNCIL_CONDITIONS)), // export COUNCIL_CONDITIONS from src/tls-attestation.mjs = the fixture's attConditions
  cp.maxAge, cp.maxChangeBps, cp.minInterval, limits.tls.maxProofAge,
];
```

and the read-back check after deployment compares `attestor()`, `requestHash()`, `responseHash()`, `conditionsHash()`, `maxAge()`, `maxChangeBps()`, `minInterval()`, `maxProofAge()` with these values, throwing the existing "배포된 가격 컨트랙트의 설정이 예상과 다릅니다" error on any mismatch. Before deploying, also read Primus's verifier (`_attestors(0)` at `0xF24199D5D431bE869af3Da61162CbBb58C389324`) and stop with "Primus 공증자 주소가 바뀌었습니다" if it is not `PRIMUS_ATTESTOR`.

- [ ] **Step 4: Rehearsal test** — in the `tests/real` deploy test, add a case that runs `deployBsc({ profile: "tls-test", … })` against the local chain-56 replica and asserts the written record has `tls.attestor === PRIMUS_ATTESTOR` and no `council.reporter`, and that the deployed policy accepts the Task 1 fixture after `evm_setNextBlockTimestamp`.

Run: `npm run test:real` — Expected: PASS, one more test than before.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy-bsc.mjs config/bsc.mjs src/tls-attestation.mjs tests/real
git commit -m "feat(tls-price): deploy profiles for a zkTLS-priced market"
```

- [ ] **Step 6: Deploy the test market — ONLY after the user says go in this session**

Ask first, stating the cost estimate the dry run prints. Then:

```bash
DEPLOYER_KEY_FILE=<as in docs/MAINNET.md> DEPLOYER_EXPECT=<test deployer> node scripts/deploy-bsc.mjs --tls-test            # dry run
DEPLOYER_KEY_FILE=… DEPLOYER_EXPECT=… node scripts/deploy-bsc.mjs --tls-test --broadcast
RELAY_RECORD=deployments/bsc-tls-movn-test.json RELAY_KEY_FILE=… RELAY_EXPECT=… node --env-file=$HOME/.wbmb-p2p/primus.env scripts/relay-tls.mjs --broadcast
```

Expected: a record file, then a `ProofAccepted` transaction whose price equals the API's. Commit the record: `git add deployments/bsc-tls-movn-test.json && git commit -m "deploy: zkTLS-priced test market on BSC"`.

---

### Task 6: Page and documentation

**Files:**
- Modify: `src/app.js` (price line near 826; market-type detection near 1708 and 1756)
- Modify: `scripts/build-live.mjs` (ABI selection, line 18 comment and below)
- Modify: `package.json` (script `build:live:tls-test`)
- Modify: `tests/browser-live-council/app.spec.js`, `docs/MAINNET.md`

**Interfaces:**
- Consumes: record key `tls` (Task 5).

- [ ] **Step 1: Failing browser assertion** — in `tests/browser-live-council/app.spec.js`, add a test that builds the page from a record carrying `tls` and expects the price line to read `증명 시각` and not `카운슬 확정`, and the verify block to show the attestor address and the attested URL. Follow the file's existing fixture and build helpers. Run `npm run test:live` — Expected: FAIL on the new test only.

- [ ] **Step 2: Page** — `build-live.mjs` passes `oracle.contract: "TlsCouncilPricePolicy"` and the `tls` block into the page config when the record has `tls`. In `src/app.js`, treat `TlsCouncilPricePolicy` as a council market wherever `config.oracle?.contract === "CouncilPricePolicy"` is tested (it has the same read surface: `current`, `validUntil`, `confirmedAt`, `prices`), and change the label at the line reading `카운슬 확정 ${date(confirmedAt)} · 유효 ${date(validUntil)}까지` to:

```js
          ? `${config.oracle.contract === "TlsCouncilPricePolicy" ? "증명 시각" : "카운슬 확정"} ${date(confirmedAt)} · 유효 ${date(validUntil)}까지`
```

Add to the page's risk/verify text for this market type, in Korean: the price is proven by a third-party attestor (Primus, address shown) to have come from movnvote.com; nobody operating this site can set it; if the attestor changes its key, prices stop and loans settle by the stale-price rule.

- [ ] **Step 3: Script and docs** — add `"build:live:tls-test": "RECORD=deployments/bsc-tls-movn-test.json OUT_DIR=dist-live-tls-test node scripts/build-live.mjs"`; add a "zkTLS 가격 시장" section to `docs/MAINNET.md` covering the Primus credentials file, the relay command and what to do on a Primus key change (redeploy).

- [ ] **Step 4: Run everything**

Run: `npm run check && npm run rehearse`
Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add src/app.js scripts/build-live.mjs package.json tests/browser-live-council/app.spec.js docs/MAINNET.md
git commit -m "feat(tls-price): page shows the proof time and the attestor for a zkTLS-priced market"
```

The public site is NOT switched in this plan. Switching `wbmb-web` to the new build, installing a relay timer, and deploying a main market are separate decisions for the user after the test market has run.
