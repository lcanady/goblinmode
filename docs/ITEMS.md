# Items

Loot. ERC-1155, hand-rolled, eight ids. Two types, four rarities. Weapons attack, armor blocks. Both get burned when you use them. No marketplace gate — they're freely tradable (unlike the soulbound badge).

Lives in `GoblinItem.sol`. Drops come out of `GoblinQuest.sol`. Burns come out of `GoblinPvP.sol`.

## ID encoding

```
id = (uint256(type) << 8) | uint256(rarity)
```

| type | rarity | id (dec) | name |
| --- | --- | --- | --- |
| Weapon (0) | Trash (0) | 0 | Trash Weapon |
| Weapon (0) | Busted (1) | 1 | Busted Weapon |
| Weapon (0) | Cursed (2) | 2 | Cursed Weapon |
| Weapon (0) | Legendary (3) | 3 | Legendary Weapon |
| Armor (1) | Trash (0) | 256 | Trash Armor |
| Armor (1) | Busted (1) | 257 | Busted Armor |
| Armor (1) | Cursed (2) | 258 | Cursed Armor |
| Armor (1) | Legendary (3) | 259 | Legendary Armor |

`makeId(type, rarity)` and `decodeId(id)` are public helpers. Use them — don't reimplement.

## Drop pools

Quest rolls rarity from a per-event-type table, then flips a coin for weapon vs armor. Rarity roll: low 128 bits of the rng mod 10,000. Type roll: bit 128.

| Event type | Trash | Busted | Cursed | Legendary | Trigger |
| --- | --- | --- | --- | --- | --- |
| `ANY_TRADE` | 90% | 8% | 2% | 0% | Oracle, on any buy/sell |
| `SURVIVE_RUG` | 30% | 50% | 18% | 2% | Oracle, on selling a CURSED token |
| `EARLY_BUY` | 30% | 50% | 18% | 2% | Oracle, on early-window buys |
| `PVP_WIN` | 10% | 25% | 55% | 10% | Oracle, after a successful raid |
| `WITNESS_GRADUATION_3` | 10% | 25% | 55% | 10% | Oracle, on the 69k-crossing buy |
| `KING_KILL` | 0% | 10% | 30% | 60% | PvP, auto, on a killing-blow demotion |
| `SURVIVE_FIVE_RUGS` | 0% | 10% | 30% | 60% | Oracle, on 5th rug survived |

Weapon vs armor is 50/50 inside any pool.

## Weapon rot table

Weapon rarity → rot bps applied to target on a landed attack. Rot is measured in bps out of 10,000 (= 100% per-epoch progression knockout).

| Rarity | Rot bps | Effect |
| --- | --- | --- |
| Trash | 2,500 | 25% rot |
| Busted | 5,000 | 50% rot |
| Cursed | 7,500 | 75% rot |
| Legendary | 9,000 | 90% rot |

Single Legendary doesn't quite one-shot — needs 90% + at least a Trash chaser to cross 100% in one epoch (but only one un-resolved attack per target at a time, so the chaser has to wait for resolution). Two Legendaries in the same epoch will always kill if neither gets blocked.

## Armor block table

Armor rarity → block bps and reflect bps.

| Rarity | Block bps | Reflect bps | Effect |
| --- | --- | --- | --- |
| Trash | 2,500 | 0 | Eats 25% of incoming rot |
| Busted | 5,000 | 0 | Eats 50% |
| Cursed | 7,500 | 0 | Eats 75% |
| Legendary | 10,000 | 2,500 | Full block + 25% of original rot back at attacker |

Reflected rot is applied to the attacker for the current epoch. Only Legendary reflects. If reflected rot crosses the attacker's 100% threshold, the attacker eats a demotion — friendly fire is on.

## Drops: the commit-reveal flow

Normal drops (everything except `KING_KILL`) go through 2-tx commit-reveal. Oracle commits a hash bound to a secret seed + salt; later reveals seed and salt. Randomness = `seed XOR blockhash(commitBlock)`. Neither side can grind the outcome:

- Oracle can't pick a favourable seed after seeing the blockhash — they committed to the hash beforehand
- Block producer can't grind blockhash to favor a known seed — they don't know the seed at commit time

