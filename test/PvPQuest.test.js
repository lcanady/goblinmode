const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = (n) => ethers.parseUnits(n.toString(), 6);

// Item type/rarity enums (mirror Solidity)
const TYPE = { Weapon: 0, Armor: 1 };
const RARITY = { Trash: 0, Busted: 1, Cursed: 2, Legendary: 3 };
const makeItemId = (t, r) => (BigInt(t) << 8n) | BigInt(r);

// EventType
const ET = {
  ANY_TRADE: 0,
  SURVIVE_RUG: 1,
  EARLY_BUY: 2,
  PVP_WIN: 3,
  WITNESS_GRADUATION_3: 4,
  KING_KILL: 5,
  SURVIVE_FIVE_RUGS: 6,
};

async function deployAll() {
  const [owner, oracle, alice, bob, carol, dave, eve, frank, gina, harry, ivy, jack, kate] =
    await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockERC20");
  const usdc = await Mock.deploy("USDC", "USDC", 6);

  const Badge = await ethers.getContractFactory("GoblinBadge");
  const badge = await Badge.deploy(owner.address);

  const Access = await ethers.getContractFactory("GoblinAccess");
  const access = await Access.deploy(await badge.getAddress());

  const Curve = await ethers.getContractFactory("GoblinCurve");
  const curve = await Curve.deploy(
    await usdc.getAddress(),
    await badge.getAddress(),
    await access.getAddress(),
    owner.address
  );

  await badge.setCurve(await curve.getAddress());

  const Factory = await ethers.getContractFactory("GoblinTokenFactory");
  const factory = await Factory.deploy(await curve.getAddress());
  await curve.setFactory(await factory.getAddress());
  await curve.setOracle(oracle.address);

  const Item = await ethers.getContractFactory("GoblinItem");
  const item = await Item.deploy(owner.address);

  const Quest = await ethers.getContractFactory("GoblinQuest");
  const quest = await Quest.deploy(await item.getAddress(), owner.address);

  const PvP = await ethers.getContractFactory("GoblinPvP");
  const pvp = await PvP.deploy(
    await badge.getAddress(),
    await item.getAddress(),
    await access.getAddress(),
    await quest.getAddress(),
    owner.address
  );

  await item.addMinter(await quest.getAddress());
  await item.addMinter(await pvp.getAddress());
  await badge.setPvP(await pvp.getAddress());
  await curve.setPvP(await pvp.getAddress());
  await quest.addOracle(oracle.address);
  await quest.addAutoTrigger(await pvp.getAddress());

  // Fund traders
  const wallets = [alice, bob, carol, dave, eve, frank, gina, harry, ivy, jack, kate];
  for (const w of wallets) {
    await usdc.mint(w.address, USDC(10_000_000));
    await usdc.connect(w).approve(await curve.getAddress(), ethers.MaxUint256);
  }

  return {
    owner, oracle, alice, bob, carol, dave, eve, frank, gina, harry, ivy, jack, kate,
    usdc, badge, access, curve, factory, item, quest, pvp,
  };
}

// Promote a wallet to TRENCH (5 trades, >=100 USDC volume).
async function toTrench(f, wallet) {
  await f.curve.connect(f.alice).launch("T", "T", "ipfs://", 0, 0);
  const id = (await f.curve.nextTokenId()) - 1n;
  for (let i = 0; i < 5; i++) {
    await f.curve.connect(wallet).buy(id, USDC(50), 0);
  }
  return id;
}

// Force-mint an item directly for tests using a minter wallet.
async function mintItem(f, to, type, rarity, amount = 1) {
  // Add owner as a minter for direct test minting then remove? Simplest: use Quest's
  // owner-only autoTriggerDrop path? No — easiest is to add the owner as a minter.
  await f.item.connect(f.owner).addMinter(f.owner.address);
  const id = makeItemId(type, rarity);
  await f.item.connect(f.owner).mint(to, id, amount);
  await f.item.connect(f.owner).removeMinter(f.owner.address);
  return id;
}

