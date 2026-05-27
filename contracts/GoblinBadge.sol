// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./utils/Ownable.sol";

/// @title GoblinBadge
/// @notice Soulbound ERC-721. One badge per wallet, untransferable, rank-stamped.
/// Acts as the on-chain reputation primitive that GoblinAccess reads from to gate
/// fee discounts, early access, score breakdowns, and flag rights.
contract GoblinBadge is Ownable {
    // --- Rank enum (order matters: higher index = higher rank) ---
    enum Rank { CAVE, TRENCH, CURSED_HUNTER, VETERAN, KING, ANCIENT }

    // --- ERC-721 metadata ---
    string public constant name = "Goblin Badge";
    string public constant symbol = "GBADGE";

    // --- Storage ---
    address public curve; // only the curve may mint and rank up
    address public pvp;   // only the pvp contract may demote rank
    uint256 public nextTokenId = 1;

    mapping(address => uint256) public badgeOf;          // wallet => tokenId (0 = none)
    mapping(uint256 => address) public ownerOf;          // tokenId => wallet
    mapping(uint256 => Rank) public rankOf;              // tokenId => current rank

    // Stats — also read by curve to compute rank upgrades
    mapping(address => uint256) public tradeCount;
    mapping(address => uint256) public graduationsWitnessed;
    mapping(address => uint256) public rugsSurvived;

    // --- Events ---
    event BadgeMinted(address indexed wallet, uint256 indexed tokenId, Rank rank);
    event RankUpgraded(address indexed wallet, uint256 indexed tokenId, Rank from, Rank to);
    event RankDemoted(address indexed wallet, Rank from, Rank to);
    event PvPSet(address indexed pvp);

    // --- Errors ---
    error Soulbound();
    error OnlyCurve();
    error OnlyPvP();
    error AlreadyHasBadge();
    error NoBadge();
    error CurveAlreadySet();
    error PvPAlreadySet();

    constructor(address initialOwner) Ownable(initialOwner) {}

    modifier onlyCurve() {
        // The curve is the only contract that can mutate badge state; this isolates
        // reputation writes to the trading flow and prevents external manipulation.
        if (msg.sender != curve) revert OnlyCurve();
        _;
    }

    /// @notice One-shot curve binding. Done post-deploy to break the badge<>curve
    /// constructor cycle (curve needs badge address, badge needs curve address).
    function setCurve(address _curve) external onlyOwner {
        if (curve != address(0)) revert CurveAlreadySet();
        curve = _curve;
    }

    /// @notice One-shot PvP binding. Mirrors setCurve. Only the bound PvP contract may
    /// call demoteRank — keeps rank-down semantics tightly scoped to the raid system.
    function setPvP(address _pvp) external onlyOwner {
        if (pvp != address(0)) revert PvPAlreadySet();
        if (_pvp == address(0)) revert ZeroAddress();
        pvp = _pvp;
        emit PvPSet(_pvp);
    }

    modifier onlyPvP() {
        if (msg.sender != pvp) revert OnlyPvP();
        _;
    }

    /// @notice Demote the wallet's rank by one tier. CAVE is the floor (no-op).
    /// ANCIENT is protected against demotion entirely.
    function demoteRank(address wallet) external onlyPvP {
        uint256 tokenId = badgeOf[wallet];
        if (tokenId == 0) revert NoBadge();
        Rank current = rankOf[tokenId];
        if (current == Rank.CAVE) return;       // floor
        if (current == Rank.ANCIENT) return;    // immune
        Rank next = Rank(uint8(current) - 1);
        rankOf[tokenId] = next;
        emit RankDemoted(wallet, current, next);
    }

    // ----------------------------------------------------------------
    // Mint / rank
    // ----------------------------------------------------------------

    function mint(address to) external onlyCurve returns (uint256 tokenId) {
        // One badge per wallet is the whole point of soulbound — enforce strictly.
        if (badgeOf[to] != 0) revert AlreadyHasBadge();
        tokenId = nextTokenId++;
        badgeOf[to] = tokenId;
        ownerOf[tokenId] = to;
        rankOf[tokenId] = Rank.CAVE;
        emit BadgeMinted(to, tokenId, Rank.CAVE);
    }

    function rankUp(address wallet, Rank newRank) external onlyCurve {
        // Curve drives all rank transitions based on on-chain stats it owns.
        // Monotonicity is enforced so a buggy curve update can't demote a user mid-flight.
        uint256 tokenId = badgeOf[wallet];
        if (tokenId == 0) revert NoBadge();
        Rank current = rankOf[tokenId];
        if (uint8(newRank) <= uint8(current)) return; // idempotent no-op
        rankOf[tokenId] = newRank;
        emit RankUpgraded(wallet, tokenId, current, newRank);
    }

    /// @dev KING is the only rank that can be demoted (back to VETERAN) — the top-10
    /// volume table churns. We expose a curve-only setter that allows demotion to VETERAN.
    function demoteFromKing(address wallet) external onlyCurve {
        uint256 tokenId = badgeOf[wallet];
        if (tokenId == 0) revert NoBadge();
        if (rankOf[tokenId] != Rank.KING) return;
        rankOf[tokenId] = Rank.VETERAN;
        emit RankUpgraded(wallet, tokenId, Rank.KING, Rank.VETERAN);
    }

    // ----------------------------------------------------------------
    // Stat bumps (curve-only)
    // ----------------------------------------------------------------

    function bumpTradeCount(address wallet) external onlyCurve {
        tradeCount[wallet] += 1;
    }

    function bumpGraduationsWitnessed(address wallet) external onlyCurve {
        graduationsWitnessed[wallet] += 1;
    }

    function bumpRugsSurvived(address wallet) external onlyCurve {
        rugsSurvived[wallet] += 1;
    }

    // ----------------------------------------------------------------
    // Reads
    // ----------------------------------------------------------------

    function getRank(address wallet) external view returns (Rank) {
        uint256 tokenId = badgeOf[wallet];
        if (tokenId == 0) return Rank.CAVE; // ghost-default so callers don't have to branch
        return rankOf[tokenId];
    }

    function hasBadge(address wallet) external view returns (bool) {
        return badgeOf[wallet] != 0;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        // Static placeholder; the dapp resolves metadata per-rank off-chain.
        if (ownerOf[tokenId] == address(0)) revert NoBadge();
        Rank r = rankOf[tokenId];
        return string(abi.encodePacked("ipfs://placeholder/", _rankToString(r), ".json"));
    }

    function _rankToString(Rank r) internal pure returns (string memory) {
        if (r == Rank.CAVE) return "0";
        if (r == Rank.TRENCH) return "1";
        if (r == Rank.CURSED_HUNTER) return "2";
        if (r == Rank.VETERAN) return "3";
        if (r == Rank.KING) return "4";
        return "5";
    }

    // ----------------------------------------------------------------
    // ERC-721 transfer surface — all reverts (soulbound)
    // ----------------------------------------------------------------

    function transferFrom(address, address, uint256) external pure {
        // Reverting here is the entire point of the soulbound design — reputation is
        // tied to the wallet that earned it and cannot be laundered or sold.
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert Soulbound();
    }

    function approve(address, uint256) external pure {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) external pure {
        revert Soulbound();
    }

    function getApproved(uint256) external pure returns (address) {
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function balanceOf(address wallet) external view returns (uint256) {
        return badgeOf[wallet] == 0 ? 0 : 1;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        // ERC-721 = 0x80ac58cd, ERC-165 = 0x01ffc9a7
        return interfaceId == 0x80ac58cd || interfaceId == 0x01ffc9a7;
    }
}
