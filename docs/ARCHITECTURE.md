# Architecture

How the eight contracts fit together, in what order they get deployed, and why each design call was made.

## System graph

```
                    ┌────────────────────┐
                    │     GoblinCurve    │  ◄── owner (multisig recommended)
                    │  (bonding curves,  │
                    │   USDC reserves,   │
                    │   rank engine,     │
                    │   oracle gates,    │
                    │   KING table)      │
                    └─────────┬──────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│ GoblinBadge   │     │ GoblinAccess  │     │GoblinTokenFac.│
│ (soulbound    │     │ (pure read    │     │ (CREATE2      │
│  ERC-721,     │◄────│  layer:       │     │  deployer,    │
│  rank state,  │     │  rank → perk) │     │  curve-only)  │
│  curve-only   │     └───────────────┘     └───────┬───────┘
│  mutators)    │                                   │
└───────────────┘                                   ▼
                                            ┌───────────────┐
                                            │  GoblinToken  │
                                            │  (ERC-20,     │
                                            │   minted to   │
                                            │   curve at    │
                                            │   construct.) │
                                            └───────────────┘

         ┌─────────┐                  ┌──────────────┐
         │  USDC   │ ◄── transferFrom │ buyers/sells │
         │ (6 dec) │     transfer     └──────────────┘
         └─────────┘

                              │ events
                              ▼
                      ┌───────────────┐
                      │   Indexer     │  ◄── Ponder 0.9
                      │ (token/trade/ │     :42069 REST + GraphQL
                      │  user/flag/   │     pglite (dev) / pg (prod)
                      │  candle)      │
                      └───────┬───────┘
                              │
                              ▼
                       frontend / bot
```

Curve holds all USDC. Badge holds all reputation. Access reads badge. Factory deploys tokens but only when the curve calls it. Tokens are dumb ERC-20s that exist to be traded against the curve. Indexer is downstream-only — read path, no writes back on-chain.

## Quest + PvP overlay

The trading core (badge, access, curve, factory, token) is self-contained. The Quest/PvP system bolts on top via three additional contracts and one curve view dependency:

```
                  ┌────────────────────┐
                  │     GoblinCurve    │
                  │  reads pvp.        │
                  │  getRotMultiplier  │◄──────┐
                  └─────────┬──────────┘       │
                            │                  │
                            │ rankUp /         │ getRotMultiplierBps(wallet)
                            │ demoteFromKing   │
                            ▼                  │
                  ┌────────────────────┐       │
                  │    GoblinBadge     │       │
                  │  demoteRank        │◄──────┤
                  │  (onlyPvP, 1-shot) │       │
                  └────────────────────┘       │
                            ▲                  │
                            │ demoteRank       │
                            │                  │
                  ┌─────────┴──────────┐       │
                  │     GoblinPvP      │───────┘
                  │  attack/defend/    │
                  │  resolve           │
                  └─────┬────────┬─────┘
                burn   │        │  autoTriggerDrop(KING_KILL)
                weapon │        ▼
                /armor │  ┌────────────────────┐
                       │  │    GoblinQuest     │
                       │  │  commit-reveal     │
                       │  │  autoTrigger path  │
                       │  └─────────┬──────────┘
                       │            │  mint
                       │            ▼
                       │  ┌────────────────────┐
                       └─►│    GoblinItem      │
                          │  ERC-1155, 8 ids   │
                          │  minter allowlist  │
                          └────────────────────┘
```

Wiring summary:

- `Item ← Quest` — Quest is a minter on Item
- `Item ← PvP` — PvP is a minter on Item (burns happen via operator approval from holder)
- `PvP → Badge.demoteRank` — gated by `setPvP` one-shot on Badge
- `PvP → Quest.autoTriggerDrop` — gated by `addAutoTrigger(pvp)` on Quest
- `Curve → PvP.getRotMultiplierBps` — gated by `setPvP` one-shot on Curve; falls back to 100% surviving fraction if PvP isn't wired or call reverts

Trust split inside the overlay:

- **Quest has its own oracle set** — separate from the curve's `isOracle`. Quest oracles trigger and reveal drops. Curve oracles score tokens. Keep them apart so a compromised drop oracle can't whipsaw token labels.
- **PvP is the only contract that can demote rank** (`badge.demoteRank` is `onlyPvP`). One-shot bound at deploy time.
- **PvP is the only auto-trigger** authorized on Quest by default. Owner can add more if a future contract needs in-line drops, but currently it's just PvP.

See [`ITEMS.md`](ITEMS.md) and [`PVP.md`](PVP.md) for the full mechanics.

## Wiring order

There's a circular dependency between curve and badge — badge needs to know which curve can mutate it, and curve needs to know the badge address at construction. We break the cycle with one-shot setters.