describe("GoblinItem - basics", function () {
  it("only minters can mint, holders can burn or operator after approval", async () => {
    const f = await deployAll();
    const id = makeItemId(TYPE.Weapon, RARITY.Trash);
    // unauthorized mint reverts
    await expect(f.item.connect(f.bob).mint(f.bob.address, id, 1))
      .to.be.revertedWithCustomError(f.item, "NotMinter");
    // owner adds bob as minter; bob can mint
    await f.item.connect(f.owner).addMinter(f.bob.address);
    await f.item.connect(f.bob).mint(f.carol.address, id, 5);
    expect(await f.item.balanceOf(f.carol.address, id)).to.equal(5);

    // burn by holder
    await f.item.connect(f.carol).burn(f.carol.address, id, 2);
    expect(await f.item.balanceOf(f.carol.address, id)).to.equal(3);

    // unauthorized burn
    await expect(f.item.connect(f.dave).burn(f.carol.address, id, 1))
      .to.be.revertedWithCustomError(f.item, "NotAuthorized");

    // operator can burn after approval
    await f.item.connect(f.carol).setApprovalForAll(f.dave.address, true);
    await f.item.connect(f.dave).burn(f.carol.address, id, 1);
    expect(await f.item.balanceOf(f.carol.address, id)).to.equal(2);
  });

  it("transfers and tracks balances", async () => {
    const f = await deployAll();
    await f.item.connect(f.owner).addMinter(f.owner.address);
    const id = makeItemId(TYPE.Armor, RARITY.Cursed);
    await f.item.connect(f.owner).mint(f.alice.address, id, 3);
    await f.item.connect(f.alice).safeTransferFrom(f.alice.address, f.bob.address, id, 1, "0x");
    expect(await f.item.balanceOf(f.alice.address, id)).to.equal(2);
    expect(await f.item.balanceOf(f.bob.address, id)).to.equal(1);
  });
});

describe("GoblinQuest - commit-reveal", function () {
  it("oracle commits then reveals; correct seed mints item", async () => {
    const f = await deployAll();
    const seed = ethers.keccak256(ethers.toUtf8Bytes("seed1"));
    const salt = ethers.keccak256(ethers.toUtf8Bytes("salt1"));
    const commitHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [seed, salt])
    );
    const tx = await f.quest.connect(f.oracle).triggerDrop(f.bob.address, ET.ANY_TRADE, commitHash);
    await tx.wait();
    const dropId = (await f.quest.nextDropId()) - 1n;

    // Mine a couple of blocks so blockhash(commitBlock) is defined.
    await ethers.provider.send("evm_mine", []);
    await ethers.provider.send("evm_mine", []);

    await expect(f.quest.connect(f.oracle).revealDrop(dropId, seed, salt))
      .to.emit(f.quest, "DropRevealed");
  });

  it("wrong reveal reverts", async () => {
    const f = await deployAll();
    const seed = ethers.keccak256(ethers.toUtf8Bytes("seed"));
    const salt = ethers.keccak256(ethers.toUtf8Bytes("salt"));
    const commitHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [seed, salt])
    );
    await f.quest.connect(f.oracle).triggerDrop(f.bob.address, ET.ANY_TRADE, commitHash);
    const dropId = (await f.quest.nextDropId()) - 1n;
    await ethers.provider.send("evm_mine", []);
    const badSeed = ethers.keccak256(ethers.toUtf8Bytes("wrong"));
    await expect(f.quest.connect(f.oracle).revealDrop(dropId, badSeed, salt))
      .to.be.revertedWithCustomError(f.quest, "BadReveal");
  });

  it("late reveal expires the drop", async () => {
    const f = await deployAll();
    const seed = ethers.keccak256(ethers.toUtf8Bytes("s"));
    const salt = ethers.keccak256(ethers.toUtf8Bytes("t"));
    const commitHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [seed, salt])
    );
    await f.quest.connect(f.oracle).triggerDrop(f.bob.address, ET.ANY_TRADE, commitHash);
    const dropId = (await f.quest.nextDropId()) - 1n;
    // Mine > 256 blocks
    await hre_mineBlocks(258);
    await expect(f.quest.connect(f.oracle).revealDrop(dropId, seed, salt))
      .to.be.revertedWithCustomError(f.quest, "RevealWindowClosed");
    await expect(f.quest.expireDrop(dropId)).to.emit(f.quest, "DropExpired");
  });

  it("cooldown: same wallet+eventType in same epoch reverts", async () => {
    const f = await deployAll();
    const seed = ethers.keccak256(ethers.toUtf8Bytes("a"));
    const salt = ethers.keccak256(ethers.toUtf8Bytes("b"));
    const commitHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [seed, salt])
    );
    await f.quest.connect(f.oracle).triggerDrop(f.bob.address, ET.ANY_TRADE, commitHash);
    await expect(f.quest.connect(f.oracle).triggerDrop(f.bob.address, ET.ANY_TRADE, commitHash))
      .to.be.revertedWithCustomError(f.quest, "CooldownActive");
    // Different event type same wallet should succeed.
    await f.quest.connect(f.oracle).triggerDrop(f.bob.address, ET.SURVIVE_RUG, commitHash);
  });

  it("rarity distribution (smaller sample): ANY_TRADE is overwhelmingly Trash", async () => {
    const f = await deployAll();
    // Use autoTriggerDrop for speed (no commit-reveal). Add bob as autoTrigger via owner.
    await f.quest.connect(f.owner).addAutoTrigger(f.bob.address);
    const N = 500;
    let counts = [0, 0, 0, 0];
    for (let i = 0; i < N; i++) {
      // Each call must be in a new epoch — fast-forward 3601 between calls.
      await ethers.provider.send("evm_increaseTime", [3601]);
      const tx = await f.quest.connect(f.bob).autoTriggerDrop(f.carol.address, ET.ANY_TRADE);
      const rc = await tx.wait();
      // Parse DropRevealed
      for (const log of rc.logs) {
        try {
          const parsed = f.quest.interface.parseLog(log);
          if (parsed && parsed.name === "DropRevealed") {
            counts[Number(parsed.args.rarity)]++;
          }
        } catch (_) {}
      }
    }
    // 90% trash expected; allow ±10% slack at N=500.
    expect(counts[RARITY.Trash]).to.be.gt(N * 0.8);
    expect(counts[RARITY.Legendary]).to.equal(0);
  }).timeout(120000);
});

