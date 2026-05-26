# Bonding Curve

The math under every trade. Constant product, virtual reserves, fees on top, graduation clamped to the boundary.

## The invariant

Standard Uniswap-style constant product:

```
x * y = k
```

Where:

- `x` = `virtualUSDC` (6-dec USDC, includes the 1,000 USDC offset at launch)
- `y` = `virtualToken` (18-dec token, starts at `INITIAL_SUPPLY = 1e9 * 1e18`)
- `k` = `x * y` (implied; never stored — recomputed each swap by adjusting reserves)

The "virtual" in `virtualUSDC` is the launch offset (1,000 USDC) that's added to the curve at construction but never collected as a real reserve. It exists solely to push the starting price above zero. Only `realUSDCCollected` (net of fees) counts toward graduation.

## Quote derivation

### Buy: USDC in → tokens out

Pre-trade: `(virtualUSDC, virtualToken)`. Trade: buyer adds `usdcAfterFee` to the USDC side, removes `tokensOut` from the token side. The invariant says:

```
(virtualUSDC + usdcAfterFee) * (virtualToken - tokensOut) = virtualUSDC * virtualToken
```

Solve for `tokensOut`:

```
tokensOut = virtualToken * usdcAfterFee / (virtualUSDC + usdcAfterFee)
```

That's exactly what `_getTokensOut` computes:

```solidity
function _getTokensOut(uint256 vUSDC, uint256 vToken, uint256 usdcIn) internal pure returns (uint256) {
    if (usdcIn == 0) return 0;
    return (vToken * usdcIn) / (vUSDC + usdcIn);
}
```

Integer division floors. **Rounding favors the protocol** — the buyer gets at most the exact math result, never more.

### Sell: tokens in → USDC out (gross)

Symmetric. Seller adds `tokensIn` to the token side, removes `usdcGross` from the USDC side:

```
(virtualUSDC - usdcGross) * (virtualToken + tokensIn) = virtualUSDC * virtualToken
```

Solve:

```
usdcGross = virtualUSDC * tokensIn / (virtualToken + tokensIn)
```

`_getUSDCOut` matches. Same floor-rounding-in-protocol's-favor.

Sells then deduct the rank-scaled fee from `usdcGross` to produce `usdcOut`. Fees on sells come out of the seller's proceeds, not added on top.

## Fee mechanics

Fee bps is read from `GoblinAccess.getFeeBps(caller)` at trade time. So a wallet that ranks up between two buys pays the new lower fee on the next one. No staleness.

### Buy fee

```
fee          = usdcIn * feeBps / BPS_DENOM
usdcAfterFee = usdcIn - fee
```

The full `usdcIn` is `transferFrom`'d from the buyer. `fee` goes to `accumulatedFees`. `usdcAfterFee` goes into the curve and into `realUSDCCollected`.

### Sell fee

```
gross  = _getUSDCOut(...)
fee    = gross * feeBps / BPS_DENOM
usdcOut = gross - fee
```

Seller receives `usdcOut`. `fee` goes to `accumulatedFees`. The curve's `virtualUSDC` and `realUSDCCollected` both decrease by `gross` (not by `usdcOut`) — because that's what the curve actually paid out economically; the fee is just routed to the protocol bucket instead of the seller.

### Why fees don't count toward graduation

`accumulatedFees` is its own storage slot. It's not part of `realUSDCCollected` and not part of `totalReserves`. `withdrawFees(to)` sweeps it independently.

This means: the 69k graduation threshold is 69k of *net* buy-side USDC, regardless of fee policy. Owner can sweep fees mid-launch without disturbing graduation math.

## Price formula

```solidity
function currentPrice(uint256 tokenId) external view returns (uint256) {
    return (t.virtualUSDC * 1e18) / t.virtualToken;
}
```

The raw ratio `virtualUSDC / virtualToken` is `(6-dec USDC) / (18-dec token)` — a tiny number. The `* 1e18` scale makes it readable in a uint. **This is a relative price, not a fixed-point USDC quote.** Frontends should treat it as a curve-position indicator, not a price oracle.

For an actual USDC-per-token quote, use `quoteBuy(tokenId, 1e6, buyer)` (or whatever USDC notional you care about) — that's the real number a trade would execute at.

## Graduation: the H-2 boundary clamp

The interesting math is what happens when a buy would push `realUSDCCollected` past `GRADUATION_THRESHOLD`.

### The naive (broken) version

Without a clamp:

```
realUSDCCollected += usdcAfterFee  // could overshoot 69k significantly
if (realUSDCCollected >= 69k) graduate
```

