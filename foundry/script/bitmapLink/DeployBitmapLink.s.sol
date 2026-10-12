// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MonadLinkScript, console2} from "./MonadLinkScript.sol";
import {Vault} from "../../src/bitmapLink/Vault.sol";
import {MarketFactory} from "../../src/bitmapLink/MarketFactory.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract DeployBitmapLink is MonadLinkScript {
    function run() external returns (Vault vault, MarketFactory factory) {
        uint256 key = deployerKey();
        address usdc = vm.envAddress("USDC_ADDRESS");
        require(usdc.code.length > 0, "USDC_ADDRESS must be deployed");

        vm.startBroadcast(key);
        Vault vaultImpl = new Vault();
        vault = Vault(address(new ERC1967Proxy(address(vaultImpl), abi.encodeCall(Vault.initialize, (usdc)))));
        MarketFactory factoryImpl = new MarketFactory();
        factory = MarketFactory(
            address(new ERC1967Proxy(address(factoryImpl), abi.encodeCall(MarketFactory.initialize, ())))
        );
        vault.setMarketFactory(address(factory));
        factory.setVault(address(vault));
        vm.stopBroadcast();

        console2.log("USDC_ADDRESS=", usdc);
        console2.log("VAULT_ADDRESS=", address(vault));
        console2.log("FACTORY_ADDRESS=", address(factory));
        console2.log("VAULT_IMPLEMENTATION=", address(vaultImpl));
        console2.log("FACTORY_IMPLEMENTATION=", address(factoryImpl));
    }
}
