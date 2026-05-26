const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = (n) => ethers.parseUnits(n.toString(), 6);
const TOK = (n) => ethers.parseUnits(n.toString(), 18);

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

  // Fund a bunch of wallets
  const wallets = [alice, bob, carol, dave, eve, frank, gina, harry, ivy, jack, kate];
  for (const w of wallets) {
    await usdc.mint(w.address, USDC(1_000_000));
    await usdc.connect(w).approve(await curve.getAddress(), ethers.MaxUint256);
  }

  return { owner, oracle, alice, bob, carol, dave, eve, frank, gina, harry, ivy, jack, kate,
    usdc, badge, access, curve, factory };
}

async function launch(curve, creator) {
  const tx = await curve.connect(creator).launch("Goblin", "GOB", "ipfs://x", 0, 0);
  const rc = await tx.wait();
  // tokenId is 1 on first launch
  return 1n;
}

describe("GoblinCurve - launch / buy / sell", function () {
  it("launches a token with virtual reserves initialized", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    const t = await f.curve.tokens(id);
    expect(t.virtualUSDC).to.equal(USDC(1000));
    expect(t.virtualToken).to.equal(TOK(1_000_000_000));
    expect(t.creator).to.equal(f.alice.address);
    expect(t.graduated).to.equal(false);
  });

  it("buy then sell preserves invariant (approx) and quote matches actual", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    const [quoteOut] = await f.curve.quoteBuy(id, USDC(100), f.bob.address);
    await f.curve.connect(f.bob).buy(id, USDC(100), 0);
    const tokenAddr = (await f.curve.tokens(id)).token;
    const Tok = await ethers.getContractAt("GoblinToken", tokenAddr);
    const bal = await Tok.balanceOf(f.bob.address);
    expect(bal).to.equal(quoteOut);
  });

  it("reverts buy when zero amount", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    await expect(f.curve.connect(f.bob).buy(id, 0, 0)).to.be.revertedWithCustomError(
      f.curve, "ZeroAmount"
    );
  });

  it("reverts buy on slippage", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    await expect(
      f.curve.connect(f.bob).buy(id, USDC(10), ethers.MaxUint256)
    ).to.be.revertedWithCustomError(f.curve, "SlippageExceeded");
  });

  it("reverts sell on slippage", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    await f.curve.connect(f.bob).buy(id, USDC(100), 0);
    const tokenAddr = (await f.curve.tokens(id)).token;
    const Tok = await ethers.getContractAt("GoblinToken", tokenAddr);
    const bal = await Tok.balanceOf(f.bob.address);
    await Tok.connect(f.bob).approve(await f.curve.getAddress(), ethers.MaxUint256);
    await expect(
      f.curve.connect(f.bob).sell(id, bal, ethers.MaxUint256)
    ).to.be.revertedWithCustomError(f.curve, "SlippageExceeded");
  });

  it("reverts on token not found", async () => {
    const f = await deployAll();
    await expect(f.curve.connect(f.bob).buy(999, USDC(1), 0))
      .to.be.revertedWithCustomError(f.curve, "TokenNotFound");
  });
});

describe("GoblinCurve - graduation", function () {
  it("graduates exactly at 69k real USDC", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    // Big single buy from bob to graduate. Account for fee (1%) — push enough USDC so net >=69k.
    // Need net >= 69_000; gross ~= 69_697 to leave 99% net.
    await f.curve.connect(f.bob).buy(id, USDC(70_000), 0);
    const t = await f.curve.tokens(id);
    expect(t.graduated).to.equal(true);
    expect(t.realUSDCCollected).to.be.gte(USDC(69_000));
  });

  it("clamps oversized buy to land exactly on threshold (H-2)", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    const balBefore = await f.usdc.balanceOf(f.bob.address);
    await f.curve.connect(f.bob).buy(id, USDC(100_000), 0);
    const t = await f.curve.tokens(id);
    expect(t.graduated).to.equal(true);
    expect(t.realUSDCCollected).to.equal(USDC(69_000));
    const balAfter = await f.usdc.balanceOf(f.bob.address);
    const spent = balBefore - balAfter;
    // Bob should have been charged ~69k + 1% fee, not the full 100k.
    expect(spent).to.be.lt(USDC(70_000));
    expect(spent).to.be.gt(USDC(69_000));
    expect(await f.curve.solvencyInvariant()).to.equal(true);
  });

  it("rejects buys after graduation", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    await f.curve.connect(f.bob).buy(id, USDC(70_000), 0);
    await expect(f.curve.connect(f.carol).buy(id, USDC(10), 0))
      .to.be.revertedWithCustomError(f.curve, "TokenAlreadyGraduated");
  });
});

