// Builds, signs and submits EIP-712 price reports. A signature means the reporter
// vouches for the input data; this module does not fetch or prove market data.
import { keccak256, toUtf8Bytes } from "ethers";
import { BUCKET_COUNT } from "./prices.mjs";

export const DOMAIN_NAME = "WBMB Price Report";
export const DOMAIN_VERSION = "1";
export const POLICY_ID = keccak256(
  toUtf8Bytes("wbmb-usdt/7d-30m-min/dex+lbank/v1"),
);
export const REPORT_TYPES = {
  Report: [
    { name: "policyId", type: "bytes32" },
    { name: "roundId", type: "uint64" },
    { name: "windowStart", type: "uint64" },
    { name: "windowEnd", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "bucketCount", type: "uint16" },
    { name: "dexLow", type: "uint256" },
    { name: "dexCurrent", type: "uint256" },
    { name: "cexLow", type: "uint256" },
    { name: "cexCurrent", type: "uint256" },
    { name: "rawDataHash", type: "bytes32" },
  ],
};

export function domainFor(chainId, verifyingContract) {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: Number(chainId),
    verifyingContract,
  };
}

export function hashRawData(dex, cex) {
  const rows = (r) =>
    r.map((x) => [x.start, x.end, x.price.toString(), x.valid]);
  return keccak256(
    toUtf8Bytes(JSON.stringify({ dex: rows(dex), cex: rows(cex) })),
  );
}

// Demo reports are not derived from bucket rows. Their hash commits to the published
// values and is marked synthetic so it can never be mistaken for a hash of market data.
export function hashSyntheticData({
  windowEnd,
  dexLow,
  dexCurrent,
  cexLow,
  cexCurrent,
}) {
  return keccak256(
    toUtf8Bytes(
      JSON.stringify({
        synthetic: true,
        windowEnd: Number(windowEnd),
        values: [dexLow, dexCurrent, cexLow, cexCurrent].map(String),
      }),
    ),
  );
}

export function toReport(
  priceReport,
  { roundId, validUntil, rawDataHash, policyId = POLICY_ID },
) {
  if (!Number.isSafeInteger(roundId) || roundId <= 0)
    throw new Error("잘못된 roundId");
  if (!Number.isSafeInteger(validUntil) || validUntil <= priceReport.windowEnd)
    throw new Error("잘못된 유효기한");
  return {
    policyId,
    roundId,
    windowStart: priceReport.windowStart,
    windowEnd: priceReport.windowEnd,
    validUntil,
    bucketCount: BUCKET_COUNT,
    dexLow: priceReport.dexLow,
    dexCurrent: priceReport.dexCurrent,
    cexLow: priceReport.cexLow,
    cexCurrent: priceReport.cexCurrent,
    rawDataHash,
  };
}

export function signReport(signer, domain, report) {
  return signer.signTypedData(domain, REPORT_TYPES, report);
}

// The contract requires signatures ordered by signer address (ascending) to reject duplicates.
export async function collectSignatures(domain, report, signers) {
  const entries = await Promise.all(
    signers.map(async (s) => ({
      address: (await s.getAddress()).toLowerCase(),
      sig: await signReport(s, domain, report),
    })),
  );
  entries.sort((a, b) =>
    a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
  );
  return entries.map((e) => e.sig);
}

export async function submitReport(policy, report, signers) {
  const { chainId } = await policy.runner.provider.getNetwork();
  const sigs = await collectSignatures(
    domainFor(chainId, policy.target),
    report,
    signers,
  );
  return policy.submit(report, sigs);
}
