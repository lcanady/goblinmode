// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal reentrancy guard. Self-contained to avoid pulling OZ for one tiny primitive.
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status = _NOT_ENTERED;

    error Reentrancy();

    modifier nonReentrant() {
        // Using nonzero sentinels (1/2 instead of 0/1) keeps the storage slot warm,
        // which makes every call slightly cheaper than the canonical bool implementation.
        if (_status == _ENTERED) revert Reentrancy();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}