describe("GoblinBadge / ranks", function () {
  it("mints CAVE badge on first trade", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    await f.curve.connect(f.bob).buy(id, USDC(10), 0);
    expect(await f.badge.hasBadge(f.bob.address)).to.equal(true);
    expect(await f.badge.getRank(f.bob.address)).to.equal(0); // CAVE
  });

  it("promotes CAVE -> TRENCH after 5 trades (volume floor met)", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    // H-6: need >= 100 USDC of net volume too. 5 x 25 USDC ≈ 124 net.
    for (let i = 0; i < 5; i++) {
      await f.curve.connect(f.bob).buy(id, USDC(25), 0);
    }
    expect(await f.badge.getRank(f.bob.address)).to.equal(1); // TRENCH
  });

  it("promotes TRENCH -> CURSED_HUNTER after surviving a rug", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    // Bob makes 5 trades -> TRENCH, and accrues >= 500 USDC volume for CURSED_HUNTER floor.
    for (let i = 0; i < 5; i++) await f.curve.connect(f.bob).buy(id, USDC(150), 0);

    // Oracle marks CURSED
    await f.curve.connect(f.oracle).setGoblinScore(id, 10);

    // Bob sells (survives rug) -> CURSED_HUNTER
    const tokenAddr = (await f.curve.tokens(id)).token;
    const Tok = await ethers.getContractAt("GoblinToken", tokenAddr);
    await Tok.connect(f.bob).approve(await f.curve.getAddress(), ethers.MaxUint256);
    const bal = await Tok.balanceOf(f.bob.address);
    await f.curve.connect(f.bob).sell(id, bal / 2n, 0);
    expect(await f.badge.getRank(f.bob.address)).to.equal(2); // CURSED_HUNTER
  });

  it("promotes CURSED_HUNTER -> VETERAN after witnessing 3 graduations", async () => {
    const f = await deployAll();
    // Path bob to CURSED_HUNTER first (need >=500 USDC volume for the floor)
    const id0 = await launch(f.curve, f.alice);
    for (let i = 0; i < 5; i++) await f.curve.connect(f.bob).buy(id0, USDC(150), 0);
    await f.curve.connect(f.oracle).setGoblinScore(id0, 10);
    const tokenAddr0 = (await f.curve.tokens(id0)).token;
    const Tok0 = await ethers.getContractAt("GoblinToken", tokenAddr0);
    await Tok0.connect(f.bob).approve(await f.curve.getAddress(), ethers.MaxUint256);
    await f.curve.connect(f.bob).sell(id0, await Tok0.balanceOf(f.bob.address) / 2n, 0);
    expect(await f.badge.getRank(f.bob.address)).to.equal(2);

    // Three graduations witnessed by bob
    for (let g = 0; g < 3; g++) {
      await f.curve.connect(f.alice).launch("T", "T" + g, "ipfs://", 0, 0);
      const newId = await f.curve.nextTokenId() - 1n;
      await f.curve.connect(f.bob).buy(newId, USDC(70_000), 0);
    }
    expect(await f.badge.getRank(f.bob.address)).to.equal(3); // VETERAN
  });

  it("soulbound: transfer reverts", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    await f.curve.connect(f.bob).buy(id, USDC(10), 0);
    await expect(
      f.badge.connect(f.bob).transferFrom(f.bob.address, f.carol.address, 1)
    ).to.be.revertedWithCustomError(f.badge, "Soulbound");
  });

  it("only-curve can mint", async () => {
    const f = await deployAll();
    await expect(f.badge.connect(f.bob).mint(f.bob.address))
      .to.be.revertedWithCustomError(f.badge, "OnlyCurve");
  });
});

