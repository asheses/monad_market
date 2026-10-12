// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

abstract contract MonadScript is Script {
    function deployerKey() internal view returns (uint256 key) {
        require(block.chainid == 10143, "Monad testnet only (10143)");
        key = vm.envUint("PRIVATE_KEY");
        require(key != 0, "PRIVATE_KEY is required");
    }
}
