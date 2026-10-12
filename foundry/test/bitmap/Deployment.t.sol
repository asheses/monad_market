// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TestUSDC} from "../../src/test/TestUSDC.sol";
import {DeployTestUSDC} from "../../script/bitmap/DeployTestUSDC.s.sol";
import {DeployBitmap} from "../../script/bitmap/DeployBitmap.s.sol";
import {CreateMarket} from "../../script/bitmap/CreateMarket.s.sol";
import {Vault} from "../../src/bitmap/Vault.sol";
import {MarketFactory} from "../../src/bitmap/MarketFactory.sol";
import {Market} from "../../src/bitmap/Market.sol";

contract DeploymentTest is Test {
    TestUSDC token;
    Vault vault;
    MarketFactory factory;
    address owner;
    address oracle = address(0xBEEF);

    function setUp() public {
        vm.chainId(10143);
        vm.setEnv("PRIVATE_KEY", "123456"); // Local test key only.
        owner = vm.addr(123456);
        token = new DeployTestUSDC().run();
        vm.setEnv("USDC_ADDRESS", vm.toString(address(token)));
        (vault, factory) = new DeployBitmap().run();
        vm.setEnv("FACTORY_ADDRESS", vm.toString(address(factory)));
        vm.setEnv("ORACLE_ADDRESS", vm.toString(oracle));
        vm.setEnv("TAKER_FEE_RATE", "100");
        vm.setEnv("MAKER_REBATE_RATE", "5000");
    }

    function testFaucetThresholdAndFixedIncrement() public {
        assertEq(token.decimals(), 6);
        assertEq(token.totalSupply(), 0);
        token.mint();
        assertEq(token.balanceOf(address(this)), 1000e6);
        vm.expectRevert(TestUSDC.BalanceNotBelowThreshold.selector);
        token.mint();
        token.transfer(address(1), 1);
        token.mint();
        assertEq(token.balanceOf(address(this)), 2000e6 - 1);
        vm.expectRevert(TestUSDC.BalanceNotBelowThreshold.selector);
        token.mint();
        vm.prank(address(1));
        token.mint();
        assertEq(token.balanceOf(address(1)), 1000e6 + 1);
    }

    function testDeploymentAndMarketDepositSplit() public {
        assertEq(vault.owner(), owner);
        assertEq(factory.owner(), owner);
        assertEq(vault.USDCAddress(), address(token));
        assertEq(vault.marketFactory(), address(factory));
        assertEq(address(factory.vault()), address(vault));
        Market market = Market(new CreateMarket().run());
        assertTrue(vault.markets(address(market)));
        assertEq(address(market.vault()), address(vault));
        assertEq(market.oracle(), oracle);
        assertEq(market.takerFeeRate(), 100);
        assertEq(market.makerRebateRate(), 5000);
        assertEq(market.marketState(), 0);
        token.mint();
        token.approve(address(vault), 100e6);
        vault.deposit(100e6);
        market.splitUSDC(10e6);
        assertEq(vault.balances(address(this)), 90e6);
        assertEq(token.balanceOf(address(vault)), 100e6);
        (, uint96 yes,, uint96 no,) = market.traderInfos(address(this));
        assertEq(yes, 10e6);
        assertEq(no, 10e6);
        vm.expectRevert();
        vault.initialize(address(token));
        vm.expectRevert();
        factory.initialize();
    }

    function testRejectWrongChain() public {
        DeployTestUSDC script = new DeployTestUSDC();
        vm.chainId(143);
        vm.expectRevert("Monad testnet only (10143)");
        script.run();
    }

    function testRejectWrongOwner() public {
        CreateMarket script = new CreateMarket();
        vm.setEnv("PRIVATE_KEY", "654321");
        vm.expectRevert("PRIVATE_KEY must belong to Factory owner");
        script.run();
    }

    function testRejectRateBeforeNarrowing() public {
        CreateMarket script = new CreateMarket();
        vm.setEnv("TAKER_FEE_RATE", vm.toString(uint256(type(uint96).max) + 1));
        vm.expectRevert("Rates must be 0..10000");
        script.run();
    }
}
