# goblinmode.fun

Launch a coin. Trade it on a bonding curve. Earn a soulbound badge that gets you
cheaper fees and earlier looks at the next launch. Survive a rug, get a stripe
for it. Graduate at 69k USDC and the liquidity ships off to an AMM.

USDC-denominated. Monad-native. No middlemen, no admin keys printing tokens, no
"trust me bro."

## Stack

- `contracts/` — Solidity ^0.8.24, hand-rolled `Ownable` + `ReentrancyGuard`, zero external deps
- `scripts/deploy.js` — single-shot deploy + wiring
- `test/` — Hardhat + Chai (ethers v6) — **44 passing**
- `indexer/` — Ponder 0.9 + pglite/Postgres, REST + GraphQL on `:42069`
- `frontend/` — Next.js 14 app router (scaffold)
- `bot/` — X/Twitter event reactor (scaffold)

## Live on Monad testnet

Deployed at commit `c225a56`. Reserve token is `$GOBLIN` (MockERC20) — real USDC isn't on Monad testnet, so we run the curve against our own ERC-20. Mainnet swaps in Circle USDC at `0x534b2f3A21130d7a60830c2Df862319e593943A3`.

| Contract | Address |
| --- | --- |
| `$GOBLIN` (reserve) | [`0x60fa5f1794E08E4761De71403033D94069b6F01F`](https://testnet.monadexplorer.com/address/0x60fa5f1794E08E4761De71403033D94069b6F01F) |
| `GoblinBadge` | [`0x8187c3f4E82E84e2FB6aeA463d63715503DBEe4E`](https://testnet.monadexplorer.com/address/0x8187c3f4E82E84e2FB6aeA463d63715503DBEe4E) |
| `GoblinAccess` | [`0x40Ed9E1d14Ad7A21dC14f197F24b4541D4d9923C`](https://testnet.monadexplorer.com/address/0x40Ed9E1d14Ad7A21dC14f197F24b4541D4d9923C) |
| `GoblinCurve` | [`0x868874A8F47E8fa697A3E68460a7eEe8EF003479`](https://testnet.monadexplorer.com/address/0x868874A8F47E8fa697A3E68460a7eEe8EF003479) |
| `GoblinTokenFactory` | [`0xA53E19128f2C65059c4382dF2523DADFdC8e9e53`](https://testnet.monadexplorer.com/address/0xA53E19128f2C65059c4382dF2523DADFdC8e9e53) |
| Deployer / initial oracle | [`0xF3C20355E1CB26f39eC927a584749cF05Aa5cDE4`](https://testnet.monadexplorer.com/address/0xF3C20355E1CB26f39eC927a584749cF05Aa5cDE4) |

## Contracts

Five of them. Each does one thing.

| Contract | Job |
| --- | --- |
| `GoblinToken` | Fixed-supply ERC-20. Minted entirely to the curve at construction. |
| `GoblinTokenFactory` | CREATE2 deployer. Curve-only. Addresses predictable for snipers and indexers. |
| `GoblinBadge` | Soulbound ERC-721. One per wallet. Six ranks. Untransferable on purpose. |
| `GoblinAccess` | Pure read layer. Rank → fee bps, early-access window, flag rights. |
| `GoblinCurve` | The brain. x\*y=k against virtual USDC reserves. Graduates at 69k. |

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

## What works / what's left

**Works:**

- Full contract suite, compiled and tested (44 tests, all green)
- Deployed and wired on Monad testnet (commit `c225a56`)
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
