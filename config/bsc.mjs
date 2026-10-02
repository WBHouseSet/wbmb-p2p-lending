import { getAddress } from "ethers";
// Real BNB Smart Chain addresses. Verified on-chain 2026-10-01 (decimals, code, no proxy).
export const BSC = {
  chainId: 56,
  rpcUrl: "https://bsc-dataseed.binance.org",
  usdt: getAddress("0x55d398326f99059ff775485246999027b3197955"), // 18 decimals
  wbmb: getAddress("0x9e4c611b834672c3643d9818249366bf65ae4c86"), // 8 decimals, no burn(), owner can mint
  feeBps: 500, // 5% of paid interest, charged on top of interest
  // Council-price market. Fixed at deployment; changing any of these means a new market.
  council: {
    maxAge: 6 * 86400, // the council has gone 4 days between updates
    maxChangeBps: 3000, // largest single council move seen: +18.5%
    minInterval: 43200,
    liquidationBonusBps: 500,
    staleSettleDelay: 7 * 86400,
  },
};
