import { getAddress } from "ethers";
// Real BNB Smart Chain addresses. Verified on-chain 2026-10-01 (WBMB) and 2026-10-04 (MOVN): decimals, code, no proxy.
export const BSC = {
  chainId: 56,
  rpcUrl: "https://bsc-dataseed.binance.org",
  movn: getAddress("0x200b63aa750c901892d4dcf82439860f9c270274"), // 18 decimals; the issuer can mint, pause and blacklist
  wbmb: getAddress("0x9e4c611b834672c3643d9818249366bf65ae4c86"), // 8 decimals, no burn(), owner can mint
  feeBps: 500, // 5% of paid interest, charged on top of interest
  swapFeeBps: 50, // trade board: 0.5% of the MOVN paid, taken from the seller of WBMB
  // Council-price market. Fixed at deployment; changing any of these means a new market.
  council: {
    maxAge: 6 * 86400, // the council has gone 4 days between updates
    maxChangeBps: 3000, // largest single council move seen: +18.5%
    minInterval: 86400, // with maxChangeBps: at most 30% per day
    liquidationBonusBps: 1000, // lender receives debt + 10% in WBMB at settlement
    staleSettleDelay: 7 * 86400,
  },
};
