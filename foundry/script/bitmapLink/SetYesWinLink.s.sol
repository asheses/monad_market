// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MonadLinkScript, console2} from "./MonadLinkScript.sol";
import {Market} from "../../src/bitmapLink/Market.sol";

contract SetYesWinLink is MonadLinkScript {
    function run() external {
        uint256 key = oracleKey();
        address marketAddress = vm.envAddress("MARKET_ADDRESS");
        address oracle = vm.envAddress("ORACLE_ADDRESS");
        require(marketAddress.code.length > 0, "MARKET_ADDRESS must be deployed");
        require(oracle == vm.addr(key), "PRIVATE_KEY must belong to ORACLE_ADDRESS");

        vm.startBroadcast(key);
        Market(marketAddress).setMarketState(1); // 1 = YES wins
        vm.stopBroadcast();
        console2.log("MARKET_ADDRESS=", marketAddress);
        console2.log("MARKET_STATE=1 (YES_WIN)");
    }
}
