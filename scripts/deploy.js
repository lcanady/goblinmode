const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  // --- USDC: use env override on testnet, deploy mock locally ---
  let usdcAddr = process.env.USDC_ADDRESS;
  if (!usdcAddr || usdcAddr === "0x0000000000000000000000000000000000000000") {
    const Mock = await hre.ethers.getContractFactory("MockERC20");
    const usdc = await Mock.deploy("Mock USDC", "USDC", 6);
    await usdc.waitForDeployment();
    usdcAddr = await usdc.getAddress();
    console.log("MockUSDC:", usdcAddr);
  } else {
    console.log("Using existing USDC:", usdcAddr);
  }

  // --- Badge (owner = deployer) ---
  const Badge = await hre.ethers.getContractFactory("GoblinBadge");
  const badge = await Badge.deploy(deployer.address);
  await badge.waitForDeployment();
  const badgeAddr = await badge.getAddress();
  console.log("GoblinBadge:", badgeAddr);

  // --- Access (reads badge) ---
  const Access = await hre.ethers.getContractFactory("GoblinAccess");
  const access = await Access.deploy(badgeAddr);
  await access.waitForDeployment();
  const accessAddr = await access.getAddress();
  console.log("GoblinAccess:", accessAddr);

  // --- Curve (usdc, badge, access, owner) ---
  const Curve = await hre.ethers.getContractFactory("GoblinCurve");
  const curve = await Curve.deploy(usdcAddr, badgeAddr, accessAddr, deployer.address);
  await curve.waitForDeployment();
  const curveAddr = await curve.getAddress();
  console.log("GoblinCurve:", curveAddr);

  // --- Bind badge to curve (one-shot) ---
  await (await badge.setCurve(curveAddr)).wait();
  console.log("Badge bound to curve");

  // --- Factory (knows curve) ---
  const Factory = await hre.ethers.getContractFactory("GoblinTokenFactory");
  const factory = await Factory.deploy(curveAddr);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("GoblinTokenFactory:", factoryAddr);

  // --- Wire curve -> factory (one-shot) ---
  await (await curve.setFactory(factoryAddr)).wait();
  console.log("Curve bound to factory");

  // --- Sanity reads ---
  console.log("\n--- Linkage check ---");
  console.log("badge.curve():", await badge.curve());
  console.log("access.badge():", await access.badge());
  console.log("curve.usdc():", await curve.usdc());
  console.log("curve.badge():", await curve.badge());
  console.log("curve.access():", await curve.access());
  console.log("curve.factory():", await curve.factory());
  console.log("factory.curve():", await factory.curve());
  console.log("\nDeploy complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
