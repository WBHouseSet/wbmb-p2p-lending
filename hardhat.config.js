export default {
  solidity: "0.8.37",
  networks: {
    default: { type: "edr-simulated", chainType: "l1", chainId: 31337 },
    // Local chain that reports BSC's chain id, for rehearsing the mainnet deploy script.
    bscReplica: { type: "edr-simulated", chainType: "l1", chainId: 56 },
  },
};
