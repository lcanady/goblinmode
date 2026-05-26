const hre = require("hardhat");

// Drive a fresh token from launch -> graduation on Monad testnet.
// Verifies H-2 boundary clamp (lands at exactly 69k), badge graduations bump,
// post-grad buy rejection, oracle scoring, and solvency invariant across the cycle.
async function main() {
  const [signer] = await hre.ethers.getSigners();
  console.log("Signer:", signer.address);

  const RESERVE = process.env.RESERVE_ADDRESS;
  const CURVE = process.env.CURVE_ADDRESS;
  const BADGE = process.env.BADGE_ADDRESS;
  if (!RESERVE || !CURVE || !BADGE) {
    throw new Error("Set RESERVE_ADDRESS, CURVE_ADDRESS, BADGE_ADDRESS in env");
  }

  const reserve = await hre.ethers.getContractAt("MockERC20", RESERVE);
  const curve = await hre.ethers.getContractAt("GoblinCurve", CURVE);
  const badge = await hre.ethers.getContractAt("GoblinBadge", BADGE);
  const SIX = 1_000_000n;
  const fmt6 = (x) => (Number(x) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 });
  const fmt18 = (x) => Number(hre.ethers.formatUnits(x, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 });

  // --- Ensure enough $GOBLIN. Mint 100k buffer over the 69k threshold. ---
  const MAX = (1n << 256n) - 1n;
  const need = 100_000n * SIX;
  const bal = await reserve.balanceOf(signer.address);
  if (bal < need) {
    console.log("Topping up $GOBLIN to 100k+");
    await (await reserve.mint(signer.address, need)).wait();
  }
  await (await reserve.approve(CURVE, MAX)).wait();

  // --- 1. Launch fresh token with small initial buy ---
  const name = "Graduation Goblin";
  const symbol = "GRADGOB";
  const meta = "ipfs://placeholder/gradgob.json";
  console.log(`\n[1] Launch ${symbol}`);
  const launchTx = await curve.launch(name, symbol, meta, 100n * SIX, 0);
  const launchRcpt = await launchTx.wait();
  const launchedTopic = curve.interface.getEvent("TokenLaunched").topicHash;
  const launchLog = launchRcpt.logs.find((l) => l.topics[0] === launchedTopic);
  const tokenId = curve.interface.parseLog(launchLog).args.tokenId;
  const tokenAddr = curve.interface.parseLog(launchLog).args.token;
  console.log("   tokenId:", tokenId.toString(), "| token:", tokenAddr);
  console.log("   progress:", (await curve.graduationProgress(tokenId)).toString(), "bps");

  const gradsBefore = await badge.graduationsWitnessed(signer.address);
  console.log("   graduationsWitnessed (signer) before:", gradsBefore.toString());

  // --- 2. Single oversized buy (80k) — H-2 clamp should land at exactly 69k ---
  const bigBuy = 80_000n * SIX;
  console.log(`\n[2] Oversized buy ${fmt6(bigBuy)} $GOBLIN — clamp should land at 69,000`);
  const reserveBefore = await reserve.balanceOf(signer.address);
  const buyTx = await curve.buy(tokenId, bigBuy, 0);
  const buyRcpt = await buyTx.wait();
  const reserveAfter = await reserve.balanceOf(signer.address);
  console.log("   $GOBLIN pulled by curve:", fmt6(reserveBefore - reserveAfter));
  console.log("   progress now:", (await curve.graduationProgress(tokenId)).toString(), "bps  (10000 = graduated)");

  // Look for GraduationTriggered event
  const gradTopic = curve.interface.getEvent("GraduationTriggered").topicHash;
  const gradLog = buyRcpt.logs.find((l) => l.topics[0] === gradTopic);
  if (!gradLog) throw new Error("GraduationTriggered NOT emitted — clamp logic broken or graduation didn't trip");
  const parsedGrad = curve.interface.parseLog(gradLog);
  console.log("   ✓ GraduationTriggered emitted | tokenId:", parsedGrad.args.tokenId.toString());

  // --- 3. Confirm follow-up buys are rejected ---
  console.log("\n[3] Attempt buy on graduated token (should revert)");
  try {
    await curve.buy.staticCall(tokenId, 100n * SIX, 0);
    console.log("   ✗ buy did NOT revert — BUG");
  } catch (e) {
    const msg = (e.shortMessage || e.message || "").slice(0, 120);
    if (msg.includes("TokenAlreadyGraduated") || msg.includes("0x")) {
      console.log("   ✓ buy reverted as expected:", msg);
    } else {
      console.log("   ? buy reverted with unexpected error:", msg);
    }
  }

  // --- 4. Confirm sell ALSO reverts post-graduation (curve is closed) ---
  console.log("\n[4] Attempt sell post-grad (should revert — curve closed, auction takes over)");
  try {
    await curve.sell.staticCall(tokenId, 1n * SIX, 0);
    console.log("   ✗ sell did NOT revert — BUG");
  } catch (e) {
    const msg = (e.shortMessage || e.message || "").slice(0, 120);
    console.log("   ✓ sell reverted as expected:", msg);
  }

  // --- 4b. Owner releases auction funds to a relayer (pull-pattern) ---
  console.log("\n[4b] releaseAuctionFunds → credit relayer, then claim()");
  const releaseAmt = 10_000n * SIX; // partial release
  const relayer = signer.address; // owner == relayer for demo
  const reserveBeforeClaim = await reserve.balanceOf(signer.address);
  await (await curve.releaseAuctionFunds(tokenId, relayer, releaseAmt)).wait();
  const pending = await curve.pendingWithdrawals(relayer);
  console.log("   pendingWithdrawals[relayer]:", fmt6(pending), "$GOBLIN");
  await (await curve.claim()).wait();
  const reserveAfterClaim = await reserve.balanceOf(signer.address);
  console.log("   relayer net delta from claim:", fmt6(reserveAfterClaim - reserveBeforeClaim), "$GOBLIN");
  console.log("   pendingWithdrawals[relayer] after:", fmt6(await curve.pendingWithdrawals(relayer)));

  // --- 5. Badge stats post-graduation ---
  const gradsAfter = await badge.graduationsWitnessed(signer.address);
  const rank = await badge.getRank(signer.address);
  const trades = await badge.tradeCount(signer.address);
  console.log("\n[5] Badge post-graduation");
  console.log("   graduationsWitnessed:", gradsBefore.toString(), "->", gradsAfter.toString(), gradsAfter > gradsBefore ? "✓ bumped" : "✗ NOT bumped");
  console.log("   rank:", rank.toString(), "(0=CAVE,1=TRENCH,2=CURSED_HUNTER,3=VETERAN,4=KING,5=ANCIENT)");
  console.log("   tradeCount:", trades.toString());

  // --- 6. Oracle scores the graduated token ---
  console.log("\n[6] Oracle scoring (deployer is the oracle)");
  const scoreRcpt = await (await curve.setGoblinScore(tokenId, 85)).wait();
  const scoreTopic = curve.interface.getEvent("GoblinScoreSet").topicHash;
  const scoreLog = scoreRcpt.logs.find((l) => l.topics[0] === scoreTopic);
  if (scoreLog) {
    const p = curve.interface.parseLog(scoreLog);
    console.log("   ✓ GoblinScoreSet emitted: score =", p.args.score.toString(), "label =", p.args.label.toString(), "(0=UNSCORED,1=CURSED,2=NEUTRAL,3=BLESSED)");
  }

  // --- 7. Solvency invariant + total stats ---
  console.log("\n[7] Curve health");
  console.log("   solvencyInvariant:", await curve.solvencyInvariant() ? "✓ true" : "✗ FALSE");
  console.log("   totalReserves:", fmt6(await curve.totalReserves()));
  console.log("   accumulatedFees:", fmt6(await curve.accumulatedFees()));
  console.log("   curve $GOBLIN balance:", fmt6(await reserve.balanceOf(CURVE)));

  console.log("\nExplorer:");
  console.log("  token:   https://testnet.monadexplorer.com/address/" + tokenAddr);
  console.log("  curve:   https://testnet.monadexplorer.com/address/" + CURVE);
  console.log("  badge:   https://testnet.monadexplorer.com/address/" + BADGE);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
