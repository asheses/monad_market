// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MonadScript, console2} from "./MonadScript.sol";
import {TestUSDC} from "../../src/test/TestUSDC.sol";
import {Vault} from "../../src/bitmap/Vault.sol";
import {MarketFactory} from "../../src/bitmap/MarketFactory.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract DeployBitmap is MonadScript {
    function run() external returns (Vault vault, MarketFactory factory) {
        uint256 key = deployerKey();
        address usdc = vm.envAddress("USDC_ADDRESS");
        require(usdc.code.length > 0, "USDC_ADDRESS must be deployed");
        require(TestUSDC(usdc).decimals() == 6, "USDC must have 6 decimals");

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

        require(vault.owner() == vm.addr(key) && factory.owner() == vm.addr(key), "Owner mismatch");
        require(vault.USDCAddress() == usdc && vault.marketFactory() == address(factory), "Vault wiring mismatch");
        require(address(factory.vault()) == address(vault), "Factory wiring mismatch");
        console2.log("USDC_ADDRESS=", usdc);
        console2.log("VAULT_ADDRESS=", address(vault));
        console2.log("FACTORY_ADDRESS=", address(factory));
        console2.log("VAULT_IMPLEMENTATION=", address(vaultImpl));
        console2.log("FACTORY_IMPLEMENTATION=", address(factoryImpl));
        console2.log("MARKET_IMPLEMENTATION=", factory.marketImplementation());
    }
}