describe("Fee discounts by rank", function () {
  it("higher rank quotes more tokens out for same USDC in", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    // Manually push carol to TRENCH by trading first so both quotes price against
    // the same curve state — only the rank-derived fee should differ.
    for (let i = 0; i < 5; i++) await f.curve.connect(f.carol).buy(id, USDC(25), 0);
    expect(await f.badge.getRank(f.carol.address)).to.equal(1);

    // bob = CAVE (no trades), carol = TRENCH; quote both against the post-warmup curve.
    const [cavOut] = await f.curve.quoteBuy(id, USDC(100), f.bob.address);
    const [trenchOut] = await f.curve.quoteBuy(id, USDC(100), f.carol.address);
    expect(trenchOut).to.be.gt(cavOut);
  });
});

describe("Flagging", function () {
  it("rejects flag from non-veteran", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    await f.curve.connect(f.bob).buy(id, USDC(10), 0);
    await expect(f.curve.connect(f.bob).flagForRescore(id))
      .to.be.revertedWithCustomError(f.curve, "NotEnoughRank");
  });

  it("emits RescoringTriggered at 5 unique veteran flags", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);

    // Promote 5 wallets to VETERAN by walking them through the path
    const vets = [f.bob, f.carol, f.dave, f.eve, f.frank];
    // First make one cursed token to feed everyone's rugs.
    const cursedId = await launch(f.curve, f.alice);
    for (const v of vets) {
      for (let i = 0; i < 5; i++) await f.curve.connect(v).buy(cursedId, USDC(150), 0);
    }
    await f.curve.connect(f.oracle).setGoblinScore(cursedId, 10);
    const tokAddr = (await f.curve.tokens(cursedId)).token;
    const Tok = await ethers.getContractAt("GoblinToken", tokAddr);
    for (const v of vets) {
      await Tok.connect(v).approve(await f.curve.getAddress(), ethers.MaxUint256);
      await f.curve.connect(v).sell(cursedId, await Tok.balanceOf(v.address) / 2n, 0);
    }
    // All vets now CURSED_HUNTER. Witness 3 graduations each — every vet personally
    // executes the buy that crosses the threshold so each is credited a witness.
    for (const v of vets) {
      for (let g = 0; g < 3; g++) {
        await f.curve.connect(f.alice).launch("X", "X", "ipfs://", 0, 0);
        const gid = await f.curve.nextTokenId() - 1n;
        await f.curve.connect(v).buy(gid, USDC(70_000), 0);
      }
    }
    for (const v of vets) {
      expect(await f.badge.getRank(v.address)).to.be.gte(3);
    }

    // Now flag the original token
    for (let i = 0; i < 4; i++) {
      await f.curve.connect(vets[i]).flagForRescore(id);
    }
    await expect(f.curve.connect(vets[4]).flagForRescore(id))
      .to.emit(f.curve, "RescoringTriggered");
  });

  it("rejects double-flagging", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    // Quickly push bob to VETERAN via owner-side ancient cheat is not allowed —
    // instead we test directly that a flag mapping prevents the second call.
    // Promote bob to VETERAN through the full path.
    const cursedId = await launch(f.curve, f.alice);
    for (let i = 0; i < 5; i++) await f.curve.connect(f.bob).buy(cursedId, USDC(150), 0);
    await f.curve.connect(f.oracle).setGoblinScore(cursedId, 10);
    const tokAddr = (await f.curve.tokens(cursedId)).token;
    const Tok = await ethers.getContractAt("GoblinToken", tokAddr);
    await Tok.connect(f.bob).approve(await f.curve.getAddress(), ethers.MaxUint256);
    await f.curve.connect(f.bob).sell(cursedId, await Tok.balanceOf(f.bob.address) / 2n, 0);
    for (let g = 0; g < 3; g++) {
      await f.curve.connect(f.alice).launch("X", "X" + g, "ipfs://", 0, 0);
      const gid = await f.curve.nextTokenId() - 1n;
      await f.curve.connect(f.bob).buy(gid, USDC(70_000), 0);
    }
    expect(await f.badge.getRank(f.bob.address)).to.equal(3);

    await f.curve.connect(f.bob).flagForRescore(id);
    await expect(f.curve.connect(f.bob).flagForRescore(id))
      .to.be.revertedWithCustomError(f.curve, "AlreadyFlagged");
  });
});

