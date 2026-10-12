// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MonadScript, console2} from "./MonadScript.sol";
import {Vault} from "../../src/bitmap/Vault.sol";
import {MarketFactory} from "../../src/bitmap/MarketFactory.sol";
import {Market} from "../../src/bitmap/Market.sol";

contract CreateMarket is MonadScript {
    function run() external returns (address market) {
        uint256 key = deployerKey();
        address factoryAddress = vm.envAddress("FACTORY_ADDRESS");
        require(factoryAddress.code.length > 0, "FACTORY_ADDRESS must be deployed");
        MarketFactory factory = MarketFactory(factoryAddress);
        require(factory.owner() == vm.addr(key), "PRIVATE_KEY must belong to Factory owner");
        address oracle = vm.envAddress("ORACLE_ADDRESS");
        require(oracle != address(0), "ORACLE_ADDRESS is required");
        uint256 fee = vm.envUint("TAKER_FEE_RATE");
        uint256 rebate = vm.envUint("MAKER_REBATE_RATE");
        require(fee <= 10_000 && rebate <= 10_000, "Rates must be 0..10000");
        Vault vault = Vault(address(factory.vault()));
        require(address(vault).code.length > 0, "Factory vault not deployed");
        require(vault.marketFactory() == factoryAddress, "Vault/Factory mismatch");
        require(vault.USDCAddress() == vm.envAddress("USDC_ADDRESS"), "USDC mismatch");

        vm.startBroadcast(key);
        market = factory.createMarket(oracle, uint96(fee), uint96(rebate));
        vm.stopBroadcast();
        require(vault.markets(market), "Market not registered");
        require(address(Market(market).vault()) == address(vault), "Market vault mismatch");
        console2.log("MARKET_ADDRESS=", market);
        console2.log("VAULT_ADDRESS=", address(vault));
        console2.log("ORACLE_ADDRESS=", oracle);
    }
}
