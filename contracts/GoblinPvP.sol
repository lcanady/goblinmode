// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./utils/Ownable.sol";
import "./utils/ReentrancyGuard.sol";
import "./GoblinBadge.sol";
import "./GoblinAccess.sol";
import "./GoblinItem.sol";
import "./GoblinQuest.sol";

/// @title GoblinPvP
/// @notice Raid system. Wallets at rank TRENCH+ can burn a Weapon to apply "score rot"
/// to a target wallet for the current epoch. Rot scales the rank-progression counters
/// on the target during that epoch — reversible next epoch. Defenders may burn an Armor
/// within 5 minutes to reduce/reflect the rot. Cumulative rot >= 100% in one epoch
/// demotes the target's rank by one (floor: CAVE; ANCIENT immune).
contract GoblinPvP is Ownable, ReentrancyGuard {
    // ----------------------------------------------------------------
    // Constants
    // ----------------------------------------------------------------
    uint256 public constant EPOCH_SECONDS = 3600;
    uint256 public constant DEFEND_WINDOW = 300; // 5 minutes
    uint256 public constant ATTACKER_COOLDOWN = 600; // 10 minutes
    uint256 public constant BPS_DENOM = 10_000;

    // ----------------------------------------------------------------
    // Collaborators
    // ----------------------------------------------------------------
    GoblinBadge public immutable badge;
    GoblinItem public immutable item;
    GoblinAccess public immutable access;
    GoblinQuest public immutable quest;

    // ----------------------------------------------------------------
    // Types
    // ----------------------------------------------------------------
    struct ActiveAttack {
        address attacker;
        uint256 weaponId;
        uint16 rotBps;        // 2500/5000/7500/9000 from Trash/Busted/Cursed/Legendary
        uint64 attackTimestamp;
        bool resolved;
    }

    // target => attack
    mapping(address => ActiveAttack) public activeAttacks;
    // attacker => last attack timestamp (cooldown)
    mapping(address => uint256) public lastAttackAt;

    // epoch => wallet => cumulative rot bps (capped at BPS_DENOM)
    mapping(uint256 => mapping(address => uint256)) public epochRotBps;

    // ----------------------------------------------------------------
    // Events
    // ----------------------------------------------------------------
    event AttackLaunched(address indexed attacker, address indexed target, GoblinItem.Rarity weaponRarity, uint16 rotBps);
    event DefendWindowOpen(address indexed target, address indexed attacker, uint256 windowSeconds);
    event AttackBlocked(address indexed target, address indexed attacker, GoblinItem.Rarity armorRarity, uint256 reflectedBps);
    event AttackLanded(address indexed attacker, address indexed target, uint256 rotBps, uint256 epoch);
    event RankDropped(address indexed target, GoblinBadge.Rank oldRank, GoblinBadge.Rank newRank, address indexed attacker);

    // ----------------------------------------------------------------
    // Errors
    // ----------------------------------------------------------------
    error NotEnoughRank();
    error NotWeapon();
    error NotArmor();
    error AttackInProgress();
    error NoActiveAttack();
    error NotTarget();
    error WindowClosed();
    error AttackerOnCooldown();
    error DefendWindowStillOpen();
    error AlreadyResolved();

    constructor(
        address _badge,
        address _item,
        address _access,
        address _quest,
        address initialOwner
    ) Ownable(initialOwner) {
        if (_badge == address(0) || _item == address(0) || _access == address(0) || _quest == address(0)) revert ZeroAddress();
        badge = GoblinBadge(_badge);
        item = GoblinItem(_item);
        access = GoblinAccess(_access);
        quest = GoblinQuest(_quest);
    }

    // ----------------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------------

    /// @notice Rot multiplier for the target wallet in the current epoch, in bps.
    /// Returned value is the SURVIVING fraction (e.g. 7500 means 75% of normal progression).
    /// GoblinCurve consults this to scale rank-progression bumps.
    function getRotMultiplierBps(address wallet) external view returns (uint256) {
        uint256 epoch = block.timestamp / EPOCH_SECONDS;
        uint256 rot = epochRotBps[epoch][wallet];
        if (rot >= BPS_DENOM) return 0;
        return BPS_DENOM - rot;
    }

    function currentEpoch() public view returns (uint256) {
        return block.timestamp / EPOCH_SECONDS;
    }

    function _rotForWeaponRarity(GoblinItem.Rarity r) internal pure returns (uint16) {
        // Trash 25% / Busted 50% / Cursed 75% / Legendary 90%.
        if (r == GoblinItem.Rarity.Trash) return 2500;
        if (r == GoblinItem.Rarity.Busted) return 5000;
        if (r == GoblinItem.Rarity.Cursed) return 7500;
        return 9000;
    }

    function _blockForArmorRarity(GoblinItem.Rarity r) internal pure returns (uint16 blockBps, uint16 reflectBps) {
        // Trash 25% / Busted 50% / Cursed 75% block. Legendary 100% block + 25% reflect.
        if (r == GoblinItem.Rarity.Trash) return (2500, 0);
        if (r == GoblinItem.Rarity.Busted) return (5000, 0);
        if (r == GoblinItem.Rarity.Cursed) return (7500, 0);
        return (10_000, 2500);
    }

    function _decodeId(uint256 id) internal pure returns (GoblinItem.ItemType t, GoblinItem.Rarity r) {
        t = GoblinItem.ItemType(uint8(id >> 8));
        r = GoblinItem.Rarity(uint8(id & 0xff));
    }

    // ----------------------------------------------------------------
    // Attack
    // ----------------------------------------------------------------

    function attack(address target, uint256 weaponId) external nonReentrant {
        // Gate by rank (TRENCH+).
        if (!access.canInitiateAttack(msg.sender)) revert NotEnoughRank();

        (GoblinItem.ItemType t, GoblinItem.Rarity r) = _decodeId(weaponId);
        if (t != GoblinItem.ItemType.Weapon) revert NotWeapon();

        // No stacking on same target.
        ActiveAttack storage existing = activeAttacks[target];
        if (existing.attacker != address(0) && !existing.resolved) revert AttackInProgress();

        // Per-attacker cooldown.
        if (block.timestamp < lastAttackAt[msg.sender] + ATTACKER_COOLDOWN && lastAttackAt[msg.sender] != 0) {
            revert AttackerOnCooldown();
        }

        // Burn the weapon. Caller must have approved this contract as operator on the item.
        item.burn(msg.sender, weaponId, 1);

        uint16 rotBps = _rotForWeaponRarity(r);
        activeAttacks[target] = ActiveAttack({
            attacker: msg.sender,
            weaponId: weaponId,
            rotBps: rotBps,
            attackTimestamp: uint64(block.timestamp),
            resolved: false
        });
        lastAttackAt[msg.sender] = block.timestamp;

        emit AttackLaunched(msg.sender, target, r, rotBps);
        emit DefendWindowOpen(target, msg.sender, DEFEND_WINDOW);
    }

    // ----------------------------------------------------------------
    // Defend
    // ----------------------------------------------------------------

    function defend(uint256 armorId) external nonReentrant {
        ActiveAttack storage a = activeAttacks[msg.sender];
        if (a.attacker == address(0) || a.resolved) revert NoActiveAttack();
        if (block.timestamp > uint256(a.attackTimestamp) + DEFEND_WINDOW) revert WindowClosed();

        (GoblinItem.ItemType t, GoblinItem.Rarity r) = _decodeId(armorId);
        if (t != GoblinItem.ItemType.Armor) revert NotArmor();

        item.burn(msg.sender, armorId, 1);

        (uint16 blockBps, uint16 reflectBps) = _blockForArmorRarity(r);
        uint256 originalRot = a.rotBps;
        uint256 effectiveRot;
        if (blockBps >= BPS_DENOM) {
            effectiveRot = 0;
        } else {
            // Surviving fraction = (BPS_DENOM - blockBps) / BPS_DENOM
            effectiveRot = (originalRot * (BPS_DENOM - blockBps)) / BPS_DENOM;
        }

        uint256 reflected = 0;
        if (reflectBps > 0) {
            reflected = (originalRot * reflectBps) / BPS_DENOM;
            _applyRot(a.attacker, reflected, address(0));
        }

        if (effectiveRot > 0) {
            _applyRot(msg.sender, effectiveRot, a.attacker);
        }

        a.resolved = true;
        emit AttackBlocked(msg.sender, a.attacker, r, reflected);
        emit AttackLanded(a.attacker, msg.sender, effectiveRot, currentEpoch());
    }

    // ----------------------------------------------------------------
    // Resolve (no defense)
    // ----------------------------------------------------------------

    function resolveAttack(address target) external nonReentrant {
        ActiveAttack storage a = activeAttacks[target];
        if (a.attacker == address(0) || a.resolved) revert NoActiveAttack();
        if (block.timestamp <= uint256(a.attackTimestamp) + DEFEND_WINDOW) revert DefendWindowStillOpen();

        a.resolved = true;
        _applyRot(target, a.rotBps, a.attacker);
        emit AttackLanded(a.attacker, target, a.rotBps, currentEpoch());
    }

    // ----------------------------------------------------------------
    // Internal: apply rot and check killing blow
    // ----------------------------------------------------------------
    function _applyRot(address target, uint256 rotBps, address attackerForKillingBlow) internal {
        uint256 epoch = currentEpoch();
        uint256 cur = epochRotBps[epoch][target];
        uint256 next = cur + rotBps;
        if (next > BPS_DENOM) next = BPS_DENOM;
        epochRotBps[epoch][target] = next;

        // Killing blow: cumulative >= 100% in the same epoch.
        if (next >= BPS_DENOM && attackerForKillingBlow != address(0)) {
            GoblinBadge.Rank oldRank = badge.getRank(target);
            // Skip floor (CAVE) and immune (ANCIENT).
            if (oldRank != GoblinBadge.Rank.CAVE && oldRank != GoblinBadge.Rank.ANCIENT) {
                badge.demoteRank(target);
                GoblinBadge.Rank newRank = badge.getRank(target);
                emit RankDropped(target, oldRank, newRank, attackerForKillingBlow);
                // Try to grant a KING_KILL drop to the attacker. Catch revert so a Quest
                // cooldown or auto-trigger misconfiguration cannot brick the PvP flow.
                try quest.autoTriggerDrop(attackerForKillingBlow, GoblinQuest.EventType.KING_KILL) returns (uint256) {} catch {}
            }
        }
    }
}