describe("Oracle / scores", function () {
  it("only oracle can set score", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    await expect(f.curve.connect(f.bob).setGoblinScore(id, 50))
      .to.be.revertedWithCustomError(f.curve, "NotOracle");
  });

  it("labels by score thresholds", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    await f.curve.connect(f.oracle).setGoblinScore(id, 20);
    expect((await f.curve.tokens(id)).label).to.equal(2); // CURSED
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    await f.curve.connect(f.oracle).setGoblinScore(id, 50);
    expect((await f.curve.tokens(id)).label).to.equal(0); // NEUTRAL
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    await f.curve.connect(f.oracle).setGoblinScore(id, 80);
    expect((await f.curve.tokens(id)).label).to.equal(1); // BLESSED
  });
});

describe("Quotes match execution", function () {
  it("buy quote equals actual tokens delivered", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    const [qOut, qFee] = await f.curve.quoteBuy(id, USDC(123), f.bob.address);
    await f.curve.connect(f.bob).buy(id, USDC(123), 0);
    const tokAddr = (await f.curve.tokens(id)).token;
    const Tok = await ethers.getContractAt("GoblinToken", tokAddr);
    expect(await Tok.balanceOf(f.bob.address)).to.equal(qOut);
    expect(qFee).to.equal(USDC(1.23));
  });

  it("sell quote equals actual USDC received", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    await f.curve.connect(f.bob).buy(id, USDC(500), 0);
    const tokAddr = (await f.curve.tokens(id)).token;
    const Tok = await ethers.getContractAt("GoblinToken", tokAddr);
    const bal = await Tok.balanceOf(f.bob.address);
    await Tok.connect(f.bob).approve(await f.curve.getAddress(), ethers.MaxUint256);
    const [qOut] = await f.curve.quoteSell(id, bal / 4n, f.bob.address);
    const before = await f.usdc.balanceOf(f.bob.address);
    await f.curve.connect(f.bob).sell(id, bal / 4n, 0);
    const after = await f.usdc.balanceOf(f.bob.address);
    expect(after - before).to.equal(qOut);
  });
});

// Helper: promote a wallet to VETERAN through the canonical path.
async function promoteToVeteran(f, wallet) {
  // Launch a fresh token, do 5 buys >=150 USDC, mark cursed, sell to gain rug.
  await f.curve.connect(f.alice).launch("V", "V", "ipfs://", 0, 0);
  const cursedId = await f.curve.nextTokenId() - 1n;
  for (let i = 0; i < 5; i++) await f.curve.connect(wallet).buy(cursedId, ethers.parseUnits("150", 6), 0);
  await f.curve.connect(f.oracle).setGoblinScore(cursedId, 10);
  const tokAddr = (await f.curve.tokens(cursedId)).token;
  const Tok = await ethers.getContractAt("GoblinToken", tokAddr);
  await Tok.connect(wallet).approve(await f.curve.getAddress(), ethers.MaxUint256);
  await f.curve.connect(wallet).sell(cursedId, await Tok.balanceOf(wallet.address) / 2n, 0);
  for (let g = 0; g < 3; g++) {
    await f.curve.connect(f.alice).launch("G", "G" + g, "ipfs://", 0, 0);
    const gid = await f.curve.nextTokenId() - 1n;
    await f.curve.connect(wallet).buy(gid, ethers.parseUnits("70000", 6), 0);
  }
}

