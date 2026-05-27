# goblinmode.fun

Launch a coin. Trade it on a bonding curve. Earn a soulbound badge that gets you
cheaper fees and earlier looks at the next launch. Survive a rug, get a stripe
for it. Graduate at 69k USDC and the liquidity ships off to an AMM.

USDC-denominated. Monad-native. No middlemen, no admin keys printing tokens, no
"trust me bro."

## Stack

- `contracts/` — Solidity ^0.8.24, hand-rolled `Ownable` + `ReentrancyGuard`, zero external deps
- `scripts/deploy.js` — single-shot deploy + wiring
- `test/` — Hardhat + Chai (ethers v6) — **75 passing**
- `indexer/` — Ponder 0.9 + pglite/Postgres, REST + GraphQL on `:42069`
- `frontend/` — Next.js 14 app router (scaffold)
- `bot/` — X/Twitter event reactor (scaffold)

## Live on Monad testnet

Full stack live — curve, badge, items, quest, PvP. Reserve token is `$GOBLIN` (MockERC20) — real USDC isn't on Monad testnet, so we run the curve against our own ERC-20. Mainnet swaps in Circle USDC at `0x534b2f3A21130d7a60830c2Df862319e593943A3`.

| Contract | Address |
| --- | --- |
| `$GOBLIN` (reserve) | [`0x3EAdAd0Ac866e2dBEfefBe23807509E2bc5fFacA`](https://testnet.monadexplorer.com/address/0x3EAdAd0Ac866e2dBEfefBe23807509E2bc5fFacA) |
| `GoblinBadge` | [`0x736A5aaa238d6d279a3c22D4F6018748C23c9887`](https://testnet.monadexplorer.com/address/0x736A5aaa238d6d279a3c22D4F6018748C23c9887) |
| `GoblinAccess` | [`0xE210a128B1fb01EBe7009A8749D92c9d117870bF`](https://testnet.monadexplorer.com/address/0xE210a128B1fb01EBe7009A8749D92c9d117870bF) |
| `GoblinCurve` | [`0x9f0fAbd89274e701379836329D9c99fCa6C6D75B`](https://testnet.monadexplorer.com/address/0x9f0fAbd89274e701379836329D9c99fCa6C6D75B) |
| `GoblinTokenFactory` | [`0x5f63ef0e407c17C3Fb1a8C0e682a0a128487f53a`](https://testnet.monadexplorer.com/address/0x5f63ef0e407c17C3Fb1a8C0e682a0a128487f53a) |
| `GoblinItem` | [`0x7B7DAA5EcC8BD20400D59569234B42373A91251c`](https://testnet.monadexplorer.com/address/0x7B7DAA5EcC8BD20400D59569234B42373A91251c) |
| `GoblinQuest` | [`0xaF367Acd5C05976751c24381E1DC6dA7f83Cf887`](https://testnet.monadexplorer.com/address/0xaF367Acd5C05976751c24381E1DC6dA7f83Cf887) |
| `GoblinPvP` | [`0x130f9ea294F1218590d828bEd8b2a97c51CB7493`](https://testnet.monadexplorer.com/address/0x130f9ea294F1218590d828bEd8b2a97c51CB7493) |
| Deployer / initial oracle | [`0xF3C20355E1CB26f39eC927a584749cF05Aa5cDE4`](https://testnet.monadexplorer.com/address/0xF3C20355E1CB26f39eC927a584749cF05Aa5cDE4) |

Previous testnet deploy (`0x60fa5f17…`, `0x868874A8…`, etc.) is dead. Don't point anything new at it.

### Live attack flow — proof it works end-to-end

Real txs from `scripts/attack-flow.js` against the addresses above:

- **Attack**: [`0x7d5504d7…`](https://testnet.monadexplorer.com/tx/0x7d5504d72937ab237c6bda048b39133dbb5017f328fc5d47ec430a2964ce9e73) — Cursed Weapon (7,500 rot bps) swung at burner target
- **Defend**: [`0x614e0430…`](https://testnet.monadexplorer.com/tx/0x614e04302344a37d483012740c9aa17fdaca6e81fe6eea50af1e5c07a1d2fb38) — Busted Armor (50% block) absorbed half
- **Result**: 3,750 effective rot bps landed. Target rank unchanged (CAVE floor, needs cumulative 10,000 bps in one epoch for a killing blow).

Real quest drop tx (KING_KILL pool, oracle commit-reveal): [`0x9785d110…`](https://testnet.monadexplorer.com/tx/0x9785d1107544c208c34f5b64fb0f2a703ab65d33643288beb754c6235afdb241) → Cursed Armor.

## Contracts

Eight of them. Each does one thing.

| Contract | Job |
| --- | --- |
| `GoblinToken` | Fixed-supply ERC-20. Minted entirely to the curve at construction. |
| `GoblinTokenFactory` | CREATE2 deployer. Curve-only. Addresses predictable for snipers and indexers. |
| `GoblinBadge` | Soulbound ERC-721. One per wallet. Six ranks. Untransferable on purpose. |
| `GoblinAccess` | Pure read layer. Rank → fee bps, early-access window, flag rights, attack gate. |
| `GoblinCurve` | The brain. x\*y=k against virtual USDC reserves. Graduates at 69k. |
| `GoblinItem` | ERC-1155 loot. 8 ids (2 types × 4 rarities). Weapons attack, armor defends. |
| `GoblinQuest` | Drop engine. Commit-reveal randomness for normal drops, weaker single-tx path for PvP-driven drops. |
| `GoblinPvP` | Raids. Burn weapon → rot a target → maybe demote their rank. |

### Constants

| Name | Value |
| --- | --- |
| `INITIAL_SUPPLY` | 1e9 tokens (18 dec) |
| `VIRTUAL_USDC_OFFSET` | 1,000 USDC |
| `GRADUATION_THRESHOLD` | 69,000 USDC |
| `DEFAULT_FEE_BPS` | 100 (1%) trading fee |
| `CREATOR_FEE_SHARE_BPS` | 2000 (20% of every trading fee → creator) |
| `GRADUATION_FEE_BPS` | 200 (2% one-shot cut at 69k) |
| `SCORE_COOLDOWN` | 1 hour per token, per oracle write |

## Revenue model

Two fee streams. Both denominated in the reserve token.

| Stream | Rate | Split | When |
| --- | --- | --- | --- |
| Trading fee | 1% (rank-scaled down to 0.5% for ANCIENT) | 80% protocol → `accumulatedFees`, 20% creator → `pendingWithdrawals[creator]` | Every buy and every sell |
| Graduation fee | 2% of the 69k threshold (~1,380 $GOBLIN) | 100% protocol → `accumulatedFees` | One-shot, the moment a token crosses 69k |

Creators pull their cut via the existing `claim()`. Trading fee bps in the [rank ladder](#rank-ladder) below is the **gross** bps — the protocol keeps 80% of those bps, the creator gets the other 20%. Same math, two beneficiaries.

Graduation fee deducts from `realUSDCCollected` after the H-2 boundary clamp lands it on 69k. Net real reserves at graduation: **67,620**. The 1,380 lives in `accumulatedFees`. Emits `GraduationFeeTaken(tokenId, fee)`.

## Quest + PvP

Loot, drops, and goblin-on-goblin violence. Lives next to the trading core, doesn't touch trade economics.

- **Items** — ERC-1155, 8 ids (Weapon|Armor × Trash|Busted|Cursed|Legendary). Freely tradable, no soulbinding. Burned on use.
- **Drops** — `GoblinQuest` rolls rarity from per-event-type pools (ANY_TRADE, SURVIVE_RUG, PVP_WIN, KING_KILL, etc.). Oracles call `triggerDrop` then `revealDrop` — commit-reveal randomness using `seed XOR blockhash(commitBlock)`. PvP killing blows use a weaker single-tx path (`block.prevrandao` based) so the loot lands in the same tx as the demotion. Documented caveat — see `SECURITY.md`.
- **Raids** — `GoblinPvP` lets TRENCH+ wallets burn a Weapon to apply *score rot* to a target for the current epoch (1 hour). Defender has 5 minutes to burn Armor and absorb/reflect. Rot scales rank-progression on the curve for that epoch only — trade USDC/fees/tokens are untouched. Cumulative rot ≥ 100% in one epoch = **killing blow**: target drops one rank (CAVE is the floor, ANCIENT immune), attacker gets a KING_KILL drop.

Full writeups:

- [`docs/ITEMS.md`](docs/ITEMS.md) — id encoding, drop pools, weapon rot table, armor block table, commit-reveal flow
- [`docs/PVP.md`](docs/PVP.md) — epoch math, 16-combo defense matrix, killing-blow rules, bot event surface

### Rank ladder

Promotions need **both** a count threshold and a USDC volume floor. Wash-trading
dust does nothing.

| Rank | Promotion trigger | Volume floor | Fee bps | Early access (s) |
| --- | --- | --- | --- | --- |
| CAVE | default on first trade | — | 100 | 0 |
| TRENCH | 5+ trades | 100 USDC | 90 | 30 |
| CURSED_HUNTER | 1+ rug survived (sold a CURSED token after buying) | 500 USDC | 85 | 60 |
| VETERAN | 3+ graduations witnessed | 5,000 USDC | 75 | 90 |
| KING | top-10 lifetime USDC volume **and** already VETERAN | (top-10 churns) | 60 | 120 |
| ANCIENT | one-shot owner appointment after first trade | — | 50 | 999 |

KING is dynamic — fall out of the top 10 and you get bumped back to VETERAN.
ANCIENT is one seat, set once, forever. Don't ask.

### Other things worth knowing

- **Multi-oracle scoring.** Any registered oracle can score a token. 1-hour cooldown per token kills score-thrashing.
- **Two-step ownership.** `transferOwnership` then `acceptOwnership`. No fat-fingering keys into the void.
- **Pull-pattern relayer payouts.** `releaseAuctionFunds` credits, `claim()` withdraws. Blocklisted relayer can't brick the system.
- **CREATE2 launches.** Address predictable from `(creator, symbol, timestamp)`. Indexers and snipers can subscribe ahead of the tx.
- **Solvency invariant.** `usdc.balanceOf(curve) >= totalReserves + accumulatedFees + totalPendingWithdrawals` — view function, monitor it.
- **Enriched events.** `TokenLaunched`, `TokenPurchased`, `TokenSold` carry full post-trade state (`virtualUSDCAfter`, `virtualTokenAfter`, `realUSDCCollectedAfter`) and indexed `tokenId`. Indexer never needs a post-trade `readContract` call.

## Indexer

Lives in `indexer/`. Ponder 0.9, pglite in dev, Postgres in prod. Pointed at the live testnet contracts above.

- REST: `http://localhost:42069/api/v1`
- GraphQL: `http://localhost:42069/graphql`
- Schema: `token`, `trade`, `user`, `flag`, `candle`

See [`docs/DEPLOY.md`](docs/DEPLOY.md#indexer) for env + Railway notes.

## Setup

```bash
npm install
cp .env.example .env
# fill in MONAD_RPC_URL, DEPLOYER_PRIVATE_KEY, optionally USDC_ADDRESS
```

## Commands

```bash
npx hardhat compile
npx hardhat test
npx hardhat run scripts/deploy.js --network monadTestnet
```

## Quick scripts

All live against the testnet addresses above. Run with `npx hardhat run scripts/<file>.js --network monadTestnet`.

| Script | What it does |
| --- | --- |
| `deploy.js` | Single-shot deploy + wiring of the entire stack (curve, badge, access, factory, item, quest, pvp). |
| `launch-token.js` | Launches a token via the factory and (optionally) seeds it with trades. |
| `graduate.js` | Drives a token across the 69k threshold to test the graduation clamp. |
| `quest.js` | Standalone quest drop — oracle commits + reveals. Env: `WALLET`, `EVENT` (`ANY_TRADE`, `SURVIVE_RUG`, `EARLY_BUY`, `PVP_WIN`, `WITNESS_GRADUATION_3`, `KING_KILL`, `SURVIVE_FIVE_RUGS`). |
| `attack-flow.js` | Full live e2e PvP run: funds a burner target, drives attacker to TRENCH, quests weapon + armor, attacks, defends. Restartable — reads on-chain state to skip done steps. |
| `smoketest.js` | Sanity sweep over the live deployment. |

## Network

`monadTestnet` is wired in `hardhat.config.js`:

- RPC: `https://testnet-rpc.monad.xyz`
- chainId: `10143`

**Verify against Monad's current docs before mainnet.** There's a TODO in the
config for a reason.

## Docs

Deeper writeups live in `docs/`:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system graph, deploy order, design rationale
- [`docs/BONDING_CURVE.md`](docs/BONDING_CURVE.md) — the math, fee mechanics, graduation clamp
- [`docs/RANKS.md`](docs/RANKS.md) — full ladder, perks, KING table churn, ANCIENT semantics
- [`docs/SECURITY.md`](docs/SECURITY.md) — trust model, audit remediations, invariants, fuzz hooks
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — Monad testnet walkthrough, post-deploy verification, ownership rotation
- [`docs/ITEMS.md`](docs/ITEMS.md) — loot system: ERC-1155 ids, drop pools, commit-reveal
- [`docs/PVP.md`](docs/PVP.md) — raid system: attack flow, defense matrix, killing blows

## What works / what's left

**Works:**

- Full contract suite, compiled and tested (75 tests, all green)
- Deployed and wired on Monad testnet — full stack including PvP/Quest/Item
- Live PvP attack flow landed end-to-end on testnet ([attack](https://testnet.monadexplorer.com/tx/0x7d5504d72937ab237c6bda048b39133dbb5017f328fc5d47ec430a2964ce9e73) + [defend](https://testnet.monadexplorer.com/tx/0x614e04302344a37d483012740c9aa17fdaca6e81fe6eea50af1e5c07a1d2fb38))
- Ponder indexer running against live contracts
- Bonding curve buy/sell with rank-scaled fees
- Soulbound badge with all six rank transitions including KING churn + ANCIENT one-shot
- Multi-oracle scoring with cooldown
- Graduation with H-2 boundary clamp (overpaying near 69k doesn't over-collect)
- Pull-pattern relayer payouts
- Deterministic CREATE2 address prediction
- All audit findings (C-1, C-2, H-1, H-2, H-5, H-6, M-1, M-2, L-1) remediated — see `docs/SECURITY.md`

**Scaffolded (not built):**

- `frontend/` — Next.js 14 skeleton. No wallet wiring, no curve UI, no badge display yet.
- `bot/` — package.json + README only. The X/Twitter event reactor is a TODO.

**Pre-mainnet TODOs:**

- Re-verify Monad RPC + chainId
- Real USDC address on Monad (currently a `MockERC20` for local; env override for testnet)
- IPFS metadata pipeline for badge `tokenURI` (currently returns `ipfs://placeholder/<rank>.json`)
- External fuzzing pass on the curve math and rank state machine