A buyer slamming 100k USDC into a curve with 5k of slack would have the full 100k pulled, 99k credited to reserves, and graduation triggered. The curve now has way more locked USDC than a clean graduation boundary, the buyer overpaid for tokens that no longer matter (the curve is closed), and the AMM seeding amount is ambiguous.

### The clamp

Solve the inverse: what's the minimum `usdcIn` such that `usdcAfterFee == slack` exactly, where `slack = GRADUATION_THRESHOLD - realUSDCCollected`?

```
usdcIn * (BPS_DENOM - feeBps) / BPS_DENOM == slack
                ↓
usdcIn = slack * BPS_DENOM / (BPS_DENOM - feeBps)
```

Implementation:

```solidity
uint256 slack = GRADUATION_THRESHOLD - t.realUSDCCollected;
uint256 cappedUsdcIn = (slack * BPS_DENOM) / (BPS_DENOM - feeBps);
uint256 cappedFee = (cappedUsdcIn * feeBps) / BPS_DENOM;
uint256 cappedAfterFee = cappedUsdcIn - cappedFee;

// Integer division can leave us 1 wei short. Bump until usdcAfterFee >= slack.
while (cappedAfterFee < slack) {
    cappedUsdcIn += 1;
    cappedFee = (cappedUsdcIn * feeBps) / BPS_DENOM;
    cappedAfterFee = cappedUsdcIn - cappedFee;
}

// Then trim any tiny overshoot into the fee bucket so realUSDCCollected lands exactly.
if (cappedAfterFee > slack) {
    cappedFee += (cappedAfterFee - slack);
    cappedAfterFee = slack;
}
```

After this loop:

- `cappedAfterFee == slack` exactly
- `cappedFee` absorbs the wei-level rounding crumb
- `cappedUsdcIn = cappedAfterFee + cappedFee` (still a valid sum, just with the fee slightly inflated)
- `realUSDCCollected + cappedAfterFee == GRADUATION_THRESHOLD` exactly

The buyer is only charged `cappedUsdcIn`, not the original `usdcIn`. The rest of their approval is never touched.

### Loop termination

The `while` loop bumps `usdcIn` by 1 wei at a time until `usdcAfterFee >= slack`. For any reasonable `feeBps < BPS_DENOM`, this terminates in at most a handful of iterations — `cappedAfterFee` grows by roughly `1 - feeBps/BPS_DENOM` per iteration, so worst-case ~`1 / (1 - feeBps/BPS_DENOM)` ≈ ~2 iterations for 100 bps.

### Graduation trigger

Strictly `>=`:

```solidity
if (!t.graduated && t.realUSDCCollected >= GRADUATION_THRESHOLD) {
    t.graduated = true;
    badge.bumpGraduationsWitnessed(buyer);
    emit GraduationTriggered(tokenId, t.realUSDCCollected);
}
```

After the clamp, the only reachable outcome is exact equality. The `>=` is defense-in-depth in case someone refactors the clamp out or a code path bypasses it.

Post-graduation: every subsequent `buy()` and `sell()` reverts with `TokenAlreadyGraduated`. The locked `realUSDCCollected` sits in the curve until `releaseAuctionFunds(tokenId, relayer, amount)` is called by the owner (single-shot per token).

## Rounding direction (summary)

| Operation | Direction | Beneficiary |
| --- | --- | --- |
| `_getTokensOut` (buy quote) | floor | protocol |
| `_getUSDCOut` (sell quote) | floor | protocol |
| Fee on buy (`usdcIn * feeBps / BPS_DENOM`) | floor | buyer (slightly), then protocol overrides at boundary |
| Fee on sell | floor | seller (slightly) |
| Boundary clamp | wei-bumped up until `>= slack`, then trimmed exactly | protocol (fee absorbs crumb) |

The graduation clamp is the only place the protocol intentionally rounds *against* the protocol's fee bucket — it has to, in order to land `realUSDCCollected` exactly on the threshold. Net effect on the fee bucket is sub-wei per graduation. Don't lose sleep.

## Solvency invariant

```solidity
function solvencyInvariant() external view returns (bool) {
    return usdc.balanceOf(address(this)) >= totalReserves + accumulatedFees;
}
```

Should hold after every buy, sell, graduation, fee withdrawal, and auction release. Specifically:

- `totalReserves` = sum of `realUSDCCollected` across all tokens
- `accumulatedFees` = unwithdrawn protocol fees
- Both bump up on buys, down on sells / releases / withdrawals

If this view returns `false`, something has paid out USDC that the curve didn't account for. Monitor it off-chain on every block.