```
 1.  Deploy MockUSDC (local only — testnet/mainnet use env override)
 2.  Deploy GoblinBadge(owner)
 3.  Deploy GoblinAccess(badge)
 4.  Deploy GoblinCurve(usdc, badge, access, owner)
 5.  badge.setCurve(curve)        ← one-shot, locks the binding
 6.  Deploy GoblinTokenFactory(curve)
 7.  curve.setFactory(factory)    ← one-shot, locks the binding
 8.  Deploy GoblinItem(owner)
 9.  Deploy GoblinQuest(item, owner)
10.  Deploy GoblinPvP(badge, item, access, quest, owner)
11.  item.addMinter(quest)
12.  item.addMinter(pvp)
13.  badge.setPvP(pvp)            ← one-shot
14.  curve.setPvP(pvp)            ← one-shot
15.  quest.addOracle(oracleEOA)
16.  quest.addAutoTrigger(pvp)
```

`scripts/deploy.js` does all seven steps in one run and dumps a linkage check at the end.

The one-shot setters (`setCurve`, `setFactory`) revert if called a second time. This means a compromised owner cannot swap in a malicious factory mid-flight to mint tokens with attacker-controlled bytecode.

## Why CREATE2 for token deploys

- **Predictable addresses.** Indexers, the X bot, and the frontend can subscribe to a token's address before the launch tx even lands. Critical on Monad's fast blocks where waiting on a receipt is dead air.
- **Replayable launches.** Salt is `keccak256(creator, symbol, block.timestamp)`. Same creator can relaunch the same symbol later without a CREATE2 collision.
- **Curve-only.** Factory's `deploy()` is gated by `onlyCurve`. Nobody else can squat addresses or front-run a creator's symbol.

`predictAddress(name, symbol, supply, creator, timestamp)` is the public mirror — pass the same args and you get the address `deploy()` will produce.

## Why virtual reserves

Naive `x*y=k` with real-only reserves means the first buyer gets ~all the supply for a penny. Bad UX, terrible price discovery.

The virtual offset (`VIRTUAL_USDC_OFFSET = 1000 USDC`) is added to the USDC side of the curve at launch. The token side starts at full `INITIAL_SUPPLY`. So the starting price is:

```
price_0 = VIRTUAL_USDC_OFFSET / INITIAL_SUPPLY
        = 1000e6 / 1_000_000_000e18
```

Tiny but nonzero. Buyers can't extract the whole curve for dust, and price scales smoothly as USDC accumulates. The "virtual" USDC isn't real — only `realUSDCCollected` (net of fees) counts toward graduation.

See `docs/BONDING_CURVE.md` for the full math.

## Why soulbound

Reputation has to belong to the wallet that earned it. If a TRENCH badge could be sold, the floor for KING is "buy ten TRENCH wallets, wash-trade them up." So every transfer surface on `GoblinBadge` reverts with `Soulbound()` — `transferFrom`, both `safeTransferFrom` overloads, `approve`, `setApprovalForAll`. The ERC-721 read surface still works (token URIs, balances) for marketplace and indexer compatibility, but writes are locked.

The only state change to a badge is rank up (monotonic) or the single KING→VETERAN demotion. Both are curve-only.

## How fees flow

Two streams. Trading fee on every trade, graduation fee one-shot at 69k.

### Trading fee (1% gross, rank-scaled)

```
   Buyer ──usdcIn──► Curve
                       │
                       ├── fee
                       │     ├── 20% → pendingWithdrawals[creator]   (creator share)
                       │     └── 80% → accumulatedFees               (protocol)
                       │
                       └── usdcAfterFee
                              ├──► virtualUSDC  (pricing)
                              ├──► realUSDCCollected  (graduation progress)
                              └──► totalReserves  (solvency check)
```

`CREATOR_FEE_SHARE_BPS = 2000`. Same split applies to sell fees. Emits `CreatorFeeAccrued(tokenId, creator, amount)` on every credit. Creator pulls via `claim()`.

### Graduation fee (one-shot, 2%)

Fires inside `_buy` the moment `realUSDCCollected` crosses `GRADUATION_THRESHOLD` (after the H-2 clamp lands it on exactly 69k):

```
   realUSDCCollected == 69,000
              │
              ├── graduationFee = 69,000 * 200 / 10_000 = 1,380
              │         └──► accumulatedFees
              │
              └── realUSDCCollected -= graduationFee
                  → ends at 67,620
```

`GRADUATION_FEE_BPS = 200`. Emits `GraduationFeeTaken(tokenId, fee)`. The 67,620 is what's locked in the curve until `releaseAuctionFunds`.

### Why trading fees don't count toward graduation

`accumulatedFees` and `pendingWithdrawals[creator]` are their own storage. Neither counts toward `realUSDCCollected` or `totalReserves`. The 69k threshold is 69k of *net* buy-side USDC, regardless of fee policy. Owner can sweep fees mid-launch without disturbing graduation math.

Sells: gross USDC out is computed by the curve, fee is taken from the proceeds before sending, then split 80/20 protocol/creator. Sells also bump `lifetimeVolumeUSDC` and the seller's KING-table position.

