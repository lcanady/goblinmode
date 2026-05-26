# Security

Trust model, what's been audited, what's been fixed, what to still watch out for, and how to fuzz the thing.

## Trust model

### What the owner CAN do

- Set the factory **once** (`setFactory`) — locked after first call
- Add/remove oracles (`addOracle`, `removeOracle`), replace primary oracle (`setOracle`)
- Set the ANCIENT seat **once** after first trade (`setAncient`)
- Sweep protocol fees to any address (`withdrawFees`)
- Release graduated funds to a relayer (`releaseAuctionFunds`) — single-shot per token
- Begin a two-step ownership transfer (`transferOwnership`)

### What the owner CANNOT do

- Mint, transfer, or burn user tokens — `GoblinToken` mints its full supply at construction to the curve, owner has no minter role
- Mutate user reputation directly — `GoblinBadge` writes are `onlyCurve`
- Swap the factory after wiring — `setFactory` reverts on second call
- Re-assign ANCIENT — `setAncient` reverts on second call
- Push funds to a blocklisted relayer such that the protocol is bricked — credits are pull-pattern via `claim()`
- Steal `realUSDCCollected` from active (non-graduated) curves — `withdrawFees` only touches `accumulatedFees`
- Move ownership without a two-step accept (L-1) — `acceptOwnership` must be called by the pending owner

### Oracle set

Multi-oracle (M-1). Any registered oracle can call `setGoblinScore(tokenId, score)`. One-hour cooldown per token prevents thrashing. Score → label thresholds are constants in the contract — oracles can't redefine the mapping.

### Factory binding

`GoblinTokenFactory.curve` is `immutable`, set at construction. The curve calls `setFactory(factoryAddr)` exactly once. Result: bidirectional binding, neither side can be swapped post-wiring. An attacker who compromises the owner key cannot inject a malicious factory.

## Audit findings & remediations

All findings remediated. Source of fix is cited inline.

| ID | Severity | Finding | Remediation |
| --- | --- | --- | --- |
| C-1 | Critical | (Internal review) Reserve accounting drift between `realUSDCCollected` and actual USDC balance under fee paths | Split `accumulatedFees` from `totalReserves`; added `solvencyInvariant()` view to assert `balance >= totalReserves + accumulatedFees` |
| C-2 | Critical | (Internal review) Factory address could be re-bound by owner, enabling malicious token bytecode injection | `setFactory` reverts with `FactoryAlreadySet` on second call. Factory's `curve` is `immutable`. Bidirectional one-shot binding |
| H-1 | High | Push-pattern auction release could brick the protocol if a relayer was USDC-blocklisted | `releaseAuctionFunds` now credits `pendingWithdrawals[relayer]`; `claim()` is the pull entrypoint, `nonReentrant`, effects-before-interactions |
| H-2 | High | Buy overshoot past `GRADUATION_THRESHOLD` left curve over-collateralized and ambiguous on AMM seeding | Boundary clamp in `_buy`: solve the inverse `usdcIn = slack * BPS_DENOM / (BPS_DENOM - feeBps)`, wei-bump until exact, trim crumb into fee bucket. `realUSDCCollected` lands exactly on threshold |
| H-5 | High | High-volume low-rank wallets could displace VETERANs from `top10`, preventing legitimate KING promotions | KING table eligibility now gates on `badge.getRank(wallet) >= VETERAN`. Low-rank wallets accumulate `lifetimeUSDCVolume` but don't enter `top10` |
| H-6 | High | Wash-trading tiny amounts could ladder a wallet from CAVE → VETERAN with no real volume | Added USDC volume floors: TRENCH 100, CURSED_HUNTER 500, VETERAN 5,000. All promotions require both count threshold **and** volume floor |
| M-1 | Medium | Single oracle was a centralization choke point; rapid re-scoring could whipsaw labels | Multi-oracle set (`isOracle` mapping); 1-hour cooldown per token (`lastScoreUpdate` + `SCORE_COOLDOWN`); `setOracle` retains legacy backwards-compat |
| M-2 | Medium | Factory deploy address was unpredictable, hurting sniper-resistance and indexer subscription | `predictAddress(name, symbol, supply, creator, timestamp)` mirrors `deploy()` exactly; same CREATE2 salt + initcode hash |
| L-1 | Low | Single-step `transferOwnership` risked locking the contract to a wrong address | Two-step transfer: `transferOwnership` sets `pendingOwner`, `acceptOwnership` finalizes from the new owner's wallet |

39 tests cover the curve and badge surface, including the boundary clamp, KING churn, ANCIENT one-shot gating, pull-pattern claims, score cooldown, and rank promotion gates.

## Known limitations

These are real and accepted trade-offs, not bugs.

### 1. USDC blocklist on `withdrawFees`

If the recipient of `withdrawFees(to)` is USDC-blocklisted, the call reverts. Owner must pass a non-blocklisted address. The fee bucket isn't bricked — it just can't be swept to that specific `to`. Pick a different address and retry.

We did **not** apply the pull-pattern here because `withdrawFees` is a privileged owner-only sweep, not a user-facing flow. Owner is expected to manage their own non-blocklisted treasury address.

### 2. MEV on launch

`launch()` is a public function. A bot watching the mempool can:

- See the launch tx
- Front-run the creator's `initialBuyUSDC` to land the first buy at lower price
- Sandwich the creator's buy

