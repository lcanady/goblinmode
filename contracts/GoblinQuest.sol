// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./utils/Ownable.sol";
import "./GoblinItem.sol";

/// @title GoblinQuest
/// @notice Loot drop engine. Oracles commit a hash, then later reveal a seed+salt. The
/// revealed seed XOR'd with `blockhash(commitBlock)` produces the randomness used to roll
/// rarity from a per-event-type pool. Commit-reveal beats VRF here because we don't need
/// trustless randomness — we just need a randomness source the oracle can't manipulate
/// AFTER seeing the outcome. The blockhash binding prevents both sides from cheating.
contract GoblinQuest is Ownable {
    GoblinItem public immutable item;

    // --- Event types — values must stay stable; indexer keys on them. ---
    enum EventType {
        ANY_TRADE,                // 0  Trash-heavy
        SURVIVE_RUG,              // 1  Busted-weighted
        EARLY_BUY,                // 2  Busted-weighted
        PVP_WIN,                  // 3  Cursed-weighted
        WITNESS_GRADUATION_3,     // 4  Cursed-weighted
        KING_KILL,                // 5  Legendary-weighted
        SURVIVE_FIVE_RUGS         // 6  Legendary-weighted
    }

    struct PendingDrop {
        address wallet;
        EventType eventType;
        uint64 commitBlock;
        bytes32 commitHash; // keccak256(abi.encode(seed, salt))
        bool revealed;
        bool expired;
    }

    // --- Storage ---
    mapping(address => bool) public isOracle;
    /// @notice Contracts (e.g. GoblinPvP) authorized to trigger drops in-line without
    /// a commit-reveal dance. This is a weaker randomness source (block.prevrandao /
    /// blockhash only) and is used only for system-driven rewards such as KING_KILL.
    /// Player-controlled drops should still go through the oracle commit-reveal path.
    mapping(address => bool) public isAutoTrigger;
    mapping(uint256 => PendingDrop) public pendingDrops;
    uint256 public nextDropId = 1;

    // Cooldown: wallet x eventType => last epoch with a drop. Epoch = block.timestamp/3600.
    mapping(address => mapping(uint8 => uint256)) public lastDropEpoch;

    // Reveal window. After this many blocks the blockhash() becomes inaccessible.
    uint256 public constant REVEAL_WINDOW_BLOCKS = 256;

    // --- Events ---
    event OracleAdded(address indexed oracle);
    event OracleRemoved(address indexed oracle);
    event DropTriggered(uint256 indexed dropId, address indexed wallet, EventType eventType, bytes32 commitHash);
    event DropRevealed(uint256 indexed dropId, address indexed wallet, uint256 itemId, GoblinItem.Rarity rarity, GoblinItem.ItemType itemType);
    event DropExpired(uint256 indexed dropId);

    // --- Errors ---
    error NotOracleErr();
    error CooldownActive();
    error DropNotPending();
    error AlreadyResolved();
    error BadReveal();
    error RevealWindowClosed();
    error NotExpiredYet();

    constructor(address _item, address initialOwner) Ownable(initialOwner) {
        if (_item == address(0)) revert ZeroAddress();
        item = GoblinItem(_item);
    }

    // ----------------------------------------------------------------
    // Admin
    // ----------------------------------------------------------------
    function addOracle(address o) external onlyOwner {
        if (o == address(0)) revert ZeroAddress();
        if (!isOracle[o]) {
            isOracle[o] = true;
            emit OracleAdded(o);
        }
    }

    function removeOracle(address o) external onlyOwner {
        if (isOracle[o]) {
            isOracle[o] = false;
            emit OracleRemoved(o);
        }
    }

    event AutoTriggerAdded(address indexed who);
    event AutoTriggerRemoved(address indexed who);

    function addAutoTrigger(address who) external onlyOwner {
        if (who == address(0)) revert ZeroAddress();
        if (!isAutoTrigger[who]) {
            isAutoTrigger[who] = true;
            emit AutoTriggerAdded(who);
        }
    }

    function removeAutoTrigger(address who) external onlyOwner {
        if (isAutoTrigger[who]) {
            isAutoTrigger[who] = false;
            emit AutoTriggerRemoved(who);
        }
    }

    /// @notice In-line drop callable only by trusted contracts (PvP). Skips commit-reveal
    /// and uses block.prevrandao XOR blockhash for randomness. Used for KING_KILL drops
    /// where the trigger is a deterministic on-chain event that already favors miner trust.
    /// Cooldown still applies. Emits DropTriggered with commitHash==0 plus DropRevealed.
    function autoTriggerDrop(address wallet, EventType eventType) external returns (uint256 itemId) {
        if (!isAutoTrigger[msg.sender]) revert NotOracleErr();
        uint256 epoch = block.timestamp / 3600;
        uint8 et = uint8(eventType);
        if (lastDropEpoch[wallet][et] == epoch) revert CooldownActive();
        lastDropEpoch[wallet][et] = epoch;

        uint256 dropId = nextDropId++;
        // Record a synthetic drop entry for indexer parity, immediately revealed.
        pendingDrops[dropId] = PendingDrop({
            wallet: wallet,
            eventType: eventType,
            commitBlock: uint64(block.number),
            commitHash: bytes32(0),
            revealed: true,
            expired: false
        });
        emit DropTriggered(dropId, wallet, eventType, bytes32(0));

        uint256 rng = uint256(keccak256(abi.encode(
            block.prevrandao,
            blockhash(block.number - 1),
            wallet,
            dropId
        )));
        (GoblinItem.Rarity rarity, GoblinItem.ItemType iType) = _roll(eventType, rng);
        itemId = (uint256(uint8(iType)) << 8) | uint256(uint8(rarity));
        item.mint(wallet, itemId, 1);
        emit DropRevealed(dropId, wallet, itemId, rarity, iType);
    }

    // ----------------------------------------------------------------
    // Commit
    // ----------------------------------------------------------------

    /// @notice Oracle commits to a drop. The commitHash binds them to (seed, salt) so they
    /// can't pick a favourable seed AFTER seeing blockhash(commitBlock). The cooldown
    /// throttles to one drop per (wallet, eventType, epoch).
    function triggerDrop(address wallet, EventType eventType, bytes32 commitHash)
        external
        returns (uint256 dropId)
    {
        if (!isOracle[msg.sender]) revert NotOracleErr();
        uint256 epoch = block.timestamp / 3600;
        uint8 et = uint8(eventType);
        if (lastDropEpoch[wallet][et] == epoch) revert CooldownActive();
        lastDropEpoch[wallet][et] = epoch;

        dropId = nextDropId++;
        pendingDrops[dropId] = PendingDrop({
            wallet: wallet,
            eventType: eventType,
            commitBlock: uint64(block.number),
            commitHash: commitHash,
            revealed: false,
            expired: false
        });
        emit DropTriggered(dropId, wallet, eventType, commitHash);
    }

    // ----------------------------------------------------------------
    // Reveal
    // ----------------------------------------------------------------

    /// @notice Reveal a commit. Anyone can call (the seed/salt are public after this),
    /// but the seed must hash to the previously-committed hash. Must be revealed before
    /// blockhash(commitBlock) becomes inaccessible (~256 blocks).
    function revealDrop(uint256 dropId, bytes32 seed, bytes32 salt) external {
        PendingDrop storage d = pendingDrops[dropId];
        if (d.wallet == address(0)) revert DropNotPending();
        if (d.revealed || d.expired) revert AlreadyResolved();
        if (keccak256(abi.encode(seed, salt)) != d.commitHash) revert BadReveal();
        if (block.number > uint256(d.commitBlock) + REVEAL_WINDOW_BLOCKS) revert RevealWindowClosed();
        // commitBlock must be strictly in the past for blockhash to be defined.
        if (block.number <= d.commitBlock) revert BadReveal();

        bytes32 bh = blockhash(d.commitBlock);
        // bh == 0x0 means the block is out of range; the window check above guards against
        // the common case, but blockhash on the SAME block returns 0 too — already excluded.
        uint256 rng = uint256(seed ^ bh);

        d.revealed = true;
        (GoblinItem.Rarity rarity, GoblinItem.ItemType iType) = _roll(d.eventType, rng);
        uint256 itemId = (uint256(uint8(iType)) << 8) | uint256(uint8(rarity));
        item.mint(d.wallet, itemId, 1);
        emit DropRevealed(dropId, d.wallet, itemId, rarity, iType);
    }

    /// @notice Mark a drop expired if the oracle failed to reveal within the window.
    /// Anyone can call this — it just frees the slot for accounting.
    function expireDrop(uint256 dropId) external {
        PendingDrop storage d = pendingDrops[dropId];
        if (d.wallet == address(0)) revert DropNotPending();
        if (d.revealed || d.expired) revert AlreadyResolved();
        if (block.number <= uint256(d.commitBlock) + REVEAL_WINDOW_BLOCKS) revert NotExpiredYet();
        d.expired = true;
        emit DropExpired(dropId);
    }

    // ----------------------------------------------------------------
    // Rarity roll
    // ----------------------------------------------------------------

    /// @notice Roll rarity and item type from a uniform uint256.
    /// We split the rng into two independent uint128s: low half → rarity, high half → type.
    function _roll(EventType et, uint256 rng) internal pure returns (GoblinItem.Rarity, GoblinItem.ItemType) {
        uint256 rarityRoll = uint256(uint128(rng)) % 10_000;
        uint256 typeRoll = uint256(rng >> 128) & 1;

        GoblinItem.Rarity r;
        if (et == EventType.ANY_TRADE) {
            // 90% Trash, 8% Busted, 2% Cursed, 0% Legendary
            if (rarityRoll < 9000) r = GoblinItem.Rarity.Trash;
            else if (rarityRoll < 9800) r = GoblinItem.Rarity.Busted;
            else r = GoblinItem.Rarity.Cursed;
        } else if (et == EventType.SURVIVE_RUG || et == EventType.EARLY_BUY) {
            // 30 / 50 / 18 / 2
            if (rarityRoll < 3000) r = GoblinItem.Rarity.Trash;
            else if (rarityRoll < 8000) r = GoblinItem.Rarity.Busted;
            else if (rarityRoll < 9800) r = GoblinItem.Rarity.Cursed;
            else r = GoblinItem.Rarity.Legendary;
        } else if (et == EventType.PVP_WIN || et == EventType.WITNESS_GRADUATION_3) {
            // 10 / 25 / 55 / 10
            if (rarityRoll < 1000) r = GoblinItem.Rarity.Trash;
            else if (rarityRoll < 3500) r = GoblinItem.Rarity.Busted;
            else if (rarityRoll < 9000) r = GoblinItem.Rarity.Cursed;
            else r = GoblinItem.Rarity.Legendary;
        } else {
            // KING_KILL / SURVIVE_FIVE_RUGS: 0 / 10 / 30 / 60
            if (rarityRoll < 1000) r = GoblinItem.Rarity.Busted;
            else if (rarityRoll < 4000) r = GoblinItem.Rarity.Cursed;
            else r = GoblinItem.Rarity.Legendary;
        }

        GoblinItem.ItemType iType = typeRoll == 0 ? GoblinItem.ItemType.Weapon : GoblinItem.ItemType.Armor;
        return (r, iType);
    }
}
