# goblinmode.fun

Launch a coin. Trade it on a bonding curve. Earn a soulbound badge that gets you
cheaper fees and earlier looks at the next launch. Survive a rug, get a stripe
for it. Graduate at 69k USDC and the liquidity ships off to an AMM.

USDC-denominated. Monad-native. No middlemen, no admin keys printing tokens, no
"trust me bro."

## Stack

- `contracts/` — Solidity ^0.8.24, hand-rolled `Ownable` + `ReentrancyGuard`, zero external deps
- `scripts/deploy.js` — single-shot deploy + wiring
- `test/` — Hardhat + Chai (ethers v6) — **39 passing**
- `frontend/` — Next.js 14 app router (scaffold)
- `bot/` — X/Twitter event reactor (scaffold)

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
| `DEFAULT_FEE_BPS` | 100 (1%) |
| `SCORE_COOLDOWN` | 1 hour per token, per oracle write |

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
- **Solvency invariant.** `usdc.balanceOf(curve) >= totalReserves + accumulatedFees` — view function, monitor it.

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

- Full contract suite, compiled and tested (39 tests, all green)
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
