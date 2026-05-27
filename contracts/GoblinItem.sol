// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./utils/Ownable.sol";

/// @title GoblinItem
/// @notice Minimal hand-rolled ERC-1155 for PvP loot. Items are typed (Weapon|Armor) and
/// rarity-tiered (Trash|Busted|Cursed|Legendary). Token id encodes both:
///   id = (uint256(type) << 8) | uint256(rarity)  =>  8 distinct ids.
/// Minting is restricted to addresses owner explicitly authorizes (GoblinQuest, GoblinPvP).
contract GoblinItem is Ownable {
    // --- Type/rarity ---
    enum ItemType { Weapon, Armor }
    enum Rarity   { Trash, Busted, Cursed, Legendary }

    // --- ERC-1155 storage ---
    // balances[id][owner] => amount.
    mapping(uint256 => mapping(address => uint256)) private _balances;
    // operator approvals: owner => operator => approved.
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    // --- Minter authorization ---
    mapping(address => bool) public minters;

    // --- Metadata ---
    string public baseURI;

    // --- Events (ERC-1155 standard) ---
    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values);
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);
    event URI(string value, uint256 indexed id);

    // --- Custom events ---
    event MinterAdded(address indexed minter);
    event MinterRemoved(address indexed minter);
    event BaseURIUpdated(string newBase);

    // --- Errors ---
    error NotMinter();
    error LengthMismatch();
    error InsufficientBalance();
    error NotAuthorized();
    error TransferToZero();
    error ReceiverRejected();
    error ZeroBatchAddress();

    constructor(address initialOwner) Ownable(initialOwner) {
        // baseURI defaults to the placeholder used everywhere else in the project until
        // the team pins an IPFS CID for the loot collection.
        baseURI = "ipfs://placeholder/items/";
    }

    // ----------------------------------------------------------------
    // Admin
    // ----------------------------------------------------------------
    function addMinter(address m) external onlyOwner {
        // Owner explicitly opt-in adds GoblinQuest and GoblinPvP post-deploy. Kept simple:
        // no two-step here because revocation is harmless (only blocks future mints).
        if (m == address(0)) revert ZeroAddress();
        if (!minters[m]) {
            minters[m] = true;
            emit MinterAdded(m);
        }
    }

    function removeMinter(address m) external onlyOwner {
        if (minters[m]) {
            minters[m] = false;
            emit MinterRemoved(m);
        }
    }

    function setBaseURI(string calldata newBase) external onlyOwner {
        // URI template is mutable so we can pin a final CID after content freeze.
        baseURI = newBase;
        emit BaseURIUpdated(newBase);
    }

    // ----------------------------------------------------------------
    // Mint / burn
    // ----------------------------------------------------------------
    function mint(address to, uint256 id, uint256 amount) external {
        if (!minters[msg.sender]) revert NotMinter();
        if (to == address(0)) revert TransferToZero();
        _balances[id][to] += amount;
        emit TransferSingle(msg.sender, address(0), to, id, amount);
        _doSafeTransferAcceptanceCheck(msg.sender, address(0), to, id, amount, "");
    }

    /// @notice Burn from `from`. Callable by `from` directly or by an approved operator —
    /// this lets GoblinPvP burn weapons/armor during PvP after the holder approves it.
    function burn(address from, uint256 id, uint256 amount) external {
        if (from != msg.sender && !_operatorApprovals[from][msg.sender]) revert NotAuthorized();
        uint256 bal = _balances[id][from];
        if (bal < amount) revert InsufficientBalance();
        unchecked { _balances[id][from] = bal - amount; }
        emit TransferSingle(msg.sender, from, address(0), id, amount);
    }

    // ----------------------------------------------------------------
    // ERC-1155 surface
    // ----------------------------------------------------------------
    function balanceOf(address account, uint256 id) external view returns (uint256) {
        return _balances[id][account];
    }

    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids)
        external
        view
        returns (uint256[] memory out)
    {
        if (accounts.length != ids.length) revert LengthMismatch();
        out = new uint256[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            out[i] = _balances[ids[i]][accounts[i]];
        }
    }

    function setApprovalForAll(address operator, bool approved) external {
        // Mirrors ERC-1155 semantics — operator gets blanket approval over all ids.
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address account, address operator) external view returns (bool) {
        return _operatorApprovals[account][operator];
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external {
        if (from != msg.sender && !_operatorApprovals[from][msg.sender]) revert NotAuthorized();
        if (to == address(0)) revert TransferToZero();
        uint256 bal = _balances[id][from];
        if (bal < amount) revert InsufficientBalance();
        unchecked { _balances[id][from] = bal - amount; }
        _balances[id][to] += amount;
        emit TransferSingle(msg.sender, from, to, id, amount);
        _doSafeTransferAcceptanceCheck(msg.sender, from, to, id, amount, data);
    }

    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) external {
        if (ids.length != amounts.length) revert LengthMismatch();
        if (from != msg.sender && !_operatorApprovals[from][msg.sender]) revert NotAuthorized();
        if (to == address(0)) revert TransferToZero();
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            uint256 amount = amounts[i];
            uint256 bal = _balances[id][from];
            if (bal < amount) revert InsufficientBalance();
            unchecked { _balances[id][from] = bal - amount; }
            _balances[id][to] += amount;
        }
        emit TransferBatch(msg.sender, from, to, ids, amounts);
        _doSafeBatchTransferAcceptanceCheck(msg.sender, from, to, ids, amounts, data);
    }

    function uri(uint256 id) external view returns (string memory) {
        return string(abi.encodePacked(baseURI, _toString(id), ".json"));
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        // ERC-1155 = 0xd9b67a26, ERC-1155 metadata = 0x0e89341c, ERC-165 = 0x01ffc9a7.
        return interfaceId == 0xd9b67a26 || interfaceId == 0x0e89341c || interfaceId == 0x01ffc9a7;
    }

    // ----------------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------------

    /// @notice Encode a (type, rarity) pair to a token id. Exposed so off-chain consumers
    /// (indexer, tests, frontend) don't have to reimplement the encoding.
    function makeId(ItemType t, Rarity r) external pure returns (uint256) {
        return (uint256(uint8(t)) << 8) | uint256(uint8(r));
    }

    function decodeId(uint256 id) external pure returns (ItemType t, Rarity r) {
        t = ItemType(uint8(id >> 8));
        r = Rarity(uint8(id & 0xff));
    }

    function _doSafeTransferAcceptanceCheck(
        address operator,
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes memory data
    ) internal {
        // Only invoke the callback on contracts; EOAs always accept.
        if (to.code.length == 0) return;
        try IERC1155Receiver(to).onERC1155Received(operator, from, id, amount, data) returns (bytes4 sel) {
            if (sel != IERC1155Receiver.onERC1155Received.selector) revert ReceiverRejected();
        } catch {
            revert ReceiverRejected();
        }
    }

    function _doSafeBatchTransferAcceptanceCheck(
        address operator,
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory amounts,
        bytes memory data
    ) internal {
        if (to.code.length == 0) return;
        try IERC1155Receiver(to).onERC1155BatchReceived(operator, from, ids, amounts, data) returns (bytes4 sel) {
            if (sel != IERC1155Receiver.onERC1155BatchReceived.selector) revert ReceiverRejected();
        } catch {
            revert ReceiverRejected();
        }
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 j = v;
        uint256 len;
        while (j != 0) { len++; j /= 10; }
        bytes memory b = new bytes(len);
        while (v != 0) { len--; b[len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }
}

interface IERC1155Receiver {
    function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes calldata data)
        external returns (bytes4);
    function onERC1155BatchReceived(address operator, address from, uint256[] calldata ids, uint256[] calldata values, bytes calldata data)
        external returns (bytes4);
}