```
TX 1: triggerDrop(wallet, eventType, keccak256(seed, salt))
       └─► emits DropTriggered(dropId, wallet, eventType, commitHash)
       └─► records commitBlock = block.number

       ... wait at least 1 block, at most 256 blocks ...

TX 2: revealDrop(dropId, seed, salt)
       └─► verifies keccak256(seed, salt) == commitHash
       └─► rng = uint256(seed XOR blockhash(commitBlock))
       └─► rolls rarity + type, mints to wallet
       └─► emits DropRevealed(dropId, wallet, itemId, rarity, type)
```

`REVEAL_WINDOW_BLOCKS = 256`. Past that, `blockhash(commitBlock)` returns zero and reveal reverts with `RevealWindowClosed`. Anyone can call `expireDrop(dropId)` after the window closes to free the slot — no item minted, slot marked expired.

### Cooldown

Per `(wallet, eventType, epoch)`. Epoch = `block.timestamp / 3600`. One drop per wallet per event type per hour. Hard limit. Stops oracles from flooding a wallet with rolls in one tx.

## Drops: the autoTriggerDrop path (PvP-only, weaker randomness)

PvP killing blows can't wait two transactions — the rot needs to land and the loot needs to drop in the same tx, or the bot UX is broken. So `GoblinPvP` is allowed to call `autoTriggerDrop(wallet, eventType)` directly. No commit-reveal.

Randomness:

```
rng = keccak256(block.prevrandao, blockhash(block.number - 1), wallet, dropId)
```

This is **weaker than commit-reveal**. A block producer can influence `prevrandao` and `blockhash(n-1)` (Monad's fast-block consensus makes the validator manipulability surface real, though still expensive to exploit for a single loot drop). Documented limitation. Same-tx single-call randomness on a fast-block chain doesn't get better than this without VRF.

Acceptable trade-off because:

- `autoTriggerDrop` is gated by `isAutoTrigger[msg.sender]` (only PvP)
- Only fires on `KING_KILL` (after a demotion already landed — the demotion is the main outcome)
- Cooldown still enforced
- PvP catches a revert with `try/catch` so a quest misconfiguration can't brick a raid

If you want the strong-randomness drop, use the oracle commit-reveal path.

## Acquiring vs spending

| Action | How |
| --- | --- |
| Earn | Oracle observes a qualifying event off-chain, calls `triggerDrop` then `revealDrop`. PvP killing blow calls `autoTriggerDrop` directly. |
| Use | `GoblinPvP.attack(target, weaponId)` burns 1 weapon. `GoblinPvP.defend(armorId)` burns 1 armor. |
| Trade | Standard ERC-1155 `safeTransferFrom` / `safeBatchTransferFrom`. No protocol-level restriction. |
| Inspect | `balanceOf(wallet, id)`, `balanceOfBatch(wallets, ids)`, `uri(id)` |

PvP must be approved as an operator on the item contract before `attack` / `defend` will work — call `item.setApprovalForAll(pvp, true)` once.

## Minter allowlist

`mint` is gated by `minters[msg.sender]`. Owner adds `GoblinQuest` and `GoblinPvP` post-deploy:

```js
await item.addMinter(quest.address);
await item.addMinter(pvp.address);
```

No other minter. `removeMinter` is harmless — only blocks future mints, doesn't burn existing supply.

## Metadata

`uri(id)` returns `${baseURI}${id}.json`. `baseURI` defaults to `ipfs://placeholder/items/` at construction. Owner can call `setBaseURI(newBase)` to pin a final IPFS CID once art is frozen.

## Events

```solidity
event TransferSingle(operator, from, to, id, value);   // ERC-1155 standard
event TransferBatch(operator, from, to, ids, values);  // ERC-1155 standard
event ApprovalForAll(account, operator, approved);
event URI(value, id);

event MinterAdded(minter);
event MinterRemoved(minter);
event BaseURIUpdated(newBase);
```

Indexer keys on `TransferSingle` from `address(0)` (mints) and to `address(0)` (burns) to track per-wallet inventory without re-reading on every event.