`withdrawFees(to)` is owner-only and pulls the full `accumulatedFees` bucket in one shot. Resets to zero, then `transfer()`s. Doesn't touch `pendingWithdrawals` — those belong to creators / relayers.

## How graduation works

A token graduates when `realUSDCCollected >= GRADUATION_THRESHOLD` (69,000e6 USDC). After graduation:

- The 2% graduation fee is deducted immediately. `realUSDCCollected` lands at **67,620**, the 1,380 cut moves to `accumulatedFees`.
- `t.graduated = true`. All `buy()` and `sell()` calls revert with `TokenAlreadyGraduated`.
- The buyer who tripped graduation gets `bumpGraduationsWitnessed` — one step toward VETERAN.
- The 67,620 sits in the curve until the owner calls `releaseAuctionFunds(tokenId, relayer, amount)`. One-shot per token.

### The H-2 boundary clamp

This is the subtle part. Without the clamp, a buyer who lands a 100k USDC buy when there's 5k of slack to graduation would have 95k of USDC pulled and credited to `realUSDCCollected`, blowing past the threshold and leaving the curve over-collateralized relative to a clean graduation boundary.

The clamp solves the inverse: given a target `slack = GRADUATION_THRESHOLD - realUSDCCollected` (the post-fee amount we want to land at), what's the minimum `usdcIn` such that `usdcIn - fee == slack` exactly?

```
usdcIn * (BPS_DENOM - feeBps) / BPS_DENOM == slack
```

Integer division can leave us a wei short, so we bump `usdcIn` by 1 wei at a time until `usdcAfterFee >= slack`, then trim the overflow into the fee bucket. Net result: `realUSDCCollected` lands exactly at `GRADUATION_THRESHOLD`, fee bucket absorbs the rounding crumb, and the buyer's USDC pull is exactly what fits — they don't overpay.

After clamp, the only reachable outcome is `realUSDCCollected == GRADUATION_THRESHOLD`. The `>=` in the graduation check is defense-in-depth.

## Oracle architecture

Originally a single oracle. M-1 widened to a set:

- `oracle` (legacy single slot, kept for backwards-compat reads)
- `isOracle[address]` set; any registered oracle can call `setGoblinScore`
- `lastScoreUpdate[tokenId]` enforces a 1-hour cooldown per token

`setOracle(addr)` replaces the primary oracle in both the legacy slot and the set. `addOracle` / `removeOracle` manage the set independently. Owner-only.

Score → label thresholds:

- `< 40` → CURSED
- `40–69` → NEUTRAL
- `>= 70` → BLESSED

CURSED labels are what unlock the rugs-survived stat on sells.

## Flagging / rescoring

VETERAN+ can call `flagForRescore(tokenId)`. Each address counts once per token. At `flagCount >= access.getFlagThreshold()` (5), a `RescoringTriggered` event fires — off-chain oracles are expected to subscribe and re-score.

The on-chain side does nothing automatic. It just emits the signal. Oracles do the actual rescore.

## Event surface

All trade events carry full post-trade state so indexers never need a `readContract` round-trip. `tokenId` is indexed on all three core events; secondary topics where they make sense.

```solidity
event TokenLaunched(
    uint256 indexed tokenId,
    address indexed token,
    address indexed creator,
    string  name,
    string  symbol,
    string  metadataURI,
    uint256 launchedAt
);

event TokenPurchased(
    uint256 indexed tokenId,
    address indexed buyer,
    uint256 usdcIn,
    uint256 tokensOut,
    uint256 virtualUSDCAfter,
    uint256 virtualTokenAfter,
    uint256 realUSDCCollectedAfter
);

event TokenSold(
    uint256 indexed tokenId,
    address indexed seller,
    uint256 tokensIn,
    uint256 usdcOut,
    uint256 virtualUSDCAfter,
    uint256 virtualTokenAfter,
    uint256 realUSDCCollectedAfter
);

event CreatorFeeAccrued(uint256 indexed tokenId, address indexed creator, uint256 amount);
event GraduationFeeTaken(uint256 indexed tokenId, uint256 fee);
event GraduationTriggered(uint256 indexed tokenId, uint256 realUSDCCollected);
```

## Storage / solvency

```solidity
uint256 public totalReserves;              // sum of realUSDCCollected across all tokens
uint256 public accumulatedFees;            // protocol's 80% cut + graduation fees
uint256 public totalPendingWithdrawals;    // sum of pendingWithdrawals[*] — creators + relayers
mapping(address => uint256) public pendingWithdrawals;
```

`totalPendingWithdrawals` tracks the aggregate of all pull-pattern credits (creator fee shares and released auction funds). Updated on every accrual and `claim()`.

Solvency invariant:

```solidity
function solvencyInvariant() external view returns (bool) {
    return usdc.balanceOf(address(this))
        >= totalReserves + accumulatedFees + totalPendingWithdrawals;
}
```

If this returns false, someone moved USDC the curve didn't account for. Monitor on every block.
