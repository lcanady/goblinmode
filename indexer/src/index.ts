import { ponder } from "ponder:registry";
import schema from "ponder:schema";

const GRADUATION_THRESHOLD = 69_000_000_000n; // 69_000e6 USDC (6 decimals)
const BPS = 10_000n;

const LABEL_MAP = ["NEUTRAL", "BLESSED", "CURSED"] as const;

function computePrice(vUSDC: bigint, vToken: bigint): bigint {
  if (vToken === 0n) return 0n;
  return (vUSDC * 10n ** 18n) / vToken;
}

function computeProgressBps(realUSDC: bigint): number {
  let bps = (realUSDC * BPS) / GRADUATION_THRESHOLD;
  if (bps > BPS) bps = BPS;
  return Number(bps);
}

async function upsertUser(context: any, address: `0x${string}`, ts: bigint) {
  await context.db
    .insert(schema.user)
    .values({
      address,
      firstSeenAt: ts,
      lastSeenAt: ts,
    })
    .onConflictDoUpdate((u: any) => ({ lastSeenAt: ts }));
}

// --- GoblinCurve handlers ---

ponder.on("GoblinCurve:TokenLaunched", async ({ event, context }) => {
  const {
    tokenId,
    token: tokenAddr,
    creator,
    name,
    symbol,
    metadataURI,
    launchedAt,
  } = event.args as {
    tokenId: bigint;
    token: `0x${string}`;
    creator: `0x${string}`;
    name: string;
    symbol: string;
    metadataURI: string;
    launchedAt: bigint;
  };
  const ts = event.block.timestamp;

  // Virtual reserves are deterministic at launch (offset + initial supply).
  const virtualUSDC = 1_000_000_000n; // 1_000e6
  const virtualToken = 1_000_000_000n * 10n ** 18n;

  await context.db.insert(schema.token).values({
    id: tokenId.toString(),
    address: tokenAddr,
    creator,
    name,
    symbol,
    metadataURI,
    launchedAt,
    virtualUSDC,
    virtualToken,
    realUSDCCollected: 0n,
    currentPrice: computePrice(virtualUSDC, virtualToken),
    graduationProgressBps: 0,
    graduated: false,
    goblinScore: 0,
    label: "UNSCORED",
    lifetimeVolumeUSDC: 0n,
    buyCount: 0,
    sellCount: 0,
    creatorFeesEarnedUSDC: 0n,
  });

  await upsertUser(context, creator, ts);
});

async function handleTrade(
  side: "BUY" | "SELL",
  event: any,
  context: any,
) {
  const {
    tokenId,
    usdcIn,
    usdcOut,
    tokensIn,
    tokensOut,
    fee,
    virtualUSDCAfter,
    virtualTokenAfter,
    realUSDCCollectedAfter,
  } = event.args as any;
  const trader: `0x${string}` = event.args.buyer ?? event.args.seller;
  const ts = event.block.timestamp;

  const usdcAmount: bigint = side === "BUY" ? usdcIn : usdcOut;
  const tokenAmount: bigint = side === "BUY" ? tokensOut : tokensIn;

  const virtualUSDC: bigint = virtualUSDCAfter;
  const virtualToken: bigint = virtualTokenAfter;
  const realUSDC: bigint = realUSDCCollectedAfter;

  const priceAfter = computePrice(virtualUSDC, virtualToken);

  await context.db.insert(schema.trade).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    tokenId: tokenId.toString(),
    trader,
    side,
    usdcAmount,
    tokenAmount,
    feeUSDC: fee ?? 0n,
    priceAfter,
    timestamp: ts,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
  });

  await context.db
    .update(schema.token, { id: tokenId.toString() })
    .set((t: any) => ({
      virtualUSDC,
      virtualToken,
      realUSDCCollected: realUSDC,
      currentPrice: priceAfter,
      graduationProgressBps: computeProgressBps(realUSDC),
      lifetimeVolumeUSDC: t.lifetimeVolumeUSDC + usdcAmount,
      buyCount: side === "BUY" ? t.buyCount + 1 : t.buyCount,
      sellCount: side === "SELL" ? t.sellCount + 1 : t.sellCount,
    }));

  await context.db
    .insert(schema.user)
    .values({
      address: trader,
      firstSeenAt: ts,
      lastSeenAt: ts,
      tradeCount: 1,
      lifetimeVolumeUSDC: usdcAmount,
    })
    .onConflictDoUpdate((u: any) => ({
      lastSeenAt: ts,
      tradeCount: u.tradeCount + 1,
      lifetimeVolumeUSDC: u.lifetimeVolumeUSDC + usdcAmount,
    }));
}

