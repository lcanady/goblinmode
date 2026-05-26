# Deploy

Full walkthrough for Monad testnet. Everything is immutable after wiring, so this is also the only chance to get it right.

## Pre-flight

### 1. Verify Monad testnet config

`hardhat.config.js` has a TODO for a reason. Before deploying:

- Confirm RPC URL at https://docs.monad.xyz — currently set to `https://testnet-rpc.monad.xyz`
- Confirm chainId — currently `10143`
- Confirm USDC contract address on Monad testnet (for the `USDC_ADDRESS` env)

If any of these have moved, fix `hardhat.config.js` first.

### 2. Env vars

Copy `.env.example` to `.env` and fill in:

```bash
MONAD_RPC_URL=https://testnet-rpc.monad.xyz
DEPLOYER_PRIVATE_KEY=0x...          # deployer EOA private key
USDC_ADDRESS=0x...                   # Monad testnet USDC; leave unset → deploys MockUSDC
```

If `USDC_ADDRESS` is unset or `0x0000...0000`, the deploy script deploys a fresh `MockERC20` as USDC. Useful for end-to-end local testing; **never use this on mainnet.**

### 3. Compile clean

```bash
npx hardhat compile
npx hardhat test
```

39 tests should pass. If anything is red, stop. Don't deploy on red.

## The deploy

```bash
npx hardhat run scripts/deploy.js --network monadTestnet
```

`scripts/deploy.js` runs the full wiring in order:

```
1. (optional) Deploy MockUSDC                  ← only if USDC_ADDRESS unset
2. Deploy GoblinBadge(deployer)                ← owner = deployer
3. Deploy GoblinAccess(badge)
4. Deploy GoblinCurve(usdc, badge, access, deployer)
5. badge.setCurve(curve)                       ← ONE-SHOT, locks binding
6. Deploy GoblinTokenFactory(curve)
7. curve.setFactory(factory)                   ← ONE-SHOT, locks binding
```

The script prints addresses as it goes and dumps a linkage check at the end:

```
--- Linkage check ---
badge.curve(): 0x...
access.badge(): 0x...
curve.usdc(): 0x...
curve.badge(): 0x...
curve.access(): 0x...
curve.factory(): 0x...
factory.curve(): 0x...
```

Every line should be a non-zero address matching the deployed contract. Save the output.

## Post-deploy verification

These steps are not in the script. Do them by hand or in a follow-up script, before announcing or letting any wallet trade.

### 1. Solvency invariant baseline

```bash
npx hardhat console --network monadTestnet
> const curve = await ethers.getContractAt("GoblinCurve", "0x<curveAddr>")
> await curve.solvencyInvariant()
true
```

Fresh deploy has zero reserves and zero accumulated fees, so this trivially holds. The point is to confirm the view function is callable and the contract bytecode matches.

### 2. Factory linkage (bidirectional)

```js
> await curve.factory()
"0x<factoryAddr>"
> const factory = await ethers.getContractAt("GoblinTokenFactory", "0x<factoryAddr>")
> await factory.curve()
"0x<curveAddr>"
```

Both must point at each other. If either is wrong, **redeploy** — `setFactory` is one-shot and immutable.

### 3. Badge linkage

```js
> await badge.curve()
"0x<curveAddr>"
> await curve.badge()
"0x<badgeAddr>"
```

Same check, both directions. `setCurve` is also one-shot.

### 4. Set the oracle set

Bootstrap oracle is the deployer. For production, you want a dedicated oracle key (or a multisig). Add the real oracle, then optionally remove the deployer:

```js
> await curve.addOracle("0x<oracleAddr>")
> // Optionally rotate primary off the deployer:
> await curve.setOracle("0x<oracleAddr>")
> // Optionally remove the deployer from the set entirely:
> await curve.removeOracle("0x<deployerAddr>")
```

Verify:

```js
> await curve.isOracle("0x<oracleAddr>")
true
> await curve.oracle()
"0x<oracleAddr>"
```

### 5. ANCIENT placeholder (intentionally not set)

`setAncient` is gated by `firstTradeBlock != 0`. Do **not** try to set it before any trade has happened — it will revert with `NoTradesYet`.

Leave `ancientAddress` as `address(0)` at deploy time. Set it later, post-launch, once the protocol has real activity. One-shot. Pick carefully.

### 6. Two-step ownership rotation (recommended)

The deployer EOA should not be the long-term owner. Rotate to a multisig:

```js
> await curve.transferOwnership("0x<multisig>")
> // From the multisig:
> await curve.acceptOwnership()
> await curve.owner()
"0x<multisig>"
```

Repeat for `GoblinBadge` (badge has its own owner — it's the one that called `setCurve`). Factory has no owner (immutable curve binding).

L-1 fix: the transfer doesn't take effect until `acceptOwnership` is called by the pending owner. So a wrong-address fat-finger on `transferOwnership` is recoverable — just call `transferOwnership` again with the right address before the wrong one calls accept.

## Upgrade story

There is none. The contracts are not proxied. Once deployed and wired, the bytecode is the bytecode. This is intentional:

- Curve immutability is the entire trust pitch — "trustless launchpad" only means something if the owner can't swap implementation
- No proxy = no delegatecall, no storage layout traps, no upgrade governance to compromise
- If a future version is needed, it's a fresh deploy with its own curve, badge, factory, etc. Old tokens stay on old curve until their natural graduation.

The only mutable state is the storage written by trades and admin functions. Logic is frozen at deploy.

## Ownership rotation playbook

Two-step (L-1). Both `GoblinCurve` and `GoblinBadge` have independent owners — rotate each.

```js
// 1. Current owner signals the transfer
await curve.transferOwnership(newOwner)
// pendingOwner is now newOwner, but actual owner unchanged

// 2. New owner accepts
await curve.connect(newOwnerSigner).acceptOwnership()
// owner() == newOwner; pendingOwner cleared

// 3. Verify
await curve.owner() // → newOwner
await curve.pendingOwner() // → 0x0
```

Mistakes are recoverable until step 2. After step 2, only the new owner can rotate further.

## Frontend / bot wiring

Both ship as scaffolds. After deploy:

- Frontend: drop the curve, badge, access, factory addresses into the app config. ABIs live in `artifacts/contracts/`.
- Bot: same — needs curve address + RPC + oracle private key (if it doubles as a scoring bot).

Neither is built. See `frontend/README.md` and `bot/README.md` for the current state.

## If something goes wrong

- **Deploy script reverts mid-flight:** the partial deploy is now garbage. The badge and access addresses are unusable (badge has no curve bound; can't be re-bound). Redeploy everything from scratch.
- **Wrong factory wired:** redeploy. `setFactory` is one-shot.
- **Wrong oracle:** fixable via `setOracle` / `addOracle` / `removeOracle`. Not destructive.
- **Wrong owner:** if you haven't called `acceptOwnership` from the wrong address yet, call `transferOwnership` again with the right one. If you have — well, the wrong owner controls the contract. Use the two-step rotation from there to recover.
- **`solvencyInvariant()` returns false post-deploy:** something is very wrong with the bytecode or USDC address. Stop. Investigate.
