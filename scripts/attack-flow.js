/*
 * Live PvP attack flow on Monad testnet against the fresh deployment.
 * Resilient/restartable: skips steps that already completed.
 *
 *   ATTACKER = deployer (from .env)
 *   TARGET   = freshly generated burner wallet (hardcoded below)
 */

const hre = require("hardhat");
const { ethers } = hre;

const ADDR = {
  GOBLIN:  "0x3EAdAd0Ac866e2dBEfefBe23807509E2bc5fFacA",
  BADGE:   "0x736A5aaa238d6d279a3c22D4F6018748C23c9887",
  ACCESS:  "0xE210a128B1fb01EBe7009A8749D92c9d117870bF",
  CURVE:   "0x9f0fAbd89274e701379836329D9c99fCa6C6D75B",
  FACTORY: "0x5f63ef0e407c17C3Fb1a8C0e682a0a128487f53a",
  ITEM:    "0x7B7DAA5EcC8BD20400D59569234B42373A91251c",
  QUEST:   "0xaF367Acd5C05976751c24381E1DC6dA7f83Cf887",
  PVP:     "0x130f9ea294F1218590d828bEd8b2a97c51CB7493",
};
const EXPLORER = "https://testnet.monadexplorer.com/tx/";

// Pre-generated burner target:
const TARGET_PK   = "0xda3dcc60f8957f0597ebc7702f3e67c7087759f958537128c8d1533ac6db7eb0";
const TARGET_ADDR = "0x977aAE0A22C58033FD2DcDDdeEbc3E47361d1B85";

const MAX_UINT = ethers.MaxUint256;
const g = (n) => ethers.parseUnits(n.toString(), 6);

const ET = {
  ANY_TRADE: 0, SURVIVE_RUG: 1, EARLY_BUY: 2, PVP_WIN: 3,
  WITNESS_GRADUATION_3: 4, KING_KILL: 5, SURVIVE_FIVE_RUGS: 6,
};
const RARITY = ["Trash", "Busted", "Cursed", "Legendary"];
const ITEM_TYPE = ["Weapon", "Armor"];
const decodeId = (id) => ({ type: Number(id) >> 8, rarity: Number(id) & 0xff });
const idStr = (id) => {
  const d = decodeId(id);
  return `id=${id} (${ITEM_TYPE[d.type]} / ${RARITY[d.rarity]})`;
};
const rb32 = () => ethers.hexlify(ethers.randomBytes(32));

async function waitOneBlock(provider, signer) {
  const start = await provider.getBlockNumber();
  const tx = await signer.sendTransaction({ to: signer.address, value: 0n });
  await tx.wait();
  for (let i = 0; i < 20; i++) {
    const n = await provider.getBlockNumber();
    if (n > start) return n;
    await new Promise(r => setTimeout(r, 500));
  }
  return await provider.getBlockNumber();
}