ponder.on("GoblinCurve:TokenPurchased", async ({ event, context }) => {
  await handleTrade("BUY", event, context);
});

ponder.on("GoblinCurve:TokenSold", async ({ event, context }) => {
  await handleTrade("SELL", event, context);
});

ponder.on("GoblinCurve:GraduationTriggered", async ({ event, context }) => {
  const { tokenId } = event.args as { tokenId: bigint; realUSDC: bigint };
  await context.db
    .update(schema.token, { id: tokenId.toString() })
    .set({ graduated: true, graduatedAt: event.block.timestamp });
});

ponder.on("GoblinCurve:GraduationFeeTaken", async ({ event }) => {
  // Log-only for now; analytics may aggregate later from raw logs.
});

ponder.on("GoblinCurve:CreatorFeeAccrued", async ({ event, context }) => {
  const { tokenId, amount } = event.args as {
    tokenId: bigint;
    creator: `0x${string}`;
    amount: bigint;
  };
  await context.db
    .update(schema.token, { id: tokenId.toString() })
    .set((t: any) => ({
      creatorFeesEarnedUSDC: t.creatorFeesEarnedUSDC + amount,
    }));
});

ponder.on("GoblinCurve:GoblinScoreSet", async ({ event, context }) => {
  const { tokenId, score, label: labelIdx } = event.args as {
    tokenId: bigint;
    score: bigint;
    label: number;
  };
  const labelStr = LABEL_MAP[Number(labelIdx)] ?? "NEUTRAL";
  await context.db
    .update(schema.token, { id: tokenId.toString() })
    .set({ goblinScore: Number(score), label: labelStr as any });
});

ponder.on("GoblinCurve:TokenFlagged", async ({ event, context }) => {
  const { tokenId, flagger } = event.args as {
    tokenId: bigint;
    flagger: `0x${string}`;
    count: bigint;
  };
  await context.db
    .insert(schema.flag)
    .values({
      id: `${tokenId.toString()}-${flagger.toLowerCase()}`,
      tokenId: tokenId.toString(),
      flagger,
      blockTime: event.block.timestamp,
    })
    .onConflictDoNothing();
});

ponder.on("GoblinCurve:RescoringTriggered", async ({ event }) => {
  // no-op: GoblinScoreSet will follow with the new score.
});

// --- GoblinBadge handlers ---

ponder.on("GoblinBadge:BadgeMinted", async ({ event, context }) => {
  const { wallet, rank } = event.args as {
    wallet: `0x${string}`;
    tokenId: bigint;
    rank: number;
  };
  const ts = event.block.timestamp;
  await context.db
    .insert(schema.user)
    .values({
      address: wallet,
      hasBadge: true,
      badgeRank: Number(rank),
      firstSeenAt: ts,
      lastSeenAt: ts,
    })
    .onConflictDoUpdate(() => ({
      hasBadge: true,
      badgeRank: Number(rank),
      lastSeenAt: ts,
    }));
});

ponder.on("GoblinBadge:RankUpgraded", async ({ event, context }) => {
  const { wallet, to } = event.args as {
    wallet: `0x${string}`;
    tokenId: bigint;
    from: number;
    to: number;
  };
  await context.db
    .insert(schema.user)
    .values({
      address: wallet,
      hasBadge: true,
      badgeRank: Number(to),
      firstSeenAt: event.block.timestamp,
      lastSeenAt: event.block.timestamp,
    })
    .onConflictDoUpdate(() => ({
      badgeRank: Number(to),
      lastSeenAt: event.block.timestamp,
    }));
});
