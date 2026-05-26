const hre = require("hardhat");

// E2E flow against a live deployment.
// Reads addresses from env (set after deploy.js prints them).
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

  // --- 1. Mint $GOBLIN to self ---
  const MINT_AMT = 200_000n * SIX;
  console.log("\n[1] Mint 200,000 $GOBLIN to self");
  await (await reserve.mint(signer.address, MINT_AMT)).wait();
  console.log("   bal:", fmt6(await reserve.balanceOf(signer.address)), "$GOBLIN");

  // --- 2. Approve curve ---
  console.log("\n[2] Approve curve for MAX");
  const MAX = (1n << 256n) - 1n;
  await (await reserve.approve(CURVE, MAX)).wait();

  // --- 3. Launch a token with a 500 $GOBLIN initial buy ---
  const name = "Cave Pepe";
  const symbol = "CAVPEPE";
  const meta = "ipfs://placeholder/cavpepe.json";
  const initialBuy = 500n * SIX;
  console.log(`\n[3] Launch ${symbol} with ${fmt6(initialBuy)} initial buy`);
  const tx = await curve.launch(name, symbol, meta, initialBuy, 0);
  const rcpt = await tx.wait();
  console.log("   tx:", rcpt.hash);

  // Find tokenId from event log
  const launchedTopic = curve.interface.getEvent("TokenLaunched").topicHash;
  const log = rcpt.logs.find((l) => l.topics[0] === launchedTopic);
  const parsed = curve.interface.parseLog(log);
  const tokenId = parsed.args.tokenId;
  const tokenAddr = parsed.args.token;
  console.log("   tokenId:", tokenId.toString(), "| ERC20:", tokenAddr);

  console.log("   graduationProg:", (await curve.graduationProgress(tokenId)).toString(), "bps");
  console.log("   currentPrice:  ", (await curve.currentPrice(tokenId)).toString());

  // --- 4. Quote + buy 1,000 $GOBLIN ---
  const buyAmt = 1_000n * SIX;
  console.log(`\n[4] Quote + buy ${fmt6(buyAmt)} $GOBLIN`);
  const [tokensOut, fee] = await curve.quoteBuy(tokenId, buyAmt, signer.address);
  console.log("   quote: tokensOut =", fmt18(tokensOut), "| fee =", fmt6(fee));
  await (await curve.buy(tokenId, buyAmt, 0)).wait();

  const erc20 = await hre.ethers.getContractAt("GoblinToken", tokenAddr);
  const bal = await erc20.balanceOf(signer.address);
  console.log("   token bal:", fmt18(bal));

  // --- 5. Quote + sell half ---
  const sellAmt = bal / 2n;
  console.log(`\n[5] Sell ${fmt18(sellAmt)} ${symbol}`);
  await (await erc20.approve(CURVE, MAX)).wait();
  const [usdcOut, sellFee] = await curve.quoteSell(tokenId, sellAmt, signer.address);
  console.log("   quote: usdcOut =", fmt6(usdcOut), "| fee =", fmt6(sellFee));
  await (await curve.sell(tokenId, sellAmt, 0)).wait();

  // --- 6. Final state ---
  console.log("\n[6] Final");
  console.log("   $GOBLIN bal:    ", fmt6(await reserve.balanceOf(signer.address)));
  console.log("   token bal:      ", fmt18(await erc20.balanceOf(signer.address)));
  console.log("   graduationProg: ", (await curve.graduationProgress(tokenId)).toString(), "bps");
  console.log("   accumulatedFees:", fmt6(await curve.accumulatedFees()));
  console.log("   solvent:        ", await curve.solvencyInvariant());

  // --- 7. Badge stats ---
  const rank = await badge.getRank(signer.address);
  const trades = await badge.tradeCount(signer.address);
  console.log("\n[7] Badge");
  console.log("   rank:", rank.toString(), "(0=CAVE,1=TRENCH,...)");
  console.log("   trades:", trades.toString());

  console.log("\nExplorer:");
  console.log("  token:  https://testnet.monadexplorer.com/address/" + tokenAddr);
  console.log("  signer: https://testnet.monadexplorer.com/address/" + signer.address);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
