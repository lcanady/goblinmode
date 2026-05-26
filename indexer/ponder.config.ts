import { createConfig } from "ponder";
import { http } from "viem";
import { GoblinCurveAbi } from "./abis/GoblinCurveAbi";
import { GoblinBadgeAbi } from "./abis/GoblinBadgeAbi";

const START_BLOCK = 34_279_900;

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
      address: "0x868874A8F47E8fa697A3E68460a7eEe8EF003479",
      startBlock: START_BLOCK,
    },
    GoblinBadge: {
      network: "monadTestnet",
      abi: GoblinBadgeAbi,
      address: "0x8187c3f4E82E84e2FB6aeA463d63715503DBEe4E",
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