async function questDropRound({ quest, oracleSigner, attackerSigner, recipient, eventType, wantType, retries = 3 }) {
  let lastItemId = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const seed = rb32(), salt = rb32();
    const commitHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [seed, salt])
    );
    console.log(`  [quest attempt ${attempt}] event=${Object.keys(ET).find(k=>ET[k]===eventType)}`);
    let triggerRcpt;
    try {
      const tx = await quest.connect(oracleSigner).triggerDrop(recipient, eventType, commitHash);
      triggerRcpt = await tx.wait();
    } catch (e) {
      console.log(`    triggerDrop reverted: ${e.shortMessage || e.message}`);
      eventType = (eventType + 1) % 7;
      continue;
    }
    let dropId;
    for (const log of triggerRcpt.logs) {
      try { const p = quest.interface.parseLog(log); if (p?.name === "DropTriggered") { dropId = p.args.dropId; break; } } catch (_) {}
    }
    console.log(`    dropId=${dropId} tx=${EXPLORER}${triggerRcpt.hash}`);
    await waitOneBlock(attackerSigner.provider, attackerSigner);
    let revealRcpt;
    try {
      const tx = await quest.connect(oracleSigner).revealDrop(dropId, seed, salt);
      revealRcpt = await tx.wait();
    } catch (e) {
      console.log(`    revealDrop reverted: ${e.shortMessage || e.message}`);
      continue;
    }
    let mintedId, mintedType, mintedRarity;
    for (const log of revealRcpt.logs) {
      try {
        const p = quest.interface.parseLog(log);
        if (p?.name === "DropRevealed") {
          mintedId = p.args.itemId;
          mintedType = Number(p.args.itemType);
          mintedRarity = Number(p.args.rarity);
          break;
        }
      } catch (_) {}
    }
    lastItemId = mintedId;
    console.log(`    minted ${idStr(mintedId)} tx=${EXPLORER}${revealRcpt.hash}`);
    if (mintedType === wantType) return { itemId: mintedId, rarity: mintedRarity, type: mintedType };
    console.log(`    wanted ${ITEM_TYPE[wantType]}, got ${ITEM_TYPE[mintedType]} — retrying with different eventType`);
    eventType = (eventType + 1) % 7;
  }
  return { itemId: lastItemId, exhausted: true };
}

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz");
  const attacker = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const target = new ethers.Wallet(TARGET_PK, provider);
  if (target.address.toLowerCase() !== TARGET_ADDR.toLowerCase()) {
    throw new Error("target address mismatch");
  }

  console.log("================ WALLETS ================");
  console.log("Attacker (deployer):", attacker.address);
  console.log("Target  (burner):   ", target.address);
  console.log("Target PK:          ", target.privateKey);

  const goblin = await ethers.getContractAt("MockERC20", ADDR.GOBLIN, attacker);
  const badge  = await ethers.getContractAt("GoblinBadge", ADDR.BADGE, attacker);
  const curve  = await ethers.getContractAt("GoblinCurve", ADDR.CURVE, attacker);
  const item   = await ethers.getContractAt("GoblinItem", ADDR.ITEM, attacker);
  const quest  = await ethers.getContractAt("GoblinQuest", ADDR.QUEST, attacker);
  const pvp    = await ethers.getContractAt("GoblinPvP", ADDR.PVP, attacker);

  // ---- Funding (skip if already funded) ----
  const tgtMon = await provider.getBalance(target.address);
  console.log(`\nTarget MON: ${ethers.formatEther(tgtMon)}`);
  if (tgtMon < ethers.parseEther("0.01")) {
    console.log("Funding target with 0.05 MON…");
    const ft = await attacker.sendTransaction({ to: target.address, value: ethers.parseEther("0.05") });
    await ft.wait();
    console.log(`  tx=${EXPLORER}${ft.hash}`);
  } else {
    console.log("Target already funded.");
  }

  // ---- Mint $GOBLIN (skip if balances already adequate) ----
  const NEEDED = g(1_000);
  if ((await goblin.balanceOf(attacker.address)) < NEEDED) {
    console.log("Minting 5,000 GOBLIN to attacker…");
    await (await goblin.mint(attacker.address, g(5_000))).wait();
  } else { console.log("Attacker has GOBLIN already."); }
  if ((await goblin.balanceOf(target.address)) < NEEDED) {
    console.log("Minting 5,000 GOBLIN to target…");
    await (await goblin.mint(target.address, g(5_000))).wait();
  } else { console.log("Target has GOBLIN already."); }

  // ---- Approve curve (skip if already approved) ----
  const HALF = ethers.MaxUint256 >> 1n;
  if ((await goblin.allowance(attacker.address, ADDR.CURVE)) < HALF) {
    console.log("Approve curve MAX (attacker)…");
    await (await goblin.connect(attacker).approve(ADDR.CURVE, MAX_UINT)).wait();
  }
  if ((await goblin.allowance(target.address, ADDR.CURVE)) < HALF) {
    console.log("Approve curve MAX (target)…");
    await (await goblin.connect(target).approve(ADDR.CURVE, MAX_UINT)).wait();
  }

  // ---- Drive attacker to TRENCH ----
  let rank = Number(await badge.getRank(attacker.address));
  let trades = Number(await badge.tradeCount(attacker.address));
  console.log(`\nAttacker rank=${rank} trades=${trades}`);

  if (rank < 1) {
    // Need to reach tokenId. If tokenId 1 exists from prior run, reuse it. Otherwise launch.
    // We attempt to read tokens(1).
    let tokenId = 1n;
    let tokenState;
    try { tokenState = await curve.tokens(tokenId); } catch (_) {}
    if (!tokenState || tokenState.token === ethers.ZeroAddress) {
      console.log("Launching token with 30 GOBLIN initial buy…");
      const tx = await curve.connect(attacker).launch("AtkTok", "ATK", "ipfs://atk", g(30), 0);
      const rcpt = await tx.wait();
      for (const log of rcpt.logs) {
        try { const p = curve.interface.parseLog(log); if (p?.name === "TokenLaunched") { tokenId = p.args.tokenId; break; } } catch (_) {}
      }
      console.log(`  launched tokenId=${tokenId} tx=${EXPLORER}${tx.hash}`);
      trades = Number(await badge.tradeCount(attacker.address));
    } else {
      console.log(`Reusing existing tokenId=${tokenId} (token=${tokenState.token})`);
    }

    // Do more buys to reach >=5 trades.
    while (trades < 5) {
      console.log(`  buy 15 GOBLIN to push trades from ${trades}…`);
      const tx = await curve.connect(attacker).buy(tokenId, g(15), 0);
      const r = await tx.wait();
      console.log(`    tx=${EXPLORER}${r.hash}`);
      trades = Number(await badge.tradeCount(attacker.address));
    }
    rank = Number(await badge.getRank(attacker.address));
    console.log(`  attacker now rank=${rank} trades=${trades}`);
  } else {
    console.log("Attacker already at TRENCH+.");
  }
  if (rank < 1) throw new Error(`Attacker rank still ${rank}; cannot attack.`);

  // ---- Mint attacker a Weapon (skip if already has one) ----
  let weaponId = null;
  for (let r = 3; r >= 0; r--) {
    const id = (0 << 8) | r;
    if ((await item.balanceOf(attacker.address, id)) > 0n) { weaponId = id; break; }
  }
  if (weaponId === null) {
    console.log("\nQuesting a Weapon for attacker…");
    await questDropRound({ quest, oracleSigner: attacker, attackerSigner: attacker, recipient: attacker.address, eventType: ET.PVP_WIN, wantType: 0, retries: 3 });
    for (let r = 3; r >= 0; r--) {
      const id = (0 << 8) | r;
      if ((await item.balanceOf(attacker.address, id)) > 0n) { weaponId = id; break; }
    }
  } else {
    console.log(`\nAttacker already has weapon ${idStr(weaponId)}.`);
  }

  // ---- Mint target an Armor (skip if already has one) ----
  let armorId = null;
  for (let r = 3; r >= 0; r--) {
    const id = (1 << 8) | r;
    if ((await item.balanceOf(target.address, id)) > 0n) { armorId = id; break; }
  }
  if (armorId === null) {
    console.log("\nQuesting an Armor for target…");
    await questDropRound({ quest, oracleSigner: attacker, attackerSigner: attacker, recipient: target.address, eventType: ET.PVP_WIN, wantType: 1, retries: 3 });
    for (let r = 3; r >= 0; r--) {
      const id = (1 << 8) | r;
      if ((await item.balanceOf(target.address, id)) > 0n) { armorId = id; break; }
    }
  } else {
    console.log(`\nTarget already has armor ${idStr(armorId)}.`);
  }

  if (weaponId === null) throw new Error("Attacker has no weapon; cannot attack.");

  // ---- Item approvals ----
  if (!(await item.isApprovedForAll(attacker.address, ADDR.PVP))) {
    console.log("\nApproving PvP as operator (attacker)…");
    await (await item.connect(attacker).setApprovalForAll(ADDR.PVP, true)).wait();
  }
  if (armorId !== null && !(await item.isApprovedForAll(target.address, ADDR.PVP))) {
    console.log("Approving PvP as operator (target)…");
    await (await item.connect(target).setApprovalForAll(ADDR.PVP, true)).wait();
  }

  // ---- ATTACK ----
  console.log("\n>>> ATTACK <<<");
  const attackTx = await pvp.connect(attacker).attack(target.address, weaponId);
  const attackRcpt = await attackTx.wait();
  let launchedRot, launchedRar;
  for (const log of attackRcpt.logs) {
    try {
      const p = pvp.interface.parseLog(log);
      if (p?.name === "AttackLaunched") { launchedRot = Number(p.args.rotBps); launchedRar = Number(p.args.weaponRarity); }
    } catch (_) {}
  }
  console.log(`  weapon ${idStr(weaponId)} -> rotBps=${launchedRot} (${launchedRot/100}%)`);
  console.log(`  tx=${EXPLORER}${attackTx.hash}`);

  // ---- DEFEND ----
  let effectiveRot = null, reflected = null, armorRarEv = null;
  if (armorId !== null) {
    console.log("\n>>> DEFEND <<<");
    const defendTx = await pvp.connect(target).defend(armorId);
    const defendRcpt = await defendTx.wait();
    for (const log of defendRcpt.logs) {
      try {
        const p = pvp.interface.parseLog(log);
        if (p?.name === "AttackBlocked") { armorRarEv = Number(p.args.armorRarity); reflected = Number(p.args.reflectedBps); }
        if (p?.name === "AttackLanded")  { effectiveRot = Number(p.args.rotBps); }
      } catch (_) {}
    }
    console.log(`  armor ${idStr(armorId)}`);
    console.log(`  effective rot on target: ${effectiveRot} (${effectiveRot/100}%)`);
    console.log(`  reflected to attacker:   ${reflected} (${reflected/100}%)`);
    console.log(`  tx=${EXPLORER}${defendTx.hash}`);
  } else {
    console.log("\nTarget has no armor; skipping defend.");
  }

  // ---- Verify ----
  const epoch = await pvp.currentEpoch();
  const tRot = await pvp.epochRotBps(epoch, target.address);
  const aRot = await pvp.epochRotBps(epoch, attacker.address);
  const mult = await pvp.getRotMultiplierBps(target.address);
  const tRank = await badge.getRank(target.address);

  console.log("\n================ STATE ================");
  console.log(`epoch:                       ${epoch}`);
  console.log(`epochRotBps[target]:         ${tRot} (${Number(tRot)/100}%)`);
  console.log(`epochRotBps[attacker]:       ${aRot} (${Number(aRot)/100}%)`);
  console.log(`getRotMultiplierBps(target): ${mult}`);
  console.log(`badge.getRank(target):       ${tRank}`);

  console.log("\n================ SUMMARY ================");
  console.log(`Attacker:        ${attacker.address}`);
  console.log(`Target:          ${target.address}`);
  console.log(`Target PK:       ${target.privateKey}  (BURNER)`);
  console.log(`Weapon rolled:   ${weaponId === null ? "NONE" : idStr(weaponId)}`);
  console.log(`Armor  rolled:   ${armorId  === null ? "NONE" : idStr(armorId)}`);
  console.log(`Attack rotBps:   ${launchedRot}`);
  console.log(`Effective rot:   ${effectiveRot ?? "n/a"}`);
  console.log(`Reflected:       ${reflected ?? "n/a"}`);
  console.log(`Target final rank: ${tRank}`);
}

main().catch((e) => { console.error("\n!!! FAILURE !!!"); console.error(e); process.exit(1); });
