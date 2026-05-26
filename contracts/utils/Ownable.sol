// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Ownable. We hand-roll this so the project ships with zero external deps,
/// keeping the audit surface small and the deployed bytecode lean.
abstract contract Ownable {
    address private _owner;
    address public pendingOwner;

    error NotOwner();
    error ZeroAddress();
    error NotPendingOwner();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed pendingOwner);

    constructor(address initialOwner) {
        // Allow address(0) bootstrap only via internal init; constructor enforces a real owner
        // so deployments cannot accidentally produce an ownerless contract.
        if (initialOwner == address(0)) revert ZeroAddress();
        _owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        // Centralizing the access check here keeps every privileged function uniform.
        if (msg.sender != _owner) revert NotOwner();
        _;
    }

    function owner() public view returns (address) {
        return _owner;
    }

    /// @notice L-1: two-step ownership transfer. Begins the handoff; ownership does not
    /// move until the new owner explicitly accepts via acceptOwnership().
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(_owner, newOwner);
    }

    /// @notice Finalizes a pending ownership transfer. Only the pendingOwner may call.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = _owner;
        _owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, msg.sender);
    }
}
