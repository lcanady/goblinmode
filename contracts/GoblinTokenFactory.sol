// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./GoblinToken.sol";

/// @title GoblinTokenFactory
/// @notice CREATE2 deployer for GoblinToken. Keeping the factory separate from the curve
/// lets us precompute addresses (for previews, bots, indexers) before the launch tx
/// actually lands — important for sniper-resistant UX on Monad's fast blocks.
contract GoblinTokenFactory {
    address public immutable curve;

    error OnlyCurve();
    error DeployFailed();

    event TokenDeployed(address indexed token, address indexed creator, string symbol);

    constructor(address _curve) {
        // Curve is set once at construction; one factory belongs to one curve forever.
        curve = _curve;
    }

    modifier onlyCurve() {
        // Only the curve may deploy — prevents random wallets from squatting symbols
        // or front-running creators by deploying a token at a predicted address.
        if (msg.sender != curve) revert OnlyCurve();
        _;
    }

    /// @dev Salt = keccak256(creator, symbol, timestamp). Including timestamp lets the
    /// same creator relaunch the same symbol later without address collision.
    function _salt(address creator, string memory symbol, uint256 timestamp)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(creator, symbol, timestamp));
    }

    function deploy(
        string memory name,
        string memory symbol,
        uint256 supply,
        address creator
    ) external onlyCurve returns (address token) {
        // Block.timestamp is included in the salt so the same (creator, symbol) pair
        // can be reused across different launches without CREATE2 collision.
        bytes32 salt = _salt(creator, symbol, block.timestamp);
        bytes memory bytecode = abi.encodePacked(
            type(GoblinToken).creationCode,
            abi.encode(name, symbol, supply, creator, curve)
        );
        assembly {
            token := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
        }
        if (token == address(0)) revert DeployFailed();
        emit TokenDeployed(token, creator, symbol);
    }

    /// @notice M-2: deterministic address prediction matching deploy() exactly.
    /// Callers must pass the same name/symbol/supply/creator/timestamp that deploy() will
    /// use; the returned address will equal the CREATE2 deployment address.
    function predictAddress(
        string memory name,
        string memory symbol,
        uint256 supply,
        address creator,
        uint256 timestamp
    ) external view returns (address) {
        bytes32 salt = _salt(creator, symbol, timestamp);
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(GoblinToken).creationCode,
                abi.encode(name, symbol, supply, creator, curve)
            )
        );
        return address(uint160(uint256(keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)
        ))));
    }
}
