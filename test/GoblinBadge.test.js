const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("GoblinBadge - direct", function () {
  async function deployBadgeOnly() {
    const [owner, fakeCurve, alice] = await ethers.getSigners();
    const Badge = await ethers.getContractFactory("GoblinBadge");
    const badge = await Badge.deploy(owner.address);
    return { owner, fakeCurve, alice, badge };
  }

  it("setCurve is one-shot", async () => {
    const { owner, fakeCurve, badge } = await deployBadgeOnly();
    await badge.setCurve(fakeCurve.address);
    await expect(badge.setCurve(fakeCurve.address))
      .to.be.revertedWithCustomError(badge, "CurveAlreadySet");
  });

  it("only owner can setCurve", async () => {
    const { fakeCurve, alice, badge } = await deployBadgeOnly();
    await expect(badge.connect(alice).setCurve(fakeCurve.address))
      .to.be.revertedWithCustomError(badge, "NotOwner");
  });

  it("mint only by curve", async () => {
    const { owner, fakeCurve, alice, badge } = await deployBadgeOnly();
    await badge.setCurve(fakeCurve.address);
    await expect(badge.connect(alice).mint(alice.address))
      .to.be.revertedWithCustomError(badge, "OnlyCurve");
    await badge.connect(fakeCurve).mint(alice.address);
    expect(await badge.hasBadge(alice.address)).to.equal(true);
  });

  it("mint rejects double", async () => {
    const { fakeCurve, alice, badge } = await deployBadgeOnly();
    await badge.setCurve(fakeCurve.address);
    await badge.connect(fakeCurve).mint(alice.address);
    await expect(badge.connect(fakeCurve).mint(alice.address))
      .to.be.revertedWithCustomError(badge, "AlreadyHasBadge");
  });

  it("all transfer surfaces revert with Soulbound", async () => {
    const { fakeCurve, alice, badge } = await deployBadgeOnly();
    await badge.setCurve(fakeCurve.address);
    await badge.connect(fakeCurve).mint(alice.address);

    await expect(badge.connect(alice).transferFrom(alice.address, fakeCurve.address, 1))
      .to.be.revertedWithCustomError(badge, "Soulbound");
    await expect(badge.connect(alice).approve(fakeCurve.address, 1))
      .to.be.revertedWithCustomError(badge, "Soulbound");
    await expect(badge.connect(alice).setApprovalForAll(fakeCurve.address, true))
      .to.be.revertedWithCustomError(badge, "Soulbound");
    await expect(
      badge.connect(alice)["safeTransferFrom(address,address,uint256)"](
        alice.address, fakeCurve.address, 1
      )
    ).to.be.revertedWithCustomError(badge, "Soulbound");
  });

  it("rankUp is monotonic (no-op on lower)", async () => {
    const { fakeCurve, alice, badge } = await deployBadgeOnly();
    await badge.setCurve(fakeCurve.address);
    await badge.connect(fakeCurve).mint(alice.address);
    await badge.connect(fakeCurve).rankUp(alice.address, 3); // VETERAN
    expect(await badge.getRank(alice.address)).to.equal(3);
    await badge.connect(fakeCurve).rankUp(alice.address, 1); // attempt downgrade
    expect(await badge.getRank(alice.address)).to.equal(3);
  });

  it("tokenURI returns ipfs placeholder", async () => {
    const { fakeCurve, alice, badge } = await deployBadgeOnly();
    await badge.setCurve(fakeCurve.address);
    await badge.connect(fakeCurve).mint(alice.address);
    const uri = await badge.tokenURI(1);
    expect(uri).to.equal("ipfs://placeholder/0.json");
  });

  it("supportsInterface ERC-721", async () => {
    const { badge } = await deployBadgeOnly();
    expect(await badge.supportsInterface("0x80ac58cd")).to.equal(true);
    expect(await badge.supportsInterface("0x01ffc9a7")).to.equal(true);
    expect(await badge.supportsInterface("0xdeadbeef")).to.equal(false);
  });
});
