// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./Market.sol";
import "./Vault.sol";

contract MarketFactory is
    UUPSUpgradeable,
    Initializable,
    OwnableUpgradeable,
    ReentrancyGuard
{
    address public marketImplementation;//未来可能会有多种不同type、版本的market，到时候改成数组
    IVault public vault;

    event CreateMarket(
        address market,
        address oracle,
        uint96 feeRate,
        uint96 makerRebateRate
    );

    event SetVault(address vaultAddress);

    constructor() {
        _disableInitializers();
    }

    function initialize() public initializer {
        __Ownable_init(msg.sender);
        marketImplementation = address(new Market());
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setVault(address _vault) external onlyOwner {
        require(_vault != address(0), "Invalid vault address");
        vault = IVault(_vault);

        emit SetVault(_vault);
    }

    function createMarket(
        address oracle,
        uint96 feeRate,
        uint96 makerRebateRate
    ) external onlyOwner returns (address market) {
        require(address(vault) != address(0), "Vault not set");

        market = Clones.clone(marketImplementation);
        Market(market).initialize(
            address(vault),
            oracle,
            feeRate,
            makerRebateRate
        );

        vault.registerMarket(market);
        
        emit CreateMarket(market, oracle, feeRate, makerRebateRate);
    }
}
