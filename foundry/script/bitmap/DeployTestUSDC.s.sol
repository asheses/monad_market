// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MonadScript, console2} from "./MonadScript.sol";
import {TestUSDC} from "../../src/test/TestUSDC.sol";

contract DeployTestUSDC is MonadScript {
    function run() external returns (TestUSDC token) {
        uint256 key = deployerKey();
        vm.startBroadcast(key);
        token = new TestUSDC();
        vm.stopBroadcast();
        console2.log("USDC_ADDRESS=", address(token));
    }
}