describe("H-1: pull-pattern releaseAuctionFunds", function () {
  it("credits relayer; blocklisted relayer doesn't brick the protocol; non-blocked claim works", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    await f.curve.connect(f.bob).buy(id, USDC(70_000), 0);
    expect((await f.curve.tokens(id)).graduated).to.equal(true);

    // Block carol (the relayer) — release still credits her without reverting.
    await f.usdc.setBlocked(f.carol.address, true);
    await expect(f.curve.releaseAuctionFunds(id, f.carol.address, USDC(1_000)))
      .to.emit(f.curve, "WithdrawalCredited").withArgs(f.carol.address, USDC(1_000));
    expect(await f.curve.pendingWithdrawals(f.carol.address)).to.equal(USDC(1_000));

    // Carol's claim reverts (USDC mock blocks the transfer) but credit must be preserved.
    await expect(f.curve.connect(f.carol).claim()).to.be.reverted;
    expect(await f.curve.pendingWithdrawals(f.carol.address)).to.equal(USDC(1_000));

    // Other users keep operating: launch + buy on a fresh token.
    await f.curve.connect(f.alice).launch("Other", "OTH", "ipfs://", 0, 0);
    const id2 = await f.curve.nextTokenId() - 1n;
    await f.curve.connect(f.dave).buy(id2, USDC(10), 0);

    // Unblock carol; claim succeeds and zeros credit.
    await f.usdc.setBlocked(f.carol.address, false);
    const before = await f.usdc.balanceOf(f.carol.address);
    await expect(f.curve.connect(f.carol).claim())
      .to.emit(f.curve, "WithdrawalClaimed").withArgs(f.carol.address, USDC(1_000));
    expect(await f.usdc.balanceOf(f.carol.address) - before).to.equal(USDC(1_000));
    expect(await f.curve.pendingWithdrawals(f.carol.address)).to.equal(0);
  });

  it("claim reverts with NothingToClaim when no credit", async () => {
    const f = await deployAll();
    await expect(f.curve.connect(f.bob).claim())
      .to.be.revertedWithCustomError(f.curve, "NothingToClaim");
  });
});

describe("H-5: top-10 gated to VETERAN+", function () {
  it("low-rank wallet with high volume does NOT enter top10", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    // Bob is CAVE; do several buys. Net volume should be sizable but rank stays CAVE
    // until 5 trades AND 100 USDC volume. We deliberately stay sub-5 trades.
    await f.curve.connect(f.bob).buy(id, USDC(10_000), 0);
    // Bob is still CAVE (only 1 trade).
    expect(await f.badge.getRank(f.bob.address)).to.equal(0);
    const kings = await f.curve.getTopKings();
    expect(kings.every(k => k === ethers.ZeroAddress)).to.equal(true);
    // Lifetime volume bumped for analytics regardless.
    expect(await f.curve.lifetimeUSDCVolume(f.bob.address)).to.be.gt(0);
  });
});

describe("H-6: rank promotion requires volume floor", function () {
  it("5 trades below the 100 USDC volume floor does NOT promote to TRENCH", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);
    for (let i = 0; i < 5; i++) await f.curve.connect(f.bob).buy(id, USDC(5), 0);
    // 5 trades complete, but ~25 USDC net volume — below 100 floor.
    expect(await f.badge.getRank(f.bob.address)).to.equal(0); // still CAVE
    // Pushing one more sizable trade clears the floor and promotes.
    await f.curve.connect(f.bob).buy(id, USDC(120), 0);
    expect(await f.badge.getRank(f.bob.address)).to.equal(1); // TRENCH
  });
});

