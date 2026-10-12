// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Permissionless test token; never use as production collateral.
contract TestUSDC is ERC20 {
    uint256 public constant MINT_AMOUNT = 1000 * 10 ** 6;
    error BalanceNotBelowThreshold();

    constructor() ERC20("Test USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Adds 1000 USDC to the caller when their wallet holds less than 1000.
    function mint() external {
        if (balanceOf(msg.sender) >= MINT_AMOUNT) revert BalanceNotBelowThreshold();
        _mint(msg.sender, MINT_AMOUNT);
    }
}