describe("GoblinPvP - attack flow", function () {
  it("CAVE wallet cannot attack", async () => {
    const f = await deployAll();
    // bob never traded → CAVE.
    const weaponId = await mintItem(f, f.bob.address, TYPE.Weapon, RARITY.Trash);
    await f.item.connect(f.bob).setApprovalForAll(await f.pvp.getAddress(), true);
    await expect(f.pvp.connect(f.bob).attack(f.carol.address, weaponId))
      .to.be.revertedWithCustomError(f.pvp, "NotEnoughRank");
  });

  it("TRENCH wallet attacks with Trash weapon, no defense → rot 2500 locked at epoch", async () => {
    const f = await deployAll();
    await toTrench(f, f.bob);
    expect(await f.badge.getRank(f.bob.address)).to.equal(1); // TRENCH
    const weaponId = await mintItem(f, f.bob.address, TYPE.Weapon, RARITY.Trash);
    await f.item.connect(f.bob).setApprovalForAll(await f.pvp.getAddress(), true);

    await expect(f.pvp.connect(f.bob).attack(f.carol.address, weaponId))
      .to.emit(f.pvp, "AttackLaunched");

    // Defend window: pass 301s.
    await ethers.provider.send("evm_increaseTime", [301]);
    await ethers.provider.send("evm_mine", []);
    await f.pvp.connect(f.bob).resolveAttack(f.carol.address);

    const epoch = await f.pvp.currentEpoch();
    expect(await f.pvp.epochRotBps(epoch, f.carol.address)).to.equal(2500);
    expect(await f.pvp.getRotMultiplierBps(f.carol.address)).to.equal(7500);
  });

  it("stacking same target before resolution reverts", async () => {
    const f = await deployAll();
    await toTrench(f, f.bob);
    await toTrench(f, f.dave);
    const w1 = await mintItem(f, f.bob.address, TYPE.Weapon, RARITY.Trash);
    const w2 = await mintItem(f, f.dave.address, TYPE.Weapon, RARITY.Trash);
    await f.item.connect(f.bob).setApprovalForAll(await f.pvp.getAddress(), true);
    await f.item.connect(f.dave).setApprovalForAll(await f.pvp.getAddress(), true);
    await f.pvp.connect(f.bob).attack(f.carol.address, w1);
    await expect(f.pvp.connect(f.dave).attack(f.carol.address, w2))
      .to.be.revertedWithCustomError(f.pvp, "AttackInProgress");
  });

  it("attacker cooldown blocks rapid re-attack", async () => {
    const f = await deployAll();
    await toTrench(f, f.bob);
    const w1 = await mintItem(f, f.bob.address, TYPE.Weapon, RARITY.Trash);
    const w2 = await mintItem(f, f.bob.address, TYPE.Weapon, RARITY.Trash);
    await f.item.connect(f.bob).setApprovalForAll(await f.pvp.getAddress(), true);
    await f.pvp.connect(f.bob).attack(f.carol.address, w1);
    await expect(f.pvp.connect(f.bob).attack(f.eve.address, w2))
      .to.be.revertedWithCustomError(f.pvp, "AttackerOnCooldown");
  });

  it("non-weapon item rejected", async () => {
    const f = await deployAll();
    await toTrench(f, f.bob);
    const armorId = await mintItem(f, f.bob.address, TYPE.Armor, RARITY.Trash);
    await f.item.connect(f.bob).setApprovalForAll(await f.pvp.getAddress(), true);
    await expect(f.pvp.connect(f.bob).attack(f.carol.address, armorId))
      .to.be.revertedWithCustomError(f.pvp, "NotWeapon");
  });
});

