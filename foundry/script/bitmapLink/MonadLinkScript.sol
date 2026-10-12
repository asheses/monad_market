// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

abstract contract MonadLinkScript is Script {
    function deployerKey() internal view returns (uint256 key) {
        require(block.chainid == 10143, "Monad testnet only (10143)");
        key = vm.envUint("PRIVATE_KEY");
        require(key != 0, "PRIVATE_KEY is required");
    }

    function oracleKey() internal view returns (uint256 key) {
        require(block.chainid == 10143, "Monad testnet only (10143)");
        key = vm.envOr("ORACLE_PRIVATE_KEY", deployerKey());
        require(key != 0, "ORACLE_PRIVATE_KEY or PRIVATE_KEY is required");
    }
}
