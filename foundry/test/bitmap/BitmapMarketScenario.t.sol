// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Market} from "../../src/bitmap/Market.sol";
import {MarketFactory} from "../../src/bitmap/MarketFactory.sol";
import {Vault} from "../../src/bitmap/Vault.sol";

contract ScenarioUSDC is ERC20 {
    constructor() ERC20("Scenario USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice The documented B-I session, replayed independently for both outcomes.
/// Every transaction is followed by a full-account ledger and conservation check.
contract BitmapMarketScenarioTest is Test {
    uint96 private constant U = 1_000_000;
    uint48 private constant T0 = 1_800_000_000;
    uint256 private constant B = 0;
    uint256 private constant C = 1;
    uint256 private constant D = 2;
    uint256 private constant E = 3;
    uint256 private constant F = 4;
    uint256 private constant G = 5;
    uint256 private constant H = 6;
    uint256 private constant I = 7;
    // Market.TradeInfo now carries the maker's price-bucket order index.
    bytes32 private constant TRADE =
        keccak256("TradeInfo(address,address,uint96,uint32,uint96,uint96,bool,bool,uint256)");

    // Read-only layout adapter, checked against `forge inspect Market storage-layout`.
    // No vm.store/etch or modified Market implementation is used in this test.
    uint256 private constant VERSION_SLOT = 4;
    uint256 private constant YES_BOOK_SLOT = 5;
    uint256 private constant NO_BOOK_SLOT = 208;

    struct ExpectedAccount {
        uint256 cash;
        uint256 wallet;
        uint256 deposit;
        uint256 yes;
        uint256 yesLocked;
        uint256 no;
        uint256 noLocked;
        uint32 version;
    }

    struct ExpectedOrder {
        uint256 maker;
        uint8 price;
        uint96 remaining;
        uint48 expiry;
        uint32 version;
        bool buy;
        bool yes;
    }

    struct Fill {
        address maker;
        address taker;
        uint96 quantity;
        uint32 price;
        uint96 rebate;
        uint96 fee;
        bool buy;
        bool yes;
    }

    address private a;
    address private oracle;
    address[8] private actors;
    ExpectedAccount[8] private expected;
    ExpectedOrder[] private orders;
    Fill[] private fills;
    ScenarioUSDC private usdc;
    Vault private vault;
    MarketFactory private factory;
    Market private market;
    uint256 private backing;
    uint256 private marketFees;
    uint256 private vaultFees;
    uint256 private withdrawnFees;
    uint8 private state;
    string private step;

    function setUp() public {
        vm.warp(T0);
        a = makeAddr("A-owner");
        oracle = makeAddr("O-oracle");
        vm.deal(a, 10 ether);
        vm.deal(oracle, 10 ether);
        uint256[8] memory funding = [uint256(2000), 2000, 1000, 1500, 1000, 500, 500, 500];
        for (uint256 j; j < 8; ++j) {
            actors[j] = makeAddr(string(abi.encodePacked(bytes1(uint8(66 + j)))));
            vm.deal(actors[j], 10 ether);
            expected[j].wallet = funding[j] * U;
        }

        vm.startPrank(a);
        usdc = new ScenarioUSDC();
        vault =
            Vault(address(new ERC1967Proxy(address(new Vault()), abi.encodeCall(Vault.initialize, (address(usdc))))));
        assertEq(vault.owner(), a, "A initialized Vault proxy");
        assertEq(vault.USDCAddress(), address(usdc), "Vault collateral");
        factory = MarketFactory(
            address(new ERC1967Proxy(address(new MarketFactory()), abi.encodeCall(MarketFactory.initialize, ())))
        );
        assertEq(factory.owner(), a, "A initialized Factory proxy");
        assertGt(factory.marketImplementation().code.length, 0, "implementation deployed");
        vault.setMarketFactory(address(factory));
        assertEq(vault.marketFactory(), address(factory), "Factory wiring");
        factory.setVault(address(vault));
        assertEq(address(factory.vault()), address(vault), "Vault wiring");
        market = Market(factory.createMarket(oracle, 100, 5000));
        vm.stopPrank();
        assertTrue(vault.markets(address(market)), "clone registered");
        assertEq(address(market.vault()), address(vault), "clone Vault");
        assertEq(market.oracle(), oracle, "independent oracle");
        assertEq(market.takerFeeRate(), 100);
        assertEq(market.makerRebateRate(), 5000);
        assertEq(usdc.decimals(), 6);
        for (uint256 j; j < 8; ++j) {
            usdc.mint(actors[j], expected[j].wallet);
        }
        vm.recordLogs();
        _check("deployment and initial wallets");
    }

    function testMainlineEveryTransactionYesWins() public {
        _session();
        _settle(true);
    }

    function testMainlineEveryTransactionNoWins() public {
        _session();
        _settle(false);
    }

    function _session() private {
        for (uint256 j; j < 8; ++j) {
            uint96 amount = uint96(expected[j].wallet);
            vm.prank(actors[j]);
            usdc.approve(address(vault), amount);
            assertEq(usdc.allowance(actors[j], address(vault)), amount, "approve amount");
            _check(string.concat("approve ", vm.toString(j)));
            vm.prank(actors[j]);
            vault.deposit(amount);
            expected[j].cash += amount;
            expected[j].wallet -= amount;
            assertEq(usdc.allowance(actors[j], address(vault)), 0, "deposit used allowance");
            _check(string.concat("deposit ", vm.toString(j)));
        }
        _split(B, 800);
        _split(C, 600);
        _split(F, 400);
        _split(G, 200);
        _split(H, 100);
        _split(I, 100);
        assertEq(backing, 2200 * U);
        _initialBooks();
        _trading();
        _refreshAndMerge();
        vm.warp(T0 + 1800);
        vm.prank(oracle);
        market.setMarketState(3);
        state = 3;
        _check("+1800 O pauses");
        vm.warp(T0 + 1860);
        vm.prank(oracle);
        market.setMarketState(0);
        state = 0;
        _check("+1860 O resumes");
        _finalLedger();
    }

    function _split(uint256 who, uint96 whole) private {
        uint96 amount = whole * U;
        vm.prank(actors[who]);
        market.splitUSDC(amount);
        expected[who].cash -= amount;
        expected[who].yes += amount;
        expected[who].no += amount;
        backing += amount;
        _check(string.concat("split ", vm.toString(who)));
    }

    function _initialBooks() private {
        Market.OrderBatch[] memory batch = new Market.OrderBatch[](8);
        batch[0] = _order(55, 100, 600, false, true);
        batch[1] = _order(55, 120, 0, false, true);
        batch[2] = _order(60, 200, 0, false, true);
        batch[3] = _order(45, 150, 0, false, false);
        batch[4] = _order(50, 100, 900, false, false);
        batch[5] = _order(45, 100, 600, true, true);
        batch[6] = _order(40, 200, 0, true, true);
        batch[7] = _order(35, 100, 0, true, false);
        vm.warp(T0 + 60);
        _batch(B, batch);
        _check("+60 B batches 8 orders");
        assertEq(vault.balances(actors[B]), 1040 * U);

        batch = new Market.OrderBatch[](9);
        batch[0] = _order(55, 80, 0, false, true);
        batch[1] = _order(58, 150, 1200, false, true);
        batch[2] = _order(65, 100, 0, false, true);
        batch[3] = _order(45, 100, 0, false, false);
        batch[4] = _order(55, 150, 0, false, false);
        batch[5] = _order(45, 150, 0, true, true);
        batch[6] = _order(42, 100, 0, true, true);
        batch[7] = _order(35, 100, 600, true, false);
        batch[8] = _order(30, 200, 0, true, false);
        vm.warp(T0 + 90);
        _batch(C, batch);
        _check("+90 C batches 9 orders");
        assertEq(vault.balances(actors[C]), 1_195_500_000);
        _exactBest(true, 45, 55);
        _exactBest(false, 35, 45);
    }

    function _trading() private {
        // Expected fills are explicit, not computed by traversing the actual book.
        // Literal per-fill fees are independently calculated in the scenario plan.
        vm.warp(T0 + 120);
        vm.prank(actors[D]);
        market.orderInsert(55, 250 * U, 0, true, true);
        _fill(0, D, 100, 247500);
        _fill(1, D, 120, 297000);
        _fill(8, D, 30, 74250);
        _check("+120 D buys 250 YES at 55, FIFO across B/B/C");
        assertEq(vault.balances(actors[D]), 861_881_250);

        vm.warp(T0 + 180);
        vm.prank(actors[E]);
        market.orderInsert(55, 400 * U, 0, true, true);
        _fill(8, E, 50, 123750);
        _fill(9, E, 150, 365400);
        _fill(2, E, 200, 480000);
        _check("+180 E crosses 55/58/60 buying 400 YES");
        assertEq(vault.balances(actors[E]), 1_264_530_850);

        vm.warp(T0 + 240);
        vm.prank(actors[F]);
        market.sellShares(220 * U, true, 98 * U);
        _fill(5, F, 100, 247500);
        _fill(13, F, 120, 297000);
        _check("+240 F sells 220 YES, C bid retains 30");
        assertEq(vault.balances(actors[F]), 698_455_500);

        vm.warp(T0 + 300);
        vm.prank(actors[G]);
        market.sellShares(150 * U, false, 52 * U);
        _fill(7, G, 100, 227500);
        _fill(15, G, 50, 113750);
        _check("+300 G sells 150 NO, expiring C bid retains 50");

        vm.warp(T0 + 360);
        vm.prank(actors[H]);
        market.orderInsert(45, 200 * U, 0, true, false);
        _fill(3, H, 150, 371250);
        _fill(11, H, 50, 123750);
        _check("+360 H buys 200 NO, C ask retains 50");

        vm.warp(T0 + 601);
        vm.prank(actors[I]);
        market.sellShares(100 * U, false, 29 * U);
        _release(15); // Refund only the unfilled 50 @ 35: 17.5 USDC.
        _fill(16, I, 100, 210000);
        _check("+601 I skips expired C NO bid and sells at 30");

        vm.warp(T0 + 660);
        vm.prank(actors[B]);
        market.deleteOrder(40, 0, true);
        _release(6);
        _check("+660 B cancels 200 YES bid, refunds 80");
        assertEq(expected[B].deposit, 0);

        vm.warp(T0 + 901);
        vm.prank(actors[D]);
        market.orderInsert(45, 100 * U, 0, true, false);
        _fill(11, D, 50, 123750);
        _release(4); // Expired ask returns 100 NO, not USDC.
        _fill(12, D, 50, 123750);
        _check("+901 D buys NO at 45/55, expired B ask refunded once");
    }

    function _refreshAndMerge() private {
        vm.warp(T0 + 1000);
        vm.prank(actors[C]);
        uint32 version = market.updateVersion();
        assertEq(version, 1, "C new version");
        uint256 beforeCash = expected[C].cash;
        for (uint256 j; j < orders.length; ++j) {
            if (orders[j].maker == C && orders[j].remaining > 0) _release(j);
        }
        expected[C].version = 1;
        assertEq(expected[C].cash - beforeCash, 85_500_000, "version refund");
        _check("+1000 C invalidates all old orders and releases collateral");

        vm.warp(T0 + 1020);
        Market.OrderBatch[] memory batch = new Market.OrderBatch[](2);
        batch[0] = _order(70, 60, 0, false, true);
        batch[1] = _order(25, 80, 0, true, false);
        _batch(C, batch);
        _check("+1020 C posts new-version orders, old orders cannot refund twice");
        _merge(H, 50, 1080);
        _merge(F, 100, 1090);
        _merge(G, 50, 1100);
        _merge(B, 300, 1110);
        _merge(C, 200, 1120);
    }

    function _merge(uint256 who, uint96 whole, uint48 at) private {
        vm.warp(T0 + at);
        uint96 amount = whole * U;
        vm.prank(actors[who]);
        market.mergeShares(amount);
        expected[who].cash += amount;
        expected[who].yes -= amount;
        expected[who].no -= amount;
        backing -= amount;
        _check(string.concat("merge ", vm.toString(who)));
    }

    function _finalLedger() private view {
        uint256[8] memory cash = [
            uint256(1_729_435_375),
            1_682_777_700,
            811_633_750,
            1_264_530_850,
            798_455_500,
            402_158_750,
            359_505_000,
            429_790_000
        ];
        uint256[8] memory yes = [uint256(180), 230, 250, 400, 80, 150, 50, 100];
        uint256[8] memory no = [uint256(450), 400, 100, 0, 300, 0, 250, 0];
        for (uint256 j; j < 8; ++j) {
            assertEq(vault.balances(actors[j]), cash[j], "literal final cash");
            (uint96 dep, uint96 y, uint96 yl, uint96 n, uint96 nl) = market.traderInfos(actors[j]);
            assertEq(dep, j == C ? 20 * U : 0, "literal final deposit");
            assertEq(y, yes[j] * U, "literal final free YES");
            assertEq(yl, j == C ? 60 * U : 0, "literal final locked YES");
            assertEq(n, no[j] * U, "literal final NO");
            assertEq(nl, 0, "literal final locked NO");
        }
        assertEq(backing, 1500 * U);
        assertEq(market.marketFeeReceived(), 1_713_075);
    }

    function _settle(bool yesWins) private {
        vm.warp(T0 + 3600);
        vm.prank(oracle);
        market.setMarketState(yesWins ? 1 : 2);
        state = yesWins ? 1 : 2;
        _check("+3600 O resolves");
        uint256[8] memory sequence = yesWins ? [uint256(B), C, D, E, F, G, H, I] : [uint256(I), C, E, B, H, D, G, F];
        uint256[8] memory payouts =
            yesWins ? [uint256(180), 310, 250, 400, 80, 150, 50, 100] : [uint256(450), 420, 100, 0, 300, 0, 250, 0];
        for (uint256 k; k < 8; ++k) {
            uint256 j = sequence[k];
            ExpectedAccount storage account = expected[j];
            uint256 winning = yesWins ? account.yes + account.yesLocked : account.no + account.noLocked;
            assertEq(winning + account.deposit, payouts[j] * U, "literal redemption payout");
            vm.prank(actors[j]);
            market.redeem();
            account.cash += winning + account.deposit;
            backing -= winning;
            account.deposit = 0;
            account.yes = 0;
            account.yesLocked = 0;
            account.no = 0;
            account.noLocked = 0;
            _check(string.concat("redeem ", vm.toString(j)));
            vm.prank(actors[j]);
            vm.expectRevert(bytes("No shares to redeem"));
            market.redeem();
            _check(string.concat("repeat redeem rejected ", vm.toString(j)));
        }
        for (uint256 j; j < 8; ++j) {
            uint96 amount = uint96(expected[j].cash);
            vm.prank(actors[j]);
            vault.withdraw(amount);
            expected[j].wallet += amount;
            expected[j].cash = 0;
            _check(string.concat("withdraw ", vm.toString(j)));
        }
        vm.prank(a);
        vault.getMarketFee(address(market));
        vaultFees = marketFees;
        marketFees = 0;
        _check("A collects market fees into Vault");
        vm.prank(a);
        vault.getMarketFee(address(market));
        _check("A repeated fee collection is zero");
        vm.prank(a);
        vault.withDrawFee();
        withdrawnFees = vaultFees;
        vaultFees = 0;
        _check("A withdraws 1.713075 USDC fees");
        vm.prank(a);
        vault.withDrawFee();
        _check("A repeated fee withdrawal is zero");
        assertEq(usdc.balanceOf(address(vault)), 0, "all collateral paid out");
        assertEq(usdc.balanceOf(a), 1_713_075);
    }

    function _order(uint8 price, uint96 whole, uint48 ttl, bool buy, bool yes)
        private
        pure
        returns (Market.OrderBatch memory)
    {
        return Market.OrderBatch(price, whole * U, ttl == 0 ? 0 : T0 + ttl, buy, yes);
    }

    function _batch(uint256 who, Market.OrderBatch[] memory batch) private {
        vm.prank(actors[who]);
        market.orderBatchInsert(batch);
        for (uint256 j; j < batch.length; ++j) {
            Market.OrderBatch memory o = batch[j];
            orders.push(
                ExpectedOrder(who, o.prices, o.shareAmounts, o.endTimestamps, expected[who].version, o.isBuy, o.isYes)
            );
            if (o.isBuy) {
                uint256 principal = uint256(o.prices) * o.shareAmounts / 100;
                expected[who].cash -= principal;
                expected[who].deposit += principal;
            } else if (o.isYes) {
                expected[who].yes -= o.shareAmounts;
                expected[who].yesLocked += o.shareAmounts;
            } else {
                expected[who].no -= o.shareAmounts;
                expected[who].noLocked += o.shareAmounts;
            }
        }
    }

    // Accounting only: the scenario supplies the exact maker, quantity and fee.
    // This deliberately does not reproduce the contract's matching algorithm.
    function _fill(uint256 id, uint256 taker, uint96 whole, uint96 fee) private {
        ExpectedOrder storage o = orders[id];
        ExpectedAccount storage makerAccount = expected[o.maker];
        ExpectedAccount storage takerAccount = expected[taker];
        uint96 quantity = whole * U;
        uint96 principal = uint96(uint256(quantity) * o.price / 100);
        uint96 rebate = fee / 2;
        o.remaining -= quantity;
        marketFees += fee - rebate;
        if (o.buy) {
            makerAccount.deposit -= principal;
            makerAccount.cash += rebate;
            takerAccount.cash += principal - fee;
            if (o.yes) {
                takerAccount.yes -= quantity;
                makerAccount.yes += quantity;
            } else {
                takerAccount.no -= quantity;
                makerAccount.no += quantity;
            }
        } else {
            makerAccount.cash += principal + rebate;
            takerAccount.cash -= principal + fee;
            if (o.yes) {
                makerAccount.yesLocked -= quantity;
                takerAccount.yes += quantity;
            } else {
                makerAccount.noLocked -= quantity;
                takerAccount.no += quantity;
            }
        }
        fills.push(Fill(actors[o.maker], actors[taker], quantity, o.price, rebate, fee - rebate, !o.buy, o.yes));
    }

    function _release(uint256 id) private {
        ExpectedOrder storage o = orders[id];
        ExpectedAccount storage account = expected[o.maker];
        if (o.buy) {
            uint256 principal = uint256(o.remaining) * o.price / 100;
            account.deposit -= principal;
            account.cash += principal;
        } else if (o.yes) {
            account.yesLocked -= o.remaining;
            account.yes += o.remaining;
        } else {
            account.noLocked -= o.remaining;
            account.no += o.remaining;
        }
        o.remaining = 0;
    }

    function _check(string memory label) private {
        step = label;
        // Each checkpoint gets fresh EVM memory. Keeping all full-book scans in
        // the session's frame would accumulate diagnostic allocations all day.
        this.assertCheckpoint();
        _checkFills();
        delete fills;
        vm.recordLogs();
    }

    function assertCheckpoint() external view {
        require(msg.sender == address(this), "test self-call only");
        uint256 cashAndDeposits;
        uint256 wallets = withdrawnFees;
        uint256 yesSupply;
        uint256 noSupply;
        for (uint256 j; j < 8; ++j) {
            _checkAccount(j);
            ExpectedAccount storage e = expected[j];
            cashAndDeposits += e.cash + e.deposit;
            wallets += e.wallet;
            yesSupply += e.yes + e.yesLocked;
            noSupply += e.no + e.noLocked;
        }
        assertEq(market.marketState(), state, string.concat(step, " state"));
        assertEq(market.marketFeeReceived(), marketFees, string.concat(step, " market fee"));
        assertEq(vault.totalMarketFeeReceived(), vaultFees, string.concat(step, " collected fee"));
        assertEq(usdc.balanceOf(a), withdrawnFees, string.concat(step, " owner wallet"));
        assertEq(vault.balances(a), 0, "owner has no trader credit");
        assertEq(vault.balances(oracle), 0, "oracle has no trader credit");
        uint256 actualVault = usdc.balanceOf(address(vault));
        assertEq(
            actualVault,
            cashAndDeposits + backing + marketFees + vaultFees,
            string.concat(step, " Vault liabilities conserved")
        );
        assertEq(actualVault + wallets, 9000 * U, string.concat(step, " total cash conserved"));
        assertEq(usdc.totalSupply(), 9000 * U, "no minting during session");
        if (state == 0 || state == 3) {
            assertEq(yesSupply, backing, string.concat(step, " YES backing"));
            assertEq(noSupply, backing, string.concat(step, " NO backing"));
            _checkBook(true);
            _checkBook(false);
        } else {
            assertEq(state == 1 ? yesSupply : noSupply, backing, string.concat(step, " unredeemed backing"));
        }
    }

    function _checkAccount(uint256 j) private view {
        ExpectedAccount memory e = expected[j];
        string memory context = string.concat(step, " actor=", vm.toString(j));
        assertEq(vault.balances(actors[j]), e.cash, string.concat(context, " cash"));
        assertEq(usdc.balanceOf(actors[j]), e.wallet, string.concat(context, " wallet"));
        (uint96 dep, uint96 y, uint96 yl, uint96 n, uint96 nl) = market.traderInfos(actors[j]);
        assertEq(dep, e.deposit, string.concat(context, " buy deposit"));
        assertEq(y, e.yes, string.concat(context, " free YES"));
        assertEq(yl, e.yesLocked, string.concat(context, " locked YES"));
        assertEq(n, e.no, string.concat(context, " free NO"));
        assertEq(nl, e.noLocked, string.concat(context, " locked NO"));
        assertEq(_version(actors[j]), e.version, string.concat(context, " version"));
    }

    function _checkFills() private view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        for (uint256 j; j < logs.length; ++j) {
            Vm.Log memory entry = logs[j];
            if (entry.emitter != address(market) || entry.topics.length == 0 || entry.topics[0] != TRADE) continue;
            assertLt(found, fills.length, string.concat(step, " unexpected fill"));
            Fill memory f = fills[found++];
            assertEq(entry.topics.length, 3, "fill topics");
            assertEq(address(uint160(uint256(entry.topics[1]))), f.maker, string.concat(step, " FIFO maker"));
            assertEq(address(uint160(uint256(entry.topics[2]))), f.taker, string.concat(step, " taker"));
            (uint96 quantity, uint32 price, uint96 rebate, uint96 fee, bool buy, bool yes, uint256 orderIndex) =
                abi.decode(entry.data, (uint96, uint32, uint96, uint96, bool, bool, uint256));
            assertEq(quantity, f.quantity, string.concat(step, " fill quantity"));
            assertEq(price, f.price, string.concat(step, " fill price"));
            assertEq(rebate, f.rebate, string.concat(step, " maker rebate"));
            assertEq(fee, f.fee, string.concat(step, " market fee"));
            assertEq(buy, f.buy, string.concat(step, " fill direction"));
            assertEq(yes, f.yes, string.concat(step, " fill side"));
            assertLt(orderIndex, 1_000_000, string.concat(step, " fill order index"));
        }
        assertEq(found, fills.length, string.concat(step, " fill count"));
    }

    function _version(address trader) private view returns (uint32) {
        return uint32(uint256(vm.load(address(market), keccak256(abi.encode(trader, VERSION_SLOT)))));
    }

    function _readOrder(uint256 bucket, uint256 index) private view returns (Market.Order memory o) {
        uint256 base = uint256(keccak256(abi.encode(bucket))) + index * 2;
        uint256 first = uint256(vm.load(address(market), bytes32(base)));
        uint256 second = uint256(vm.load(address(market), bytes32(base + 1)));
        o = Market.Order(
            address(uint160(first)),
            uint96(first >> 160),
            uint48(second),
            uint32(second >> 48),
            uint8(second >> 80) != 0
        );
    }

    function _checkBook(bool yes) private view {
        uint256 bitmap;
        uint8 bestBid;
        uint8 bestAsk = 100;
        for (uint256 price = 1; price < 100; ++price) {
            uint256 bucket = (yes ? YES_BOOK_SLOT : NO_BOOK_SLOT) + price * 2;
            uint256 length = uint256(vm.load(address(market), bytes32(bucket)));
            uint256 head = uint256(vm.load(address(market), bytes32(bucket + 1)));
            assertLe(head, length, string.concat(step, " bucket head bounds"));
            if (length > 0) bitmap |= uint256(1) << price;
            bytes32 actualHash;
            uint256 count;
            for (uint256 j; j < length; ++j) {
                Market.Order memory o = _readOrder(bucket, j);
                if (o.shareAmount == 0 || o.version < _version(o.trader)) continue;
                assertGe(j, head, string.concat(step, " head skipped live order"));
                actualHash = keccak256(abi.encode(actualHash, o));
                ++count;
                if (o.endTimestamp == 0 || o.endTimestamp >= block.timestamp) {
                    if (o.isBuy && price > bestBid) bestBid = uint8(price);
                    if (!o.isBuy && price < bestAsk) bestAsk = uint8(price);
                }
            }
            bytes32 expectedHash;
            uint256 expectedCount;
            for (uint256 j; j < orders.length; ++j) {
                ExpectedOrder memory e = orders[j];
                if (e.yes != yes || e.price != price || e.remaining == 0) continue;
                expectedHash = keccak256(
                    abi.encode(expectedHash, Market.Order(actors[e.maker], e.remaining, e.expiry, e.version, e.buy))
                );
                ++expectedCount;
            }
            string memory context = string.concat(step, yes ? " YES@" : " NO@", vm.toString(price));
            assertEq(count, expectedCount, string.concat(context, " remaining order count"));
            assertEq(actualHash, expectedHash, string.concat(context, " FIFO/order owner/quantity/expiry/version"));
        }
        assertEq(yes ? market.yesBitmap() : market.noBitmap(), bitmap, string.concat(step, " bitmap/buckets"));
        // Consumed historical heads may remain until the next cleanup. They may
        // not cause the search to skip a better still-valid quote.
        uint256 packed = uint256(vm.load(address(market), bytes32(uint256(yes ? 207 : 410))));
        uint8 storedBid = uint8(packed >> 128);
        uint8 storedAsk = uint8(packed >> 136);
        assertLe(storedBid, 99, string.concat(step, " bid sentinel"));
        assertGe(storedAsk, 1, string.concat(step, " ask sentinel lower"));
        assertLe(storedAsk, 100, string.concat(step, " ask sentinel upper"));
        if (bestBid != 0) assertGe(storedBid, bestBid, string.concat(step, " bid search covers live best"));
        if (bestAsk != 100) assertLe(storedAsk, bestAsk, string.concat(step, " ask search covers live best"));
    }

    function _exactBest(bool yes, uint8 bid, uint8 ask) private view {
        uint256 packed = uint256(vm.load(address(market), bytes32(uint256(yes ? 207 : 410))));
        assertEq(uint8(packed >> 128), bid, "initial best bid");
        assertEq(uint8(packed >> 136), ask, "initial best ask");
    }
}
