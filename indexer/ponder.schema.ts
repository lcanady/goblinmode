import { onchainTable, onchainEnum, relations, index } from "ponder";

// --- enums ---
export const label = onchainEnum("label", ["UNSCORED", "NEUTRAL", "BLESSED", "CURSED"]);
export const side = onchainEnum("side", ["BUY", "SELL"]);
export const candleInterval = onchainEnum("candle_interval", ["M1", "M5", "M15", "H1", "H4", "D1"]);

// --- Token ---
export const token = onchainTable(
  "token",
  (t) => ({
    id: t.text().primaryKey(), // tokenId (uint256 as decimal string)
    address: t.hex().notNull(),
    creator: t.hex().notNull(),
    name: t.text().notNull().default(""),
    symbol: t.text().notNull(),
    metadataURI: t.text().notNull().default(""),
    launchedAt: t.bigint().notNull(),
    virtualUSDC: t.bigint().notNull(),
    virtualToken: t.bigint().notNull(),
    realUSDCCollected: t.bigint().notNull().default(0n),
    currentPrice: t.bigint().notNull().default(0n),
    graduationProgressBps: t.integer().notNull().default(0),
    graduated: t.boolean().notNull().default(false),
    graduatedAt: t.bigint(),
    goblinScore: t.integer().notNull().default(0),
    label: label("label").notNull().default("UNSCORED"),
    lifetimeVolumeUSDC: t.bigint().notNull().default(0n),
    buyCount: t.integer().notNull().default(0),
    sellCount: t.integer().notNull().default(0),
    creatorFeesEarnedUSDC: t.bigint().notNull().default(0n),
  }),
  (t) => ({
    creatorIdx: index().on(t.creator),
    graduatedIdx: index().on(t.graduated),
    launchedAtIdx: index().on(t.launchedAt),
  }),
);

// --- Trade ---
export const trade = onchainTable(
  "trade",
  (t) => ({
    id: t.text().primaryKey(), // txHash-logIndex
    tokenId: t.text().notNull(),
    trader: t.hex().notNull(),
    side: side("side").notNull(),
    usdcAmount: t.bigint().notNull(),
    tokenAmount: t.bigint().notNull(),
    feeUSDC: t.bigint().notNull(),
    priceAfter: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
  }),
  (t) => ({
    tokenIdx: index().on(t.tokenId),
    traderIdx: index().on(t.trader),
    tsIdx: index().on(t.timestamp),
  }),
);

// --- User ---
export const user = onchainTable("user", (t) => ({
  address: t.hex().primaryKey(),
  badgeRank: t.integer().notNull().default(0),
  hasBadge: t.boolean().notNull().default(false),
  tradeCount: t.integer().notNull().default(0),
  graduationsWitnessed: t.integer().notNull().default(0),
  rugsSurvived: t.integer().notNull().default(0),
  lifetimeVolumeUSDC: t.bigint().notNull().default(0n),
  firstSeenAt: t.bigint().notNull(),
  lastSeenAt: t.bigint().notNull(),
}));

// --- Flag ---
export const flag = onchainTable(
  "flag",
  (t) => ({
    id: t.text().primaryKey(), // tokenId-flagger
    tokenId: t.text().notNull(),
    flagger: t.hex().notNull(),
    blockTime: t.bigint().notNull(),
  }),
  (t) => ({
    tokenIdx: index().on(t.tokenId),
  }),
);

// --- Candle (stub for v1, populated later) ---
export const candle = onchainTable(
  "candle",
  (t) => ({
    id: t.text().primaryKey(), // tokenId-interval-bucketStart
    tokenId: t.text().notNull(),
    interval: candleInterval("interval").notNull(),
    bucketStart: t.bigint().notNull(),
    open: t.bigint().notNull(),
    high: t.bigint().notNull(),
    low: t.bigint().notNull(),
    close: t.bigint().notNull(),
    volumeUSDC: t.bigint().notNull(),
    tradeCount: t.integer().notNull(),
  }),
  (t) => ({
    tokenIntervalIdx: index().on(t.tokenId, t.interval, t.bucketStart),
  }),
);

// --- relations ---
export const tokenRelations = relations(token, ({ many }) => ({
  trades: many(trade),
  flags: many(flag),
  candles: many(candle),
}));

export const tradeRelations = relations(trade, ({ one }) => ({
  token: one(token, { fields: [trade.tokenId], references: [token.id] }),
  user: one(user, { fields: [trade.trader], references: [user.address] }),
}));

export const flagRelations = relations(flag, ({ one }) => ({
  token: one(token, { fields: [flag.tokenId], references: [token.id] }),
}));

export const candleRelations = relations(candle, ({ one }) => ({
  token: one(token, { fields: [candle.tokenId], references: [token.id] }),
}));
