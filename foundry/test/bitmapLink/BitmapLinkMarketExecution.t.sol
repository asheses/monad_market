// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Market} from "../../src/bitmapLink/Market.sol";
import {MarketFactory} from "../../src/bitmapLink/MarketFactory.sol";
import {Vault} from "../../src/bitmapLink/Vault.sol";
import {ScenarioUSDC} from "../bitmap/BitmapMarketScenario.t.sol";

/// @notice Deterministic regressions mirrored by run_receipt_scenarios.cjs.
/// Actual transaction gas/fees are measured by that script, not these tests.
contract BitmapLinkMarketExecutionTest is Test {
    uint96 private constant U = 1_000_000;
    address private b = address(0xB);
    address private c = address(0xC);
    address private d = address(0xD);
    address private f = address(0xF);
    ScenarioUSDC private usdc;
    Vault private vault;
    Market private market;

    function setUp() public {
        usdc = new ScenarioUSDC();
        vault =
            Vault(address(new ERC1967Proxy(address(new Vault()), abi.encodeCall(Vault.initialize, (address(usdc))))));
        MarketFactory factory = MarketFactory(
            address(new ERC1967Proxy(address(new MarketFactory()), abi.encodeCall(MarketFactory.initialize, ())))
        );
        vault.setMarketFactory(address(factory));
        factory.setVault(address(vault));
        market = Market(factory.createMarket(address(this), 100, 5000));
        address[4] memory actors = [b, c, d, f];
        for (uint256 i; i < actors.length; ++i) {
            usdc.mint(actors[i], 1000 * U);
            vm.startPrank(actors[i]);
            usdc.approve(address(vault), 1000 * U);
            vault.deposit(1000 * U);
            vm.stopPrank();
        }
    }

    function testBudgetBuyYesAcrossPricesWithPartialFillAndUnspentBudget() public {
        _budget(true);
    }

    function testBudgetBuyNoAcrossPricesWithPartialFillAndUnspentBudget() public {
        _budget(false);
    }

    function testBudgetBuyYesMinSharesRevertsAllIntermediateFills() public {
        _budgetRevert(true);
    }

    function testBudgetBuyNoMinSharesRevertsAllIntermediateFills() public {
        _budgetRevert(false);
    }

    function testSellYesAcrossPricesAndMinProceedsRollback() public {
        _crossSell(true);
    }

    function testSellNoAcrossPricesAndMinProceedsRollback() public {
        _crossSell(false);
    }

    function _asks(bool yes) private {
        vm.startPrank(b);
        market.splitUSDC(200 * U);
        market.orderInsert(40, 100 * U, 0, false, yes, Market.OrderType.Limit);
        vm.stopPrank();
        vm.startPrank(c);
        market.splitUSDC(200 * U);
        market.orderInsert(50, 100 * U, 0, false, yes, Market.OrderType.Limit);
        vm.stopPrank();
    }

    function _budget(bool yes) private {
        _asks(yes);
        _buyAndAssert(yes);
        // Only 0.975125 shares remain. A budget is a maximum, not a promise to spend it.
        vm.prank(d);
        market.buyUSDCAmount(10 * U, yes, 975125, Market.OrderType.Market, 0);
        assertEq(vault.balances(d), 909_510_002, "second buy spends only 0.489999");
        _selected(d, yes, 200 * U, 0);
        _selected(c, yes, 100 * U, 0);
        assertEq(vault.balances(c), 850_124_998, "per-fill floors preserved");
        assertEq(market.marketFeeReceived(), 245000);
        _conserved(400 * U);
        bytes32 beforeState = _fingerprint();
        vm.prank(d);
        vm.expectRevert(bytes("Insufficient output amount"));
        market.buyUSDCAmount(10 * U, yes, U, Market.OrderType.Market, 0);
        assertEq(_fingerprint(), beforeState, "empty-book failed buy has no side effects");
    }

    function _buyAndAssert(bool yes) private {
        vm.prank(d);
        market.buyUSDCAmount(90 * U, yes, 199 * U, Market.OrderType.Market, 0);
        assertEq(vault.balances(d), 910_000_001, "budget dust stays available");
        assertEq(vault.balances(b), 840_120_000, "100@40 principal + rebate");
        assertEq(vault.balances(c), 849_636_218, "99.024875@50 principal + rebate");
        _selected(d, yes, 199_024_875, 0);
        _selected(b, yes, 100 * U, 0);
        _selected(c, yes, 100 * U, 975125);
        assertEq(market.marketFeeReceived(), 243781);
        _conserved(400 * U);
    }

    function _budgetRevert(bool yes) private {
        _asks(yes);
        bytes32 beforeState = _fingerprint();
        vm.prank(d);
        vm.expectRevert(bytes("Insufficient output amount"));
        market.buyUSDCAmount(90 * U, yes, 200 * U, Market.OrderType.Market, 0);
        assertEq(_fingerprint(), beforeState, "cash, fees, shares and both books fully rolled back");
        // The same depth remains executable after the failed transaction.
        _buyAndAssert(yes);
    }

    function _crossSell(bool yes) private {
        vm.startPrank(b);
        market.orderInsert(45, 100 * U, 0, true, yes, Market.OrderType.Limit);
        market.orderInsert(40, 200 * U, 0, true, yes, Market.OrderType.Limit);
        vm.stopPrank();
        vm.startPrank(c);
        market.orderInsert(45, 150 * U, 0, true, yes, Market.OrderType.Limit);
        market.orderInsert(42, 100 * U, 0, true, yes, Market.OrderType.Limit);
        vm.stopPrank();
        vm.prank(f);
        market.splitUSDC(400 * U);
        bytes32 beforeState = _fingerprint();
        vm.prank(f);
        vm.expectRevert(bytes("Insufficient output amount"));
        market.sellShares{gas: 2_000_000}(300 * U, yes, 133 * U, Market.OrderType.Market, 0);
        assertEq(_fingerprint(), beforeState, "failed sale rolls back all three fills");
        vm.prank(f);
        market.sellShares{gas: 2_000_000}(300 * U, yes, 132 * U, Market.OrderType.Market, 0);
        assertEq(vault.balances(f), 732_759_450, "133.5 principal minus 0.740550 fee");
        assertEq(vault.balances(b), 875_123_750);
        assertEq(vault.balances(c), 890_746_525);
        _selected(f, yes, 100 * U, 0);
        _selected(b, yes, 100 * U, 0);
        _selected(c, yes, 200 * U, 0);
        (uint96 bDeposit,,,,) = market.traderInfos(b);
        (uint96 cDeposit,,,,) = market.traderInfos(c);
        assertEq(bDeposit, 80 * U, "B lower bid untouched");
        assertEq(cDeposit, 21 * U, "C has remaining 50@42");
        assertEq(market.marketFeeReceived(), 370275);
        _conserved(400 * U);
        vm.prank(f);
        market.sellShares{gas: 2_000_000}(100 * U, yes, 40 * U, Market.OrderType.Market, 0);
        assertEq(vault.balances(f), 773_517_650, "50@42 + 50@40 net proceeds");
        _selected(f, yes, 0, 0);
        _selected(b, yes, 150 * U, 0);
        _selected(c, yes, 250 * U, 0);
        assertEq(market.marketFeeReceived(), 491175);
        _conserved(400 * U);
    }

    function _selected(address who, bool yes, uint96 free, uint96 locked) private view {
        (, uint96 y, uint96 yl, uint96 n, uint96 nl) = market.traderInfos(who);
        assertEq(yes ? y : n, free, "selected free shares");
        assertEq(yes ? yl : nl, locked, "selected locked shares");
    }

    function _conserved(uint256 backing) private view {
        address[4] memory actors = [b, c, d, f];
        uint256 liabilities = backing + market.marketFeeReceived();
        uint256 ys;
        uint256 ns;
        for (uint256 i; i < actors.length; ++i) {
            (uint96 dep, uint96 y, uint96 yl, uint96 n, uint96 nl) = market.traderInfos(actors[i]);
            liabilities += vault.balances(actors[i]) + dep;
            ys += y + yl;
            ns += n + nl;
            assertEq(usdc.balanceOf(actors[i]), 0);
        }
        assertEq(ys, backing);
        assertEq(ns, backing);
        assertEq(usdc.balanceOf(address(vault)), 4000 * U);
        assertEq(liabilities, 4000 * U);
    }

    // Read-only adapter to the same Market storage layout as the mainline test.
    // Checks headers, bitmap, best prices, all touched orders and participant accounts.
    function _fingerprint() private view returns (bytes32 h) {
        for (uint256 slot; slot <= 410; ++slot) {
            h = keccak256(abi.encode(h, vm.load(address(market), bytes32(slot))));
        }
        address[4] memory actors = [b, c, d, f];
        for (uint256 i; i < actors.length; ++i) {
            (uint96 dep, uint96 y, uint96 yl, uint96 n, uint96 nl) = market.traderInfos(actors[i]);
            h = keccak256(abi.encode(h, vault.balances(actors[i]), usdc.balanceOf(actors[i]), dep, y, yl, n, nl));
        }
        for (uint256 side; side < 2; ++side) {
            for (uint256 price = 40; price <= 50; ++price) {
                uint256 slot = (side == 0 ? 5 : 208) + 2 * price;
                uint256 length = uint256(vm.load(address(market), bytes32(slot)));
                uint256 base = uint256(keccak256(abi.encode(slot)));
                for (uint256 j; j < length * 2; ++j) {
                    h = keccak256(abi.encode(h, vm.load(address(market), bytes32(base + j))));
                }
            }
        }
        h = keccak256(abi.encode(h, usdc.balanceOf(address(vault)), vault.totalMarketFeeReceived()));
    }
}
