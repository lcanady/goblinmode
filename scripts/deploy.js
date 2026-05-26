const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  // --- Reserve token: real USDC on mainnet (set USDC_ADDRESS), $GOBLIN mock on testnet ---
  let usdcAddr = process.env.USDC_ADDRESS;
  if (!usdcAddr || usdcAddr === "0x0000000000000000000000000000000000000000") {
    const Mock = await hre.ethers.getContractFactory("MockERC20");
    const goblin = await Mock.deploy("Goblin", "GOBLIN", 6);
    await goblin.waitForDeployment();
    usdcAddr = await goblin.getAddress();
    console.log("$GOBLIN (testnet reserve):", usdcAddr);
  } else {
    console.log("Using existing reserve token:", usdcAddr);
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
  const badgeCurve = await badge.curve();
  const accessBadge = await access.badge();
  const curveUsdc = await curve.usdc();
  const curveBadge = await curve.badge();
  const curveAccess = await curve.access();
  const curveFactory = await curve.factory();
  const factoryCurve = await factory.curve();
  console.log("badge.curve():", badgeCurve);
  console.log("access.badge():", accessBadge);
  console.log("curve.usdc():", curveUsdc);
  console.log("curve.badge():", curveBadge);
  console.log("curve.access():", curveAccess);
  console.log("curve.factory():", curveFactory);
  console.log("factory.curve():", factoryCurve);

  // --- Verification: assert linkages and solvency invariant ---
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
  function assert(cond, msg) {
    if (!cond) {
      throw new Error("Verification failed: " + msg);
    }
  }
  assert(eq(badgeCurve, curveAddr), `badge.curve() ${badgeCurve} != curve ${curveAddr}`);
  assert(eq(curveFactory, factoryAddr), `curve.factory() ${curveFactory} != factory ${factoryAddr}`);
  assert(eq(accessBadge, badgeAddr), `access.badge() ${accessBadge} != badge ${badgeAddr}`);
  assert(eq(factoryCurve, curveAddr), `factory.curve() ${factoryCurve} != curve ${curveAddr}`);
  assert(eq(curveBadge, badgeAddr), `curve.badge() ${curveBadge} != badge ${badgeAddr}`);
  assert(eq(curveAccess, accessAddr), `curve.access() ${curveAccess} != access ${accessAddr}`);
  assert(eq(curveUsdc, usdcAddr), `curve.usdc() ${curveUsdc} != usdc ${usdcAddr}`);
  const solvent = await curve.solvencyInvariant();
  assert(solvent === true, `curve.solvencyInvariant() returned ${solvent}`);
  console.log("\n✓ Wiring verified");

  console.log("\n--- Deployed addresses ---");
  console.log("USDC:               ", usdcAddr);
  console.log("GoblinBadge:        ", badgeAddr);
  console.log("GoblinAccess:       ", accessAddr);
  console.log("GoblinCurve:        ", curveAddr);
  console.log("GoblinTokenFactory: ", factoryAddr);
  console.log("Deployer/Oracle:    ", deployer.address);
  console.log("\nDeploy complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
