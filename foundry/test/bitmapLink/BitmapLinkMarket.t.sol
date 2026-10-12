// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";

import {Market} from "../../src/bitmapLink/Market.sol";
import {MarketFactory} from "../../src/bitmapLink/MarketFactory.sol";
import {Vault} from "../../src/bitmapLink/Vault.sol";

contract BitmapLinkMarketTest is Test {
    uint96 internal constant ONE = 1_000_000;

    address internal owner = address(0xA11CE);
    address internal oracle = address(0x0A11CE);
    address internal maker = address(0xB0B);
    address internal taker = address(0xCAFE);

    ERC20Mock internal usdc;
    Vault internal vault;
    MarketFactory internal factory;
    Market internal market;

    function setUp() public {
        usdc = new ERC20Mock();

        Vault vaultImpl = new Vault();
        vault = Vault(
            address(
                new ERC1967Proxy(
                    address(vaultImpl),
                    abi.encodeCall(Vault.initialize, (address(usdc)))
                )
            )
        );

        MarketFactory factoryImpl = new MarketFactory();
        factory = MarketFactory(
            address(
                new ERC1967Proxy(
                    address(factoryImpl),
                    abi.encodeCall(MarketFactory.initialize, ())
                )
            )
        );

        vault.transferOwnership(owner);
        factory.transferOwnership(owner);

        vm.startPrank(owner);
        vault.setMarketFactory(address(factory));
        factory.setVault(address(vault));
        address marketAddress = factory.createMarket(oracle, 100, 5_000);
        vm.stopPrank();

        market = Market(marketAddress);

        _fund(maker, 1_000 * ONE);
        _fund(taker, 1_000 * ONE);
    }

    // A drained bucket must not leave the same node in both active and free lists.
    function testConsumedBucketClearsHeadAndReusesNode() public {
        vm.startPrank(maker);
        market.splitUSDC(20 * ONE);
        market.orderInsert(60, 2 * ONE, 0, false, true, Market.OrderType.Limit);
        vm.stopPrank();
        vm.prank(taker);
        market.orderInsert(60, 2 * ONE, 0, true, true, Market.OrderType.Limit);
        (uint32 head, uint32 tail, uint32 free) = market.yesOrderBook(60);
        assertEq(head, 0, "consumed bucket head must be zero");
        assertEq(free, 1, "consumed node available for reuse");
        // Empty buckets may retain a stale tail: insertion overwrites it.
        vm.prank(maker);
        market.orderInsert(60, 3 * ONE, 0, false, true, Market.OrderType.Limit);
        (head, tail, free) = market.yesOrderBook(60);
        assertEq(head, 1, "reuses released node");
        assertEq(tail, head, "new singleton tail equals head");
        assertEq(free, 0, "reused node leaves free list");
        vm.prank(taker);
        market.orderInsert(60, 3 * ONE, 0, true, true, Market.OrderType.Limit);
        (, uint96 yesAmount,,,) = market.traderInfos(taker);
        assertEq(yesAmount, 5 * ONE, "both orders filled exactly once");
        (head,, free) = market.yesOrderBook(60);
        assertEq(head, 0, "reused bucket drained");
        assertEq(free, 1, "node released again");
    }

    function testFactoryCreatesRegisteredMarket() public view {
        assertTrue(vault.markets(address(market)));
        assertEq(address(market.vault()), address(vault));
        assertEq(market.oracle(), oracle);
    }

    function testOrderBatchInsertAllowsBuyOnlyAndSellOnlyBatches() public {
        vm.startPrank(maker);
        Market.OrderBatch[] memory buyOrders = new Market.OrderBatch[](2);
        buyOrders[0] = Market.OrderBatch({
            prices: 40,
            shareAmounts: 10 * ONE,
            endTimestamps: 0,
            isBuy: true,
            isYes: true,
            orderType: Market.OrderType.Limit
        });
        buyOrders[1] = Market.OrderBatch({
            prices: 30,
            shareAmounts: 10 * ONE,
            endTimestamps: 0,
            isBuy: true,
            isYes: false,
            orderType: Market.OrderType.Limit
        });
        market.orderBatchInsert{gas: 2_000_000}(buyOrders);

        Market.OrderBatch[] memory sellOrders = new Market.OrderBatch[](2);
        sellOrders[0] = Market.OrderBatch({
            prices: 60,
            shareAmounts: 5 * ONE,
            endTimestamps: 0,
            isBuy: false,
            isYes: true,
            orderType: Market.OrderType.Limit
        });
        sellOrders[1] = Market.OrderBatch({
            prices: 70,
            shareAmounts: 5 * ONE,
            endTimestamps: 0,
            isBuy: false,
            isYes: false,
            orderType: Market.OrderType.Limit
        });
        market.splitUSDC(5 * ONE);
        market.orderBatchInsert{gas: 2_000_000}(sellOrders);
        vm.stopPrank();
    }

    function testOrderBatchRejectsInternallyCrossedSameBook() public {
        Market.OrderBatch[] memory orders = new Market.OrderBatch[](2);
        orders[0] = Market.OrderBatch({
            prices: 70,
            shareAmounts: 2 * ONE,
            endTimestamps: 0,
            isBuy: true,
            isYes: true,
            orderType: Market.OrderType.Limit
        });
        orders[1] = Market.OrderBatch({
            prices: 60,
            shareAmounts: 2 * ONE,
            endTimestamps: 0,
            isBuy: false,
            isYes: true,
            orderType: Market.OrderType.Limit
        });

        vm.prank(maker);
        vm.expectRevert(bytes("invalid price"));
        market.orderBatchInsert{gas: 2_000_000}(orders);
    }

    function testExpiredBestSellCleanupGasBound() public {
        vm.startPrank(maker);
        market.splitUSDC(20 * ONE);
        market.orderInsert(60, 2 * ONE, uint48(block.timestamp + 1), false, true, Market.OrderType.Limit);
        market.orderInsert(60, 2 * ONE, uint48(block.timestamp + 1), false, true, Market.OrderType.Limit);
        market.orderInsert(60, 2 * ONE, uint48(block.timestamp + 1), false, true, Market.OrderType.Limit);
        market.orderInsert(60, 2 * ONE, uint48(block.timestamp + 1), false, true, Market.OrderType.Limit);
        vm.stopPrank();

        vm.warp(block.timestamp + 2);

        uint256 gasBefore = gasleft();
        vm.prank(taker);
        market.orderInsert(50, 2 * ONE, 0, true, true, Market.OrderType.Limit);
        uint256 gasUsed = gasBefore - gasleft();

        console2.log("expired best sell cleanup gas", gasUsed);
        assertLt(gasUsed, 650_000);
    }

    function testBuyUSDCAmountFullFillUsesWholeOrderAmount() public {
        vm.startPrank(maker);
        market.splitUSDC(10 * ONE);
        market.orderInsert(60, 2 * ONE, 0, false, true, Market.OrderType.Limit);
        vm.stopPrank();

        uint96 usdcIn = 1_300_000;

        uint256 beforeBalance = vault.balances(maker);
        vm.prank(taker);
        market.buyUSDCAmount(usdcIn, true, 2 * ONE, Market.OrderType.Market, 0);
        uint256 afterBalance = vault.balances(maker);

        assertGt(afterBalance, beforeBalance);
    }

    function testBuyUSDCAmountPartialFillDoesNotUnderflow() public {
        vm.startPrank(maker);
        market.splitUSDC(10 * ONE);
        market.orderInsert(60, 10 * ONE, 0, false, true, Market.OrderType.Limit);
        vm.stopPrank();

        uint96 partialUsdcIn = 1_300_000;

        vm.prank(taker);
        market.buyUSDCAmount(partialUsdcIn, true, 1 * ONE, Market.OrderType.Market, 0);
    }

    function _fund(address account, uint256 amount) internal {
        usdc.mint(account, amount);
        vm.startPrank(account);
        usdc.approve(address(vault), amount);
        vault.deposit(uint96(amount));
        vm.stopPrank();
    }
}
