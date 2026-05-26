// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GoblinToken
/// @notice Minimal fixed-supply ERC-20. Hand-rolled so each launched token is a tiny,
/// immutable, audit-friendly contract — no owner, no mint, no pause, no upgradeability.
/// Entire supply is minted once to the GoblinCurve at construction; from then on
/// the curve is the sole source of liquidity until graduation.
contract GoblinToken {
    // --- ERC-20 storage ---
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // --- Provenance (immutable so frontends/bots can trust on-chain origin) ---
    address public immutable creator;
    address public immutable curve;
    uint256 public immutable launchedAt;

    // --- Events ---
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // --- Errors (custom errors save gas vs require strings) ---
    error InsufficientBalance();
    error InsufficientAllowance();
    error TransferToZero();

    constructor(
        string memory _name,
        string memory _symbol,
        uint256 _supply,
        address _creator,
        address _curve
    ) {
        // Cache metadata so wallets and explorers can display it consistently forever.
        name = _name;
        symbol = _symbol;
        creator = _creator;
        curve = _curve;
        launchedAt = block.timestamp;

        // Mint entire supply to the curve. The curve holds inventory and trades against
        // virtual reserves — no token leaves the contract except through buy().
        totalSupply = _supply;
        balanceOf[_curve] = _supply;
        emit Transfer(address(0), _curve, _supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        // Standard ERC-20 transfer; the zero-address check prevents accidental burns
        // since we have no separate burn function.
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        // Plain approve (race-condition known) — kept simple for compatibility with all DEX UIs.
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        // Decrement allowance unless it's set to max — supporting infinite approval
        // is the de-facto standard for DEX integrations.
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            unchecked { allowance[from][msg.sender] = allowed - value; }
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        if (to == address(0)) revert TransferToZero();
        uint256 fromBal = balanceOf[from];
        if (fromBal < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = fromBal - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
