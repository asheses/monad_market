// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MonadLinkScript, console2} from "./MonadLinkScript.sol";
import {TestUSDC} from "../../src/test/TestUSDC.sol";
import {Vault} from "../../src/bitmapLink/Vault.sol";
import {Market} from "../../src/bitmapLink/Market.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PlaceOrdersLink is MonadLinkScript {
    uint96 private constant USDC = 1_000_000;

    function run() external {
        uint256 key = deployerKey();
        address marketAddress = vm.envAddress("MARKET_ADDRESS");
        address usdcAddress = vm.envAddress("USDC_ADDRESS");
        Market market = Market(marketAddress);
        Vault vault = Vault(address(market.vault()));
        require(marketAddress.code.length > 0, "MARKET_ADDRESS must be deployed");

        // The six orders need 70 YES shares and 29.8 USDC for the buy-side lock.
        uint96 depositAmount = 100 * USDC;
        uint96 splitAmount = 70 * USDC;
        Market.OrderBatch[] memory orders = new Market.OrderBatch[](6);
        orders[0] = Market.OrderBatch(46, 10 * USDC, 0, false, true, Market.OrderType.Limit);
        orders[1] = Market.OrderBatch(47, 20 * USDC, 0, false, true, Market.OrderType.Limit);
        orders[2] = Market.OrderBatch(48, 40 * USDC, 0, false, true, Market.OrderType.Limit);
        orders[3] = Market.OrderBatch(44, 10 * USDC, 0, true, true, Market.OrderType.Limit);
        orders[4] = Market.OrderBatch(43, 20 * USDC, 0, true, true, Market.OrderType.Limit);
        orders[5] = Market.OrderBatch(42, 40 * USDC, 0, true, true, Market.OrderType.Limit);

        vm.startBroadcast(key);
        // TestUSDC is the permissionless test collateral deployed by DeployTestUSDC.
        if (IERC20(usdcAddress).balanceOf(vm.addr(key)) < depositAmount) {
            TestUSDC(usdcAddress).mint();
        }
        TestUSDC(usdcAddress).approve(address(vault), depositAmount);
        vault.deposit(depositAmount);
        market.splitUSDC(splitAmount);
        market.orderBatchInsert{gas: 2_000_000}(orders);
        vm.stopBroadcast();

        console2.log("ORDER_TRADER=", vm.addr(key));
        console2.log("DEPOSIT_USDC=", depositAmount);
        console2.log("SPLIT_USDC=", splitAmount);
        console2.log("YES_SELL=46:10,47:20,48:40");
        console2.log("YES_BUY=44:10,43:20,42:40");
    }
}
