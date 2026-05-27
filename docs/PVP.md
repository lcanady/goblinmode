# PvP

Goblin-on-goblin violence. Burn a weapon, apply rot to a target, maybe demote their rank, maybe eat a reflect. One epoch = one hour. One un-resolved attack per target. Don't get killed.

Lives in `GoblinPvP.sol`. Requires `GoblinItem`, `GoblinBadge`, `GoblinAccess`, `GoblinQuest` wired.

## Epoch

```
epoch = block.timestamp / 3600
```

Rot is per-epoch. Cumulative rot resets at the next epoch boundary. Wallets near death just need to survive the hour.

## Who can attack

TRENCH+. `GoblinAccess.canInitiateAttack(wallet)` is the gate. CAVE wallets can be attacked but can't attack — they're already at the rank floor anyway, no demotion to inflict.

```solidity
function canInitiateAttack(address wallet) external view returns (bool) {
    return uint8(badge.getRank(wallet)) >= uint8(GoblinBadge.Rank.TRENCH);
}
```

## Attack flow

```
attacker                                              target
   │
   │  item.setApprovalForAll(pvp, true)   (one-time)
   │
   │  pvp.attack(target, weaponId)
   │  ├─► canInitiateAttack(attacker)? TRENCH+
   │  ├─► no existing un-resolved attack on target?
   │  ├─► attacker cooldown elapsed (10 min)?
   │  ├─► burn weapon
   │  └─► record ActiveAttack{attacker, weaponId, rotBps, ts}
   │     emit AttackLaunched, DefendWindowOpen
   │
   │                                         5-minute defend window opens
   │                                                   │
   │                                                   │  option A: pvp.defend(armorId)
   │                                                   │   ├─► burn armor
   │                                                   │   ├─► apply effective rot (post-block)
   │                                                   │   ├─► apply reflected rot to attacker (Legendary only)
   │                                                   │   └─► emit AttackBlocked, AttackLanded
   │                                                   │
   │                                                   │  option B: do nothing
   │                                                   │
   ▼                                                   ▼
attacker or anyone can call pvp.resolveAttack(target) after the window closes
   └─► full rotBps applied to target
       emit AttackLanded
```

Constants:

| Name | Value |
| --- | --- |
| `EPOCH_SECONDS` | 3600 |
| `DEFEND_WINDOW` | 300 (5 min) |
| `ATTACKER_COOLDOWN` | 600 (10 min between own attacks) |
| `BPS_DENOM` | 10,000 |

## The 16-combo defense matrix

`originalRot` = weapon rot bps. `blockBps`, `reflectBps` from armor. Effective rot to target = `originalRot * (BPS_DENOM - blockBps) / BPS_DENOM`. Reflected rot to attacker = `originalRot * reflectBps / BPS_DENOM`.

| Weapon \ Armor | Trash (block 25%) | Busted (block 50%) | Cursed (block 75%) | Legendary (block 100%, reflect 25%) |
| --- | --- | --- | --- | --- |
| **Trash** (2,500) | 1,875 to target | 1,250 to target | 625 to target | 0 to target, **625 reflected** |
| **Busted** (5,000) | 3,750 to target | 2,500 to target | 1,250 to target | 0 to target, **1,250 reflected** |
| **Cursed** (7,500) | 5,625 to target | 3,750 to target | 1,875 to target | 0 to target, **1,875 reflected** |
| **Legendary** (9,000) | 6,750 to target | 4,500 to target | 2,250 to target | 0 to target, **2,250 reflected** |

No-defend column (target eats full rot): Trash 2,500 / Busted 5,000 / Cursed 7,500 / Legendary 9,000.

Reflect only on Legendary armor. Trash/Busted/Cursed just absorb.

## Stacking and cooldowns

- **One un-resolved attack per target.** Calling `attack(target, ...)` while `activeAttacks[target].resolved == false` reverts with `AttackInProgress`. After the target defends or anyone calls `resolveAttack`, the slot frees and the next attacker can land theirs.
- **Per-attacker cooldown.** 10 minutes between your own attacks. Doesn't matter who you targeted last time.
- **Rot is capped at 10,000 bps per epoch per wallet.** Once a wallet hits the cap, further rot in the same epoch is a no-op for accumulation purposes. The killing-blow check still fires on the bump that crossed the cap.

## How rot lands on the curve

Rot doesn't take USDC. It doesn't seize tokens. It doesn't touch fees. It scales **rank-progression** counters on the curve during the current epoch only.

`GoblinCurve` consults `pvp.getRotMultiplierBps(wallet)` on every trade-driven stat bump. Returns the **surviving** fraction (10,000 = unaffected, 0 = fully rotted).

| Stat | Type | Rot behavior |
| --- | --- | --- |
| `tradeCount` | count | Probabilistic skip — RNG draw, skip if `rng >= surviving fraction` |
| `graduationsWitnessed` | count | Same — probabilistic skip |
| `rugsSurvived` | count | Same — probabilistic skip |
| `lifetimeUSDCVolume` | scalar | Deterministic scaling — `vol * survivingFraction / BPS_DENOM` |
| USDC/fee/token math | — | **Unaffected.** Trade economics don't see PvP. |

Why probabilistic for counts, deterministic for volume: counts are integers, you can't add 0.6 of a trade. Either you bump or you don't. Volume is a uint, smooth scaling works. Both reverse cleanly at the next epoch — rot is per-epoch and `getRotMultiplierBps` reads the current epoch's accumulator.