describe("GoblinPvP - defense matrix", function () {
  // Run all 16 weapon x armor combinations. For each, verify the final rot delivered
  // to the target equals weapon_rot * (1 - block_fraction) and reflected = weapon_rot * reflect.
  const weaponRot = [2500, 5000, 7500, 9000];
  const armorBlock = [2500, 5000, 7500, 10000];
  const armorReflect = [0, 0, 0, 2500];

  for (let w = 0; w < 4; w++) {
    for (let a = 0; a < 4; a++) {
      it(`weapon=${w} vs armor=${a}: rot ${weaponRot[w]} bps & block ${armorBlock[a]} bps`, async () => {
        const f = await deployAll();
        await toTrench(f, f.bob);
        await toTrench(f, f.carol);
        const wid = await mintItem(f, f.bob.address, TYPE.Weapon, w);
        const aid = await mintItem(f, f.carol.address, TYPE.Armor, a);
        await f.item.connect(f.bob).setApprovalForAll(await f.pvp.getAddress(), true);
        await f.item.connect(f.carol).setApprovalForAll(await f.pvp.getAddress(), true);
        await f.pvp.connect(f.bob).attack(f.carol.address, wid);
        await f.pvp.connect(f.carol).defend(aid);

        const epoch = await f.pvp.currentEpoch();
        const expectedTargetRot = Math.floor(weaponRot[w] * (10000 - armorBlock[a]) / 10000);
        const expectedAttackerRot = Math.floor(weaponRot[w] * armorReflect[a] / 10000);
        expect(await f.pvp.epochRotBps(epoch, f.carol.address)).to.equal(BigInt(expectedTargetRot));
        expect(await f.pvp.epochRotBps(epoch, f.bob.address)).to.equal(BigInt(expectedAttackerRot));
      });
    }
  }
});

