// Signs and submits Mobick council price reports (EIP-712). A signature means the reporter
// vouches that `price` is the council price confirmed at `confirmedAt`; nothing here proves it.
import { keccak256, toUtf8Bytes } from "ethers";

export const COUNCIL_DOMAIN_NAME = "WBMB Council Price";
export const COUNCIL_DOMAIN_VERSION = "1";
export const COUNCIL_POLICY_ID = keccak256(
  toUtf8Bytes("wbmb-movn/mobick-council/v1"),
);
export const COUNCIL_TYPES = {
  Report: [
    { name: "policyId", type: "bytes32" },
    { name: "roundId", type: "uint64" },
    { name: "price", type: "uint256" },
    { name: "confirmedAt", type: "uint64" },
    { name: "validUntil", type: "uint64" },
  ],
};

export function councilDomain(chainId, verifyingContract) {
  return {
    name: COUNCIL_DOMAIN_NAME,
    version: COUNCIL_DOMAIN_VERSION,
    chainId: Number(chainId),
    verifyingContract,
  };
}

// The contract requires signatures ordered by signer address (ascending) to reject duplicates.
export async function signCouncilReport(domain, report, signers) {
  const entries = await Promise.all(
    signers.map(async (s) => ({
      address: (await s.getAddress()).toLowerCase(),
      sig: await s.signTypedData(domain, COUNCIL_TYPES, report),
    })),
  );
  entries.sort((a, b) =>
    a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
  );
  return entries.map((e) => e.sig);
}

export async function submitCouncilReport(policy, report, signers) {
  const { chainId } = await policy.runner.provider.getNetwork();
  const sigs = await signCouncilReport(
    councilDomain(chainId, policy.target),
    report,
    signers,
  );
  return policy.submit(report, sigs);
}
