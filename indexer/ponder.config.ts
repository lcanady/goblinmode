import { createConfig } from "ponder";
import { http } from "viem";
import { GoblinCurveAbi } from "./abis/GoblinCurveAbi";
import { GoblinBadgeAbi } from "./abis/GoblinBadgeAbi";

const START_BLOCK = 34_290_000;

export default createConfig({
  networks: {
    monadTestnet: {
      chainId: 10143,
      transport: http(process.env.PONDER_RPC_URL_10143 ?? "https://testnet-rpc.monad.xyz"),
      pollingInterval: 2_000,
    },
  },
  contracts: {
    GoblinCurve: {
      network: "monadTestnet",
      abi: GoblinCurveAbi,
      address: "0x9f0fAbd89274e701379836329D9c99fCa6C6D75B",
      startBlock: START_BLOCK,
    },
    GoblinBadge: {
      network: "monadTestnet",
      abi: GoblinBadgeAbi,
      address: "0x736A5aaa238d6d279a3c22D4F6018748C23c9887",
      startBlock: START_BLOCK,
    },
  },
  database: process.env.DATABASE_URL
    ? {
        kind: "postgres",
        connectionString: process.env.DATABASE_URL,
      }
    : { kind: "pglite" },
});
