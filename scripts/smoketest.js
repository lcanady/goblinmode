const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Smoketest deployer:", deployer.address);

  const MAX_UINT = ethers.MaxUint256;
  const usdc = (n) => ethers.parseUnits(n.toString(), 6);

  // Deploy MockERC20 (USDC, 6 dec)
  const Mock = await ethers.getContractFactory("MockERC20");
  const usdcContract = await Mock.deploy("Mock USDC", "USDC", 6);
  await usdcContract.waitForDeployment();
  const usdcAddr = await usdcContract.getAddress();
  console.log("MockUSDC:", usdcAddr);

  // Badge
  const Badge = await ethers.getContractFactory("GoblinBadge");
  const badge = await Badge.deploy(deployer.address);
  await badge.waitForDeployment();
  const badgeAddr = await badge.getAddress();
  console.log("GoblinBadge:", badgeAddr);

  // Access(badge)
  const Access = await ethers.getContractFactory("GoblinAccess");
  const access = await Access.deploy(badgeAddr);
  await access.waitForDeployment();
  const accessAddr = await access.getAddress();
  console.log("GoblinAccess:", accessAddr);

  // Curve(usdc, badge, access, owner)
  const Curve = await ethers.getContractFactory("GoblinCurve");
  const curve = await Curve.deploy(usdcAddr, badgeAddr, accessAddr, deployer.address);
  await curve.waitForDeployment();
  const curveAddr = await curve.getAddress();
  console.log("GoblinCurve:", curveAddr);

  // Factory(curve)
  const Factory = await ethers.getContractFactory("GoblinTokenFactory");
  const factory = await Factory.deploy(curveAddr);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("GoblinTokenFactory:", factoryAddr);

  // Wire
  await (await badge.setCurve(curveAddr)).wait();
  console.log("badge.setCurve done");
  await (await curve.setFactory(factoryAddr)).wait();
  console.log("curve.setFactory done");

  // Mint deployer 200_000 USDC
  await (await usdcContract.mint(deployer.address, usdc(200_000))).wait();
  console.log("Minted 200,000 USDC to deployer");

  // Approve curve for max
  await (await usdcContract.approve(curveAddr, MAX_UINT)).wait();
  console.log("Approved curve for MAX");

  // Pre-balances
  const deployerUsdcBefore = await usdcContract.balanceOf(deployer.address);
  const curveUsdcBefore = await usdcContract.balanceOf(curveAddr);
  console.log("\n--- Launch ---");
  console.log("Deployer USDC before:", ethers.formatUnits(deployerUsdcBefore, 6));
  console.log("Curve USDC before:   ", ethers.formatUnits(curveUsdcBefore, 6));

  // Launch with 100 USDC initial buy
  const launchTx = await curve.launch("Test", "TST", "ipfs://x", usdc(100), 0);
  const launchRcpt = await launchTx.wait();

  // Parse TokenLaunched event for tokenId
  let tokenId;
  let tokenAddr;
  for (const log of launchRcpt.logs) {
    try {
      const parsed = curve.interface.parseLog(log);
      if (parsed && parsed.name === "TokenLaunched") {
        tokenId = parsed.args.tokenId;
        tokenAddr = parsed.args.token;
        break;
      }
    } catch (_) {}
  }
  console.log("tokenId:", tokenId.toString());
  console.log("token address:", tokenAddr);

  const tokenContract = await ethers.getContractAt("GoblinToken", tokenAddr);

  const afterLaunchDeployer = await usdcContract.balanceOf(deployer.address);
  const afterLaunchCurve = await usdcContract.balanceOf(curveAddr);
  const tokenBalAfterLaunch = await tokenContract.balanceOf(deployer.address);
  console.log("Deployer USDC after launch:", ethers.formatUnits(afterLaunchDeployer, 6));
  console.log("Curve USDC after launch:   ", ethers.formatUnits(afterLaunchCurve, 6));
  console.log("Deployer token bal after launch:", ethers.formatUnits(tokenBalAfterLaunch, 18));

  // Buy 5000 USDC
  console.log("\n--- Buy 5000 USDC ---");
  const buyTx = await curve.buy(tokenId, usdc(5000), 0);
  await buyTx.wait();
  const afterBuyDeployer = await usdcContract.balanceOf(deployer.address);
  const afterBuyCurve = await usdcContract.balanceOf(curveAddr);
  const tokenBalAfterBuy = await tokenContract.balanceOf(deployer.address);
  console.log("Deployer USDC after buy:", ethers.formatUnits(afterBuyDeployer, 6));
  console.log("Curve USDC after buy:   ", ethers.formatUnits(afterBuyCurve, 6));
  console.log("Deployer token bal after buy:", ethers.formatUnits(tokenBalAfterBuy, 18));
  console.log("USDC pulled (launch+buy):", ethers.formatUnits(deployerUsdcBefore - afterBuyDeployer, 6));
  console.log("Tokens received total:   ", ethers.formatUnits(tokenBalAfterBuy, 18));

  // Sell half
  const half = tokenBalAfterBuy / 2n;
  console.log("\n--- Sell half (", ethers.formatUnits(half, 18), "tokens) ---");
  // Tokens are held by curve in this design? Check approval needed.
  // The curve transfers tokensIn from msg.sender, so we must approve.
  await (await tokenContract.approve(curveAddr, MAX_UINT)).wait();
  const sellTx = await curve.sell(tokenId, half, 0);
  await sellTx.wait();
  const afterSellDeployer = await usdcContract.balanceOf(deployer.address);
  const afterSellCurve = await usdcContract.balanceOf(curveAddr);
  const tokenBalAfterSell = await tokenContract.balanceOf(deployer.address);
  console.log("Deployer USDC after sell:", ethers.formatUnits(afterSellDeployer, 6));
  console.log("Curve USDC after sell:   ", ethers.formatUnits(afterSellCurve, 6));
  console.log("Deployer token bal after sell:", ethers.formatUnits(tokenBalAfterSell, 18));
  console.log("USDC received from sell:", ethers.formatUnits(afterSellDeployer - afterBuyDeployer, 6));

  // Solvency / fees / graduation
  const solvent = await curve.solvencyInvariant();
  const accFees = await curve.accumulatedFees();
  const gradProgress = await curve.graduationProgress(tokenId);

  console.log("\n--- Final State ---");
  console.log("solvencyInvariant():", solvent);
  console.log("accumulatedFees (USDC):", ethers.formatUnits(accFees, 6));
  console.log("graduationProgress (bps?):", gradProgress.toString());
  console.log("Curve USDC final:", ethers.formatUnits(afterSellCurve, 6));
  console.log("Net USDC pulled from deployer (start - final):",
    ethers.formatUnits(deployerUsdcBefore - afterSellDeployer, 6));

  if (!solvent) {
    throw new Error("SOLVENCY INVARIANT FAILED");
  }
  console.log("\nOK: solvency invariant true, no reverts.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