Mitigations on the contract side: `predictAddress` lets the creator pre-publish where the token *will* be, and `factory.deploy()` is curve-only so bots can't squat the address. But raw mempool front-running on the launch tx itself is **not** prevented in-contract — that's a Monad sequencer / RPC gateway concern.

If a private RPC / commit-reveal scheme becomes available on Monad, wire it up off-chain. The contract is agnostic.

### 3. Score-flip during sell semantics

`rugsSurvived` is bumped when `t.label == Label.CURSED` at the moment of sell. If an oracle flips a token's label between a holder's buy and their sell, the bookkeeping reflects the label *at sell time*, not whatever the label was during the hold.

This is intentional — the oracle's most recent verdict is the source of truth. But it means a label that gets flipped CURSED right before a planned sell credits the seller with a "rug survived" they didn't really weather. The 1-hour score cooldown (M-1) limits how fast this can be gamed, and only registered oracles can do the flip.

### 4. Top-10 churn cost

`_bumpVolumeAndMaybePromote` linear-scans a 10-element array on every buy and sell. Bounded gas — but every trade pays this cost even when the wallet isn't anywhere near top-10. Acceptable for a 10-element table; would be a problem at top-100.

### 5. Graduated token state is permanent

Once `t.graduated == true`, no further trades. `releaseAuctionFunds` can release the locked USDC once. If the relayer credit never gets `claim()`'d, the USDC sits in `pendingWithdrawals` forever — no rescue path. Pick relayers carefully.

## Invariants

These should hold for any sequence of valid txs. Worth fuzzing.

### I1. Solvency (the big one)

```
usdc.balanceOf(curve) >= totalReserves + accumulatedFees
```

Exposed as `solvencyInvariant()`. Must hold after every buy, sell, fee withdrawal, and auction release. Should be monitored on-chain.

### I2. Constant-product preservation per token

For any active (non-graduated) token, between trades:

```
virtualUSDC * virtualToken >= virtualUSDC_pre * virtualToken_pre
```

(Equal in the ideal case; `>=` because integer division floors `tokensOut` / `usdcGross` in the protocol's favor.)

### I3. Rank monotonicity (except KING demotion)

For any wallet, `uint8(getRank(wallet))` is monotonically non-decreasing over time, with one exception: KING → VETERAN when displaced from `top10`. No other demotion path exists.

### I4. Graduation threshold exact

After the H-2 clamp, the buy that graduates a token lands `realUSDCCollected == GRADUATION_THRESHOLD` exactly.

### I5. Badge uniqueness

`badgeOf[wallet] != 0` is true for any wallet that has ever traded. Each wallet has at most one badge. `tradeCount`, `graduationsWitnessed`, `rugsSurvived` are write-only from the curve.

### I6. ANCIENT singleton

At most one wallet has `Rank.ANCIENT`. `setAncient` reverts on second call.

### I7. KING ⇒ in top10

Any wallet with `Rank.KING` is currently somewhere in `top10`. If displaced, `demoteFromKing` is called atomically inside the displacement.

### I8. Score cooldown

For any `tokenId` with `lastScoreUpdate[tokenId] != 0`, the next successful `setGoblinScore` happens at `block.timestamp >= lastScoreUpdate[tokenId] + SCORE_COOLDOWN`.

## How to fuzz it

Recommended approach for an external fuzzing pass:

### Echidna / Foundry-invariant style

Set up a harness with:

- Deploy MockUSDC, badge, access, curve, factory (mirrors `scripts/deploy.js`)
- Launch 3–5 tokens from different creators
- Bound actors: 8–16 EOAs with pre-funded USDC and approvals to curve

Properties to assert (`echidna_*` style):

```
echidna_solvency() = curve.solvencyInvariant()
echidna_rank_monotonic() = ∀ wallet seen: rank[wallet] >= rank_prev[wallet] OR (rank_prev == KING && rank == VETERAN)
echidna_graduation_exact() = ∀ graduated tokenId: t.realUSDCCollected was == GRADUATION_THRESHOLD at the moment of graduation
echidna_constant_product() = ∀ active tokenId: vUSDC * vToken >= last_known_product
echidna_ancient_singleton() = count(wallets with rank == ANCIENT) <= 1
echidna_no_double_release() = ∀ tokenId graduated: auctionTriggered toggled at most once
```

Action space:

- `launch(name, symbol, metadataURI, initialBuyUSDC, minTokensOut)` per actor
- `buy(tokenId, usdcIn, minTokensOut)` per actor
- `sell(tokenId, tokensIn, minUSDCOut)` per actor
- `setGoblinScore(tokenId, score)` from an oracle EOA
- `flagForRescore(tokenId)` from VETERAN+ actors
- `claim()` from any actor with pending balance
- Owner ops: `withdrawFees`, `releaseAuctionFunds`, `setAncient`, `setOracle`

Targeted properties to chase via Echidna's coverage-guided search:

- Can the boundary clamp fail to land exactly on threshold under any fee bps?
- Can a wallet end up in `top10` without being VETERAN+?
- Can `solvencyInvariant()` return false through any combination of trades + sweeps + releases?
- Can a wallet bypass the volume floor for any rank promotion?
- Can `setGoblinScore` race the cooldown?

### Foundry invariant testing alternative

The 39-test Hardhat suite is unit-style. A Foundry invariant suite would be additive — invariant harnesses are easier to write in Solidity than via Ethers v6.

### Static analysis

Slither + Mythril on a clean compile. Solhint with the security ruleset. Compile with `--via-ir` for the optimizer to fold the clamp loop. Manual review on every `unchecked` block (currently zero — keeping it that way).
