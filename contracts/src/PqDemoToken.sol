// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ERC20 } from "solady/tokens/ERC20.sol";

// DISCLAIMER: demonstration code only. Unaudited and experimental; not for mainnet or real funds. Provided as is,
// without warranty of any kind.

/// @title PqDemoToken
/// @notice Free-mint testnet token so demo accounts have something to manage besides ETH. No value.
contract PqDemoToken is ERC20 {
    uint256 public constant MAX_MINT = 1_000 ether;

    error MintTooLarge();

    function name() public pure override returns (string memory) {
        return "PQ Demo Dollar";
    }

    function symbol() public pure override returns (string memory) {
        return "pqUSD";
    }

    function mint(uint256 amount) external {
        if (amount > MAX_MINT) revert MintTooLarge();
        _mint(msg.sender, amount);
    }
}