describe("GoblinPvP - killing blow demotes target", function () {
  it("stacked rot >= 10000 demotes target and grants KING_KILL drop to attacker", async () => {
    const f = await deployAll();
    // Make carol VETERAN (not CAVE/ANCIENT) so demote works.
    await toTrench(f, f.carol);
    expect(await f.badge.getRank(f.carol.address)).to.equal(1); // TRENCH

    // Two TRENCH attackers, both with Legendary weapons (9000 rot each → cap at 10000).
    await toTrench(f, f.bob);
    await toTrench(f, f.dave);

    const w1 = await mintItem(f, f.bob.address, TYPE.Weapon, RARITY.Legendary);
    const w2 = await mintItem(f, f.dave.address, TYPE.Weapon, RARITY.Legendary);
    await f.item.connect(f.bob).setApprovalForAll(await f.pvp.getAddress(), true);
    await f.item.connect(f.dave).setApprovalForAll(await f.pvp.getAddress(), true);

    // First attack lands.
    await f.pvp.connect(f.bob).attack(f.carol.address, w1);
    await ethers.provider.send("evm_increaseTime", [301]);
    await ethers.provider.send("evm_mine", []);
    await f.pvp.connect(f.bob).resolveAttack(f.carol.address);
    const epoch = await f.pvp.currentEpoch();
    expect(await f.pvp.epochRotBps(epoch, f.carol.address)).to.equal(9000);
    // Carol still TRENCH.
    expect(await f.badge.getRank(f.carol.address)).to.equal(1);

    // Second attack from dave; rot caps at 10000 → killing blow.
    await f.pvp.connect(f.dave).attack(f.carol.address, w2);
    await ethers.provider.send("evm_increaseTime", [301]);
    await ethers.provider.send("evm_mine", []);
    await expect(f.pvp.connect(f.dave).resolveAttack(f.carol.address))
      .to.emit(f.pvp, "RankDropped");
    // Carol demoted TRENCH -> CAVE.
    expect(await f.badge.getRank(f.carol.address)).to.equal(0);

    // Dave should have received a KING_KILL drop (some item).
    // We can't predict id; just check at least one balance is nonzero across the 8 ids.
    let total = 0n;
    for (let t = 0; t < 2; t++) {
      for (let r = 0; r < 4; r++) {
        total += await f.item.balanceOf(f.dave.address, makeItemId(t, r));
      }
    }
    expect(total).to.be.gte(1n);
  });
});

describe("Curve integration: rot scales progression", function () {
  it("rotted wallet earns reduced lifetime volume during the rotted epoch, normal after", async () => {
    const f = await deployAll();
    await toTrench(f, f.carol); // target
    await toTrench(f, f.bob);   // attacker
    // Launch a token to trade.
    await f.curve.connect(f.alice).launch("V", "VOL", "ipfs://", 0, 0);
    const id = (await f.curve.nextTokenId()) - 1n;

    // Hit carol with Legendary (9000 rot), no defense, resolve.
    const wid = await mintItem(f, f.bob.address, TYPE.Weapon, RARITY.Legendary);
    await f.item.connect(f.bob).setApprovalForAll(await f.pvp.getAddress(), true);
    await f.pvp.connect(f.bob).attack(f.carol.address, wid);
    await ethers.provider.send("evm_increaseTime", [301]);
    await ethers.provider.send("evm_mine", []);
    await f.pvp.connect(f.bob).resolveAttack(f.carol.address);

    const volBefore = await f.curve.lifetimeUSDCVolume(f.carol.address);
    // Carol trades 1000 USDC during the rotted epoch.
    await f.curve.connect(f.carol).buy(id, USDC(1000), 0);
    const volAfter = await f.curve.lifetimeUSDCVolume(f.carol.address);
    const credited = volAfter - volBefore;
    // Expected ~10% of 990 (after fee) ≈ 99.
    expect(credited).to.be.lt(USDC(200));
    expect(credited).to.be.gt(0n);

    // Advance an epoch and trade again.
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    const volNext = await f.curve.lifetimeUSDCVolume(f.carol.address);
    await f.curve.connect(f.carol).buy(id, USDC(1000), 0);
    const volNextAfter = await f.curve.lifetimeUSDCVolume(f.carol.address);
    const creditedNext = volNextAfter - volNext;
    expect(creditedNext).to.be.gt(USDC(900)); // full ~990 USDC credit
  });

  it("solvency invariant holds across PvP cycles", async () => {
    const f = await deployAll();
    await toTrench(f, f.bob);
    await toTrench(f, f.carol);
    const wid = await mintItem(f, f.bob.address, TYPE.Weapon, RARITY.Busted);
    await f.item.connect(f.bob).setApprovalForAll(await f.pvp.getAddress(), true);
    await f.pvp.connect(f.bob).attack(f.carol.address, wid);
    await ethers.provider.send("evm_increaseTime", [301]);
    await ethers.provider.send("evm_mine", []);
    await f.pvp.connect(f.bob).resolveAttack(f.carol.address);
    expect(await f.curve.solvencyInvariant()).to.equal(true);
  });
});

// Helper: mine N blocks.
async function hre_mineBlocks(n) {
  for (let i = 0; i < n; i++) {
    await ethers.provider.send("evm_mine", []);
  }
}
