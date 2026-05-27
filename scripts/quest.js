const hre = require("hardhat");
const { ethers } = hre;

// Standalone Quest drop on Monad testnet.
// Usage:
//   npx hardhat run scripts/quest.js --network monadTestnet
//   WALLET=0x... EVENT=KING_KILL npx hardhat run scripts/quest.js --network monadTestnet
//
// Oracle (deployer) commits, waits one block, reveals.
// One drop per (wallet, eventType, epoch) — script will tell you if you're on cooldown.

const QUEST_ADDR = "0xaF367Acd5C05976751c24381E1DC6dA7f83Cf887";
const ITEM_ADDR  = "0x7B7DAA5EcC8BD20400D59569234B42373A91251c";

const EVENT_TYPES = {
  ANY_TRADE: 0,
  SURVIVE_RUG: 1,
  EARLY_BUY: 2,
  PVP_WIN: 3,
  WITNESS_GRADUATION_3: 4,
  KING_KILL: 5,
  SURVIVE_FIVE_RUGS: 6,
};

const RARITY = ["Trash", "Busted", "Cursed", "Legendary"];
const TYPE = ["Weapon", "Armor"];
const decodeItem = (id) => `${TYPE[id >> 8]} / ${RARITY[id & 0xff]}`;

async function main() {
  const [oracle] = await ethers.getSigners();
  const wallet = (process.env.WALLET || oracle.address).toLowerCase();
  const eventName = (process.env.EVENT || "ANY_TRADE").toUpperCase();
  const eventType = EVENT_TYPES[eventName];
  if (eventType === undefined) {
    throw new Error(`unknown EVENT '${eventName}'. one of: ${Object.keys(EVENT_TYPES).join(", ")}`);
  }

  const quest = await ethers.getContractAt("GoblinQuest", QUEST_ADDR);
  const item = await ethers.getContractAt("GoblinItem", ITEM_ADDR);

  console.log("Oracle: ", oracle.address);
  console.log("Wallet: ", wallet);
  console.log("Event:  ", eventName, `(${eventType})`);

  // --- 1. Commit ---
  const seed = ethers.hexlify(ethers.randomBytes(32));
  const salt = ethers.hexlify(ethers.randomBytes(32));
  const commitHash = ethers.keccak256(ethers.concat([seed, salt]));

  console.log("\n[1] Commit");
  const triggerTx = await quest.triggerDrop(wallet, eventType, commitHash);
  const triggerRcpt = await triggerTx.wait();
  console.log("    tx:", triggerRcpt.hash);

  const triggerTopic = quest.interface.getEvent("DropTriggered").topicHash;
  const dropLog = triggerRcpt.logs.find((l) => l.topics[0] === triggerTopic);
  const dropId = quest.interface.parseLog(dropLog).args.dropId;
  console.log("    dropId:", dropId.toString());

  // --- 2. Advance a block (any tx works; cheap self-transfer of 0) ---
  console.log("\n[2] Advance one block (dummy tx)");
  const bump = await oracle.sendTransaction({ to: oracle.address, value: 0n });
  await bump.wait();

  // --- 3. Reveal ---
  console.log("\n[3] Reveal");
  const revealTx = await quest.revealDrop(dropId, seed, salt);
  const revealRcpt = await revealTx.wait();
  console.log("    tx:", revealRcpt.hash);

  const revealTopic = quest.interface.getEvent("DropRevealed").topicHash;
  const revealLog = revealRcpt.logs.find((l) => l.topics[0] === revealTopic);
  if (!revealLog) {
    console.log("    no DropRevealed event found — maybe expired or odd state");
    return;
  }
  const parsed = quest.interface.parseLog(revealLog);
  const itemId = Number(parsed.args.itemId);
  const rarity = Number(parsed.args.rarity);
  const itype = Number(parsed.args.itemType);

  console.log("\n>>> DROP <<<");
  console.log("    itemId:", itemId, `(${decodeItem(itemId)})`);
  console.log("    rarity:", rarity, `(${RARITY[rarity]})`);
  console.log("    type:  ", itype, `(${TYPE[itype]})`);
  console.log("    balance now:", (await item.balanceOf(wallet, itemId)).toString());

  console.log("\nExplorer:");
  console.log("    commit:", "https://testnet.monadexplorer.com/tx/" + triggerRcpt.hash);
  console.log("    reveal:", "https://testnet.monadexplorer.com/tx/" + revealRcpt.hash);
  console.log("    wallet:", "https://testnet.monadexplorer.com/address/" + wallet);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