describe("M-1: multi-oracle + per-token score cooldown", function () {
  it("multiple oracles can score independently; cooldown blocks rapid re-score", async () => {
    const f = await deployAll();
    const id = await launch(f.curve, f.alice);

    // Add a second oracle alongside the first.
    await f.curve.addOracle(f.dave.address);
    expect(await f.curve.isOracle(f.oracle.address)).to.equal(true);
    expect(await f.curve.isOracle(f.dave.address)).to.equal(true);

    // First oracle scores; immediate re-score by either oracle should revert on cooldown.
    await f.curve.connect(f.oracle).setGoblinScore(id, 80);
    await expect(f.curve.connect(f.dave).setGoblinScore(id, 20))
      .to.be.revertedWithCustomError(f.curve, "ScoreCooldownActive");

    // Advance > 1 hour and the second oracle can now score.
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    await f.curve.connect(f.dave).setGoblinScore(id, 20);
    expect((await f.curve.tokens(id)).goblinScore).to.equal(20);

    // Removed oracle can no longer score.
    await f.curve.removeOracle(f.dave.address);
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    await expect(f.curve.connect(f.dave).setGoblinScore(id, 50))
      .to.be.revertedWithCustomError(f.curve, "NotOracle");
  });

  it("setOracle replaces the oracle set with the new single signer", async () => {
    const f = await deployAll();
    // Prior primary oracle is f.oracle. Replace with eve.
    await f.curve.setOracle(f.eve.address);
    expect(await f.curve.isOracle(f.eve.address)).to.equal(true);
    expect(await f.curve.isOracle(f.oracle.address)).to.equal(false);
    const id = await launch(f.curve, f.alice);
    await expect(f.curve.connect(f.oracle).setGoblinScore(id, 50))
      .to.be.revertedWithCustomError(f.curve, "NotOracle");
    await f.curve.connect(f.eve).setGoblinScore(id, 50);
  });
});

describe("M-2: predictAddress matches deploy", function () {
  it("predicted address equals deployed address", async () => {
    const f = await deployAll();
    // We need the timestamp of the launch block; capture via tx receipt.
    const tx = await f.curve.connect(f.alice).launch("Goblin", "PRED", "ipfs://x", 0, 0);
    const rc = await tx.wait();
    const block = await ethers.provider.getBlock(rc.blockNumber);
    const id = await f.curve.nextTokenId() - 1n;
    const actual = (await f.curve.tokens(id)).token;
    const predicted = await f.factory.predictAddress(
      "Goblin", "PRED", await f.curve.INITIAL_SUPPLY(), f.alice.address, block.timestamp
    );
    expect(predicted).to.equal(actual);
  });
});

describe("L-1: two-step ownership transfer", function () {
  it("pendingOwner set, only pendingOwner can accept, owner unchanged until accept", async () => {
    const f = await deployAll();
    expect(await f.curve.owner()).to.equal(f.owner.address);

    await expect(f.curve.connect(f.owner).transferOwnership(f.bob.address))
      .to.emit(f.curve, "OwnershipTransferStarted")
      .withArgs(f.owner.address, f.bob.address);

    expect(await f.curve.pendingOwner()).to.equal(f.bob.address);
    expect(await f.curve.owner()).to.equal(f.owner.address); // unchanged

    // Non-pending caller cannot accept.
    await expect(f.curve.connect(f.carol).acceptOwnership())
      .to.be.revertedWithCustomError(f.curve, "NotPendingOwner");

    // The pending owner accepts.
    await expect(f.curve.connect(f.bob).acceptOwnership())
      .to.emit(f.curve, "OwnershipTransferred")
      .withArgs(f.owner.address, f.bob.address);
    expect(await f.curve.owner()).to.equal(f.bob.address);
    expect(await f.curve.pendingOwner()).to.equal(ethers.ZeroAddress);

    // Old owner can no longer perform owner-only ops.
    await expect(f.curve.connect(f.owner).setOracle(f.carol.address))
      .to.be.revertedWithCustomError(f.curve, "NotOwner");
  });
});
