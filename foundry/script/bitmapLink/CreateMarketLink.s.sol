// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MonadLinkScript, console2} from "./MonadLinkScript.sol";
import {MarketFactory} from "../../src/bitmapLink/MarketFactory.sol";

contract CreateMarketLink is MonadLinkScript {
    function run() external returns (address market) {
        uint256 key = deployerKey();
        address factoryAddress = vm.envAddress("FACTORY_ADDRESS");
        address oracle = vm.envAddress("ORACLE_ADDRESS");
        require(factoryAddress.code.length > 0, "FACTORY_ADDRESS must be deployed");
        require(oracle != address(0), "ORACLE_ADDRESS is required");

        MarketFactory factory = MarketFactory(factoryAddress);
        require(factory.owner() == vm.addr(key), "PRIVATE_KEY must belong to Factory owner");
        uint256 fee = vm.envUint("TAKER_FEE_RATE");
        uint256 rebate = vm.envUint("MAKER_REBATE_RATE");
        require(fee <= 10_000 && rebate <= 10_000, "Rates must be 0..10000");

        vm.startBroadcast(key);
        market = factory.createMarket(oracle, uint96(fee), uint96(rebate));
        vm.stopBroadcast();

        console2.log("MARKET_ADDRESS=", market);
        console2.log("ORACLE_ADDRESS=", oracle);
    }
}