If `pvp` isn't wired or the call reverts, the curve treats it as 100% surviving (no rot). PvP is optional infrastructure.

## Killing blow

When cumulative epoch rot on a target hits 10,000 bps, the next attack that pushes it past triggers a demotion.

```
_applyRot(target, rotBps, attacker) {
    next = min(epochRotBps[epoch][target] + rotBps, 10_000)
    if (next == 10_000) {
        rank = badge.getRank(target)
        if (rank != CAVE && rank != ANCIENT) {
            badge.demoteRank(target)        // drops one tier
            emit RankDropped(...)
            try quest.autoTriggerDrop(attacker, KING_KILL) {} catch {}
        }
    }
}
```

| Target current rank | Outcome | Attacker loot |
| --- | --- | --- |
| CAVE | No demotion (floor). | No drop. |
| TRENCH | → CAVE | KING_KILL pool (0/10/30/60) |
| CURSED_HUNTER | → TRENCH | KING_KILL pool |
| VETERAN | → CURSED_HUNTER | KING_KILL pool |
| KING | → VETERAN | KING_KILL pool |
| ANCIENT | No demotion (immune). | No drop. |

`badge.demoteRank` is gated `onlyPvP` and one-shot bound via `setPvP`. ANCIENT can be attacked all day and never drops a rank. The seat is permanent.

KING_KILL drops use the autoTriggerDrop path (weaker randomness — see `ITEMS.md`). The `try/catch` means a Quest misconfiguration (e.g. PvP not added as autoTrigger, cooldown active) doesn't brick the raid — the demotion lands either way.

## Defender reflects

If the target burns Legendary armor:

1. Effective rot to target = 0 (100% block)
2. Reflected rot to attacker = `originalRot * 2500 / 10000`

The reflect can itself land a killing blow on the attacker. `_applyRot(attacker, reflected, address(0))` — note the `address(0)` second arg, meaning no further auto-drop loop. The attacker gets demoted, no one gets a loot drop for it. This is intentional: reflect is defense, not glory.

## Events (bot wire-up)

The X/Twitter bot subscribes to these. Each one is shaped to render a one-liner without a roundtrip.

```solidity
event AttackLaunched(address indexed attacker, address indexed target, GoblinItem.Rarity weaponRarity, uint16 rotBps);
event DefendWindowOpen(address indexed target, address indexed attacker, uint256 windowSeconds);
event AttackBlocked(address indexed target, address indexed attacker, GoblinItem.Rarity armorRarity, uint256 reflectedBps);
event AttackLanded(address indexed attacker, address indexed target, uint256 rotBps, uint256 epoch);
event RankDropped(address indexed target, GoblinBadge.Rank oldRank, GoblinBadge.Rank newRank, address indexed attacker);
```

Bot reaction templates:

- `AttackLaunched` → "$attacker just swung a $weapon at $target. 5 minutes to defend."
- `DefendWindowOpen` → use for the countdown UI
- `AttackBlocked` → "$target blocked with $armor" (+reflect line if `reflectedBps > 0`)
- `AttackLanded` → "rot landed. $rotBps bps on $target this epoch."
- `RankDropped` → "$target just got demoted from $oldRank to $newRank by $attacker. ouch."

## Known limitations

### 1. autoTriggerDrop randomness

Documented in `ITEMS.md` and `SECURITY.md`. Validator can influence `block.prevrandao XOR blockhash(n-1) XOR wallet XOR dropId`. Acceptable because the demotion already landed and KING_KILL drops are downstream cosmetic loot.

### 2. Same-stat-same-block randomness for `_maybeBump`

The probabilistic skip RNG includes `(blockhash(n-1), block.timestamp, wallet, kind, badge.tradeCount(wallet))`. **It does not include a tx index or call-counter.** If two `_maybeBump(wallet, kind=0)` fire in the same block before `tradeCount` increments (which can't happen on a single bump, but can across multiple skipped bumps across distinct trades in the same block), the RNG draws the same number. Same number, same outcome.

Practical impact: a rotted wallet making multiple trades in one block sees correlated bumps. The rotted wallet can't engineer a favourable outcome — the RNG is still bound to a blockhash they don't control — but the assumption of independence between same-block bumps is wrong. Documented in code, deemed not exploitable because rot is reversible next epoch and a CAVE wallet can't reach KING in one block regardless.

### 3. Cooldown stops rapid stacking but not coordinated swarms

`ATTACKER_COOLDOWN = 600` is per-attacker. Two attackers can land back-to-back attacks on the same target as soon as the first is resolved. A coordinated 4-wallet squad with Legendary weapons can demote a VETERAN inside 30 minutes. Working as intended.

### 4. No insurance / no shield items

You either have armor in inventory or you eat the rot. No "shield generator" item, no pre-emptive cast. Plan ahead.

## Test surface

`test/PvPQuest.test.js` covers:

- TRENCH gate on attack
- Cooldown enforcement
- The full 16-combo defense matrix (rotBps math)
- Reflect on Legendary armor
- Rot cap at 10,000 bps
- Killing blow demotion paths (TRENCH → CAVE, CURSED_HUNTER → TRENCH, etc.)
- CAVE floor and ANCIENT immunity
- KING_KILL auto-drop fires, doesn't brick on misconfigured Quest
- Commit-reveal happy path + bad reveal + window expiry
- Probabilistic skip on counts under partial rot
- Deterministic volume scaling under partial rot
- `getRotMultiplierBps` returns the surviving fraction
