// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./GoblinBadge.sol";

/// @title GoblinAccess
/// @notice Pure read layer over GoblinBadge. Splitting "what perks does a rank give you?"
/// out of the badge contract means we can iterate on perk math without redeploying NFTs.
contract GoblinAccess {
    GoblinBadge public immutable badge;

    constructor(address _badge) {
        // Bound at construction; access rules are tied to a specific badge contract version.
        badge = GoblinBadge(_badge);
    }

    /// @notice Fee in basis points the curve should charge this wallet.
    /// Defaults to CAVE (1%) so wallets with no badge yet pay the standard rate.
    function getFeeBps(address wallet) external view returns (uint256) {
        GoblinBadge.Rank r = badge.getRank(wallet);
        if (r == GoblinBadge.Rank.CAVE) return 100;
        if (r == GoblinBadge.Rank.TRENCH) return 90;
        if (r == GoblinBadge.Rank.CURSED_HUNTER) return 85;
        if (r == GoblinBadge.Rank.VETERAN) return 75;
        if (r == GoblinBadge.Rank.KING) return 60;
        return 50; // ANCIENT
    }

    /// @notice Seconds of early-access window before a token opens to lower ranks.
    /// 999 for ANCIENT is a sentinel meaning "unlimited" — the frontend treats it specially.
    function getEarlyAccessSeconds(address wallet) external view returns (uint256) {
        GoblinBadge.Rank r = badge.getRank(wallet);
        if (r == GoblinBadge.Rank.CAVE) return 0;
        if (r == GoblinBadge.Rank.TRENCH) return 30;
        if (r == GoblinBadge.Rank.CURSED_HUNTER) return 60;
        if (r == GoblinBadge.Rank.VETERAN) return 90;
        if (r == GoblinBadge.Rank.KING) return 120;
        return 999;
    }

    function canSeeScoreBreakdown(address wallet) external view returns (bool) {
        // Hide the goblin-score components from low-rank wallets to preserve the
        // information asymmetry that the reputation system is selling.
        return uint8(badge.getRank(wallet)) >= uint8(GoblinBadge.Rank.CURSED_HUNTER);
    }

    function canFlagToken(address wallet) external view returns (bool) {
        // Only veterans+ can flag — prevents spam-flagging attacks from new wallets.
        return uint8(badge.getRank(wallet)) >= uint8(GoblinBadge.Rank.VETERAN);
    }

    /// @notice TRENCH+ gate for initiating PvP attacks. Wraps the rank check used by
    /// GoblinPvP so the rule can be tweaked here without touching the raid contract.
    function canInitiateAttack(address wallet) external view returns (bool) {
        return uint8(badge.getRank(wallet)) >= uint8(GoblinBadge.Rank.TRENCH);
    }

    function getFlagThreshold() external pure returns (uint256) {
        // Five independent veteran flags trigger a rescoring. Constant for now;
        // making it a function lets us upgrade governance later without ABI churn.
        return 5;
    }
}
