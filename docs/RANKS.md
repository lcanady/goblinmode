# Ranks

Everything about the badge ladder: who promotes, how, when they get demoted, and what each rank actually gets you.

## The ladder

Six ranks. Enum order is load-bearing — `uint8(Rank)` is used for comparisons in `GoblinAccess`.

```
CAVE (0) → TRENCH (1) → CURSED_HUNTER (2) → VETERAN (3) → KING (4) → ANCIENT (5)
```

Promotions are monotonic (`rankUp` is a no-op if the new rank isn't strictly higher). Two demotion paths exist:

1. **KING → VETERAN** when a wallet falls out of the top-10 volume table (curve-driven, automatic on every trade).
2. **PvP killing blow** — any rank above CAVE (except ANCIENT) drops one tier when cumulative epoch rot hits 100%. See [PvP demotion](#rank-demotion-via-pvp) below.

## Promotion paths

Every promotion needs **both** a count threshold and a USDC volume floor. H-6 added the volume floors specifically to kill wash-trading dust through the ladder.

| From → To | Count requirement | Volume floor (lifetime USDC) | Notes |
| --- | --- | --- | --- |
| CAVE → TRENCH | `tradeCount >= 5` | `>= 100 USDC` | Auto-checked on every buy/sell |
| TRENCH → CURSED_HUNTER | `rugsSurvived >= 1` | `>= 500 USDC` | Rug-survived bump only fires on selling a CURSED token after buying it |
| CURSED_HUNTER → VETERAN | `graduationsWitnessed >= 3` | `>= 5,000 USDC` | Bump fires on the buy that crosses 69k for that token |
| VETERAN → KING | already in `top10` (sorted by `lifetimeUSDCVolume`) | implicit — must rank into the table | Promoted inside `_bumpVolumeAndMaybePromote` after the table re-sort |
| any → ANCIENT | `owner.setAncient(addr)` after `firstTradeBlock != 0` | — | One seat. One time. Mythic. |

### How `rugsSurvived` actually fires

It's not "any time a token gets labelled CURSED." It's specifically: you bought a position in `tokenId`, then later sold any portion of it while `t.label == Label.CURSED`. On that sell, `bumpRugsSurvived` fires and your `boughtAmount[tokenId][you]` is cleared. So one position counts at most once per cursed cycle. Buy back in, get cursed again, sell again — that's a second rug survived.

### How `graduationsWitnessed` fires

On the buy that pushes `realUSDCCollected >= GRADUATION_THRESHOLD`. The buyer who lands the graduating trade is the one who gets the stat bump. So whales who land the closing buy on multiple launches climb fast — by design.

## Fee schedule (from `GoblinAccess.getFeeBps`)

| Rank | Fee bps | What that means |
| --- | --- | --- |
| CAVE | 100 | 1.00% — base rate, also the default for any wallet with no badge yet |
| TRENCH | 90 | 0.90% |
| CURSED_HUNTER | 85 | 0.85% |
| VETERAN | 75 | 0.75% |
| KING | 60 | 0.60% |
| ANCIENT | 50 | 0.50% |

Fee is taken on both buys and sells. Charged on buys against `usdcIn`. Charged on sells against `usdcGross` (the raw curve output, before sending to seller).

**Heads up:** the bps above is the **gross** fee charged to the trader. Of that fee, the protocol keeps 80% (`accumulatedFees`) and 20% credits the token's creator (`pendingWithdrawals[creator]`, via `CREATOR_FEE_SHARE_BPS = 2000`). Trader pays the full bps either way — see [`BONDING_CURVE.md`](BONDING_CURVE.md#creator-fee-share).

## Early-access window (from `GoblinAccess.getEarlyAccessSeconds`)

The window is the number of seconds a higher-rank wallet sees a launch before lower-rank wallets can trade it. Enforcement is **off-chain** (frontend / RPC gateway) — the contract just exposes the value. ANCIENT returns `999` as a sentinel for "unlimited"; frontends treat it specially.

| Rank | Seconds |
| --- | --- |
| CAVE | 0 |
| TRENCH | 30 |
| CURSED_HUNTER | 60 |
| VETERAN | 90 |
| KING | 120 |
| ANCIENT | 999 (sentinel: unlimited) |

## Perk matrix

| Perk | CAVE | TRENCH | CURSED_HUNTER | VETERAN | KING | ANCIENT |
| --- | --- | --- | --- | --- | --- | --- |
| Trade on curve | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Reduced fees | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| Early access | — | ✓ | ✓ | ✓ | ✓ | ✓ (∞) |
| See goblin-score breakdown | — | — | ✓ | ✓ | ✓ | ✓ |
| Flag tokens for rescore | — | — | — | ✓ | ✓ | ✓ |
| Top-10 KING table seat | — | — | — | (eligible) | ✓ | ✓ |

`canSeeScoreBreakdown` is `>= CURSED_HUNTER`. `canFlagToken` is `>= VETERAN`. Both pure reads from access layer.

## The KING table

`top10[10]` is an in-storage array of addresses sorted descending by `lifetimeUSDCVolume`. Maintained inside `_bumpVolumeAndMaybePromote` on every buy/sell.

### Eligibility

A wallet is **eligible** for the table if:

- `badge.hasBadge(wallet) == true`, **and**
- `uint8(badge.getRank(wallet)) >= uint8(VETERAN)`

H-5 added this gate. Without it, a CAVE wallet with massive volume could displace a VETERAN from the top-10 and prevent legitimate KING promotions. Now: huge-volume low-rank wallets don't even enter consideration.

### Maintenance algorithm

On every buy/sell, after `lifetimeUSDCVolume[wallet]` bumps:

1. Linear scan to check if `wallet` already sits in `top10`.
2. **If already in:** bubble up — swap leftward while the left neighbor has lower volume.
3. **If not in but eligible:** find the lowest index where `current[i]` is either zero or has lower volume than `wallet`. Insert there, shifting the rest down. Displaced last slot gets demoted from KING if it was one.
4. **If not in and not eligible:** skip insertion. Volume is still recorded for analytics.
5. After the table mutates, if `wallet` is currently VETERAN and now sits in `top10`, promote to KING.

Linear scan on a 10-element array is cheaper than a heap on-chain. Bounded gas, predictable cost.

### Demotion

The only way out of KING is being displaced from the table. `badge.demoteFromKing(wallet)` is curve-only and exits cleanly to VETERAN (the wallet keeps its veteran stats — graduation count, rugs, etc.). No other rank can be demoted.

## Rank demotion via PvP

KING → VETERAN (top-10 churn) used to be the only demotion path. PvP adds a second one: **killing blows**.

When a wallet's cumulative score-rot in a single epoch (1 hour) hits 10,000 bps from `GoblinPvP` attacks, the attack that crossed the threshold calls `badge.demoteRank(target)` — drops the target one tier.

| Target rank | Demotion outcome | Killing-blow drop to attacker |
| --- | --- | --- |
| CAVE | **No-op (floor).** No demotion, no drop. | — |
| TRENCH | → CAVE | KING_KILL pool |
| CURSED_HUNTER | → TRENCH | KING_KILL pool |
| VETERAN | → CURSED_HUNTER | KING_KILL pool |
| KING | → VETERAN | KING_KILL pool |
| ANCIENT | **Immune.** No demotion, no drop. | — |

`badge.demoteRank` is gated `onlyPvP` and bound via the one-shot `setPvP(pvpAddr)`. Nothing else can drop a rank.

Note: a KING demoted to VETERAN by a killing blow keeps their `lifetimeUSDCVolume` (rot scales new bumps, doesn't retroactively shrink past volume). They can re-promote to KING on their next trade if they're still in `top10`. Killing-blow demotion is the smaller hit — losing the volume seat (the only way out historically) is permanent until you out-trade the displacer.

Full mechanics in [`PVP.md`](PVP.md).

## The ANCIENT seat

One slot. Settable exactly once. Gated by:

- `owner` must call `setAncient(addr)` (owner-only)
- `ancientAddress` must currently be `address(0)` (one-shot)
- `firstTradeBlock != 0` (the protocol must have seen real activity)
- `addr != address(0)`

If the recipient doesn't have a badge yet, `setAncient` mints one then stamps it ANCIENT directly — skipping the entire ladder. After that, the slot is locked forever.

### Why one-shot

Two reasons:

1. **Anti-pre-bootstrap.** Owner can't ANCIENT-stamp a friend before launch — the `firstTradeBlock != 0` gate forces real activity first.
2. **Anti-rotation.** ANCIENT is mythic by design. If it could be re-assigned, it's just a glorified KING. The lock makes it a permanent on-chain artifact.

ANCIENT is also the cheapest fee tier (50 bps) and the only "infinite early access" rank. Whoever gets it, gets it.

## Read-side behavior for no-badge wallets

`badge.getRank(addr)` returns `Rank.CAVE` for any wallet without a badge — the "ghost default." So `getFeeBps`, `getEarlyAccessSeconds`, etc. don't have to branch on "has badge or not." First-trade buyers get a badge minted as part of the buy, so the ghost-default only matters for view-only queries (e.g. quoting a buy for a fresh wallet).

## What stats are tracked

All on `GoblinBadge`, all curve-only writes:

- `tradeCount[wallet]` — incremented on every buy and every sell
- `graduationsWitnessed[wallet]` — incremented on the buy that crosses 69k
- `rugsSurvived[wallet]` — incremented on selling a CURSED token after holding it

Plus on the curve itself:

- `lifetimeUSDCVolume[wallet]` — sum of `usdcAfterFee` (buys) + `usdcGross` (sells)
- `boughtAmount[tokenId][wallet]` — for rugs-survived bookkeeping

`lifetimeUSDCVolume` lives on the curve (not the badge) because it's the input to KING table sorting, which is also a curve concern.
