// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./MarketVault.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

contract Market is MarketVault, Initializable {
    // Memory-only matching progress reduces IR stack pressure; no storage layout change.
    struct BuySharesProgress {
        uint8 bestPrice;
        uint96 totalUSDCAmountIn;
        uint96 shareAmountRemain;
    }

    struct Order {
        address trader;
        uint48 endTimestamp;
        uint32 version;
        bool isBuy;
        uint96 shareAmount;
        uint32 next;
    }

    struct PriceOrders {
        Order[] orders;
        uint32 headOrderIndex;
        uint32 tailOrderIndex;
        uint32 freeList;
    }

    struct OrderBatch {
        uint8 prices;
        uint96 shareAmounts;
        uint48 endTimestamps;
        bool isBuy;
        bool isYes;
        OrderType orderType;
    }

    enum OrderType {
        Limit,
        PostOnly,
        Market,
        FillOrKill,
        ImmediateOrCancel // Fill and Kill
    }

    mapping(address => uint32) traderVersions;

    PriceOrders[101] public yesOrderBook;
    uint128 public yesBitmap;
    uint8 bestYesBuyPrice;
    uint8 bestYesSellPrice;

    PriceOrders[101] public noOrderBook;
    uint128 public noBitmap;
    uint8 bestNoBuyPrice;
    uint8 bestNoSellPrice;

    event UpdateVersion(address indexed trader, uint32 newVersion);

    enum BestPriceType {
        bestNoBuyPrice,
        bestNoSellPrice,
        bestYesBuyPrice,
        bestYesSellPrice
    }
    event ChangeBestPrice(BestPriceType bestPriceType, uint8 price);

    event DeleteOrder(
        address indexed trader,
        uint8 price,
        uint256 orderIndex,
        bool isYes
    );

    event TradeInfo(
        address indexed maker,
        address indexed taker,
        uint96 shareAmount,
        uint32 price,
        uint96 makerFeeAmount,
        uint96 marketFeeAmount,
        bool isBuy,
        bool isYes,
        uint32 index
    );

    event OrderInsertInfo(
        address indexed trader,
        uint8 price,
        uint96 shareAmount,
        uint48 endTimestamp,
        uint32 version,
        bool isBuy,
        bool isYes,
        uint32 index
    );

    event PostOnlyOrderWouldTake(OrderBatch order);

    function initialize(
        address _vault,
        address _oracle,
        uint96 _feeRate,
        uint96 _makerRebateRate
    ) external initializer {
        _marketVaultInit(_vault, _oracle, _feeRate, _makerRebateRate);

        bestYesBuyPrice = 0;
        bestYesSellPrice = 100;
        bestNoBuyPrice = 0;
        bestNoSellPrice = 100;
    }

    function updateVersion()
        external
        onlyOpen
        nonReentrant
        returns (uint32 newVersion)
    {
        newVersion = traderVersions[msg.sender] + 1;
        traderVersions[msg.sender] = newVersion;

        emit UpdateVersion(msg.sender, newVersion);

        releaseShareAmount(
            traderInfos[msg.sender].yesLockedAmount,
            msg.sender,
            true
        );
        releaseShareAmount(
            traderInfos[msg.sender].noLockedAmount,
            msg.sender,
            false
        );

        vault.releaseDeposit(traderInfos[msg.sender]._USDCLocked, msg.sender);
        traderInfos[msg.sender]._USDCLocked = 0;

        _delectExpiredOrder(true, true);
        _delectExpiredOrder(true, false);
        _delectExpiredOrder(false, true);
        _delectExpiredOrder(false, false);
    }

    function orderInsert(
        uint8 price,
        uint96 shareAmount,
        uint48 endTimestamp,
        bool isBuy,
        bool isYes,
        OrderType orderType
    )
        external
        //
        onlyOpen
        nonReentrant
    {
        //挂买入、卖出单时，order.amount应该按shareAmount计算
        _validateOrderInput(price, shareAmount, endTimestamp, orderType);
        _delectExpiredOrder(isYes, !isBuy);

        if (isBuy) {
            if (
                (price >= bestYesSellPrice && isYes) ||
                (price >= bestNoSellPrice && !isYes)
            ) {
                if (orderType == OrderType.Limit) {
                    uint96 shareAmountRemain = _buyShares(
                        shareAmount,
                        isYes,
                        0,
                        price
                    ); // 限价订单的处理方式
                    if (shareAmountRemain > 0) {
                        vault.lockDeposit(
                            (shareAmountRemain * price) / 100,
                            msg.sender
                        );
                        traderInfos[msg.sender]._USDCLocked +=
                            (shareAmountRemain * price) /
                            100;

                        _orderInsert(
                            price,
                            shareAmountRemain,
                            endTimestamp,
                            isBuy,
                            isYes
                        );
                    }
                } else if (orderType == OrderType.PostOnly) {
                    emit PostOnlyOrderWouldTake(
                        OrderBatch(
                            price,
                            shareAmount,
                            endTimestamp,
                            isBuy,
                            isYes,
                            orderType
                        )
                    );
                }
            } else {
                vault.lockDeposit((shareAmount * price) / 100, msg.sender);
                traderInfos[msg.sender]._USDCLocked +=
                    (shareAmount * price) /
                    100;

                _orderInsert(price, shareAmount, endTimestamp, isBuy, isYes);
            }
        } else {
            // For sell orders.
            if (
                (price <= bestYesBuyPrice && isYes) ||
                (price <= bestNoBuyPrice && !isYes)
            ) {
                if (orderType == OrderType.Limit) {
                    uint96 shareAmountRemain = _sellShares(
                        shareAmount,
                        isYes,
                        0,
                        orderType,
                        price
                    ); // 限价订单的处理方式
                    if (shareAmountRemain > 0) {
                        lockShareAmount(shareAmountRemain, msg.sender, isYes);

                        _orderInsert(
                            price,
                            shareAmountRemain,
                            endTimestamp,
                            isBuy,
                            isYes
                        );
                    }
                } else if (orderType == OrderType.PostOnly) {
                    emit PostOnlyOrderWouldTake(
                        OrderBatch(
                            price,
                            shareAmount,
                            endTimestamp,
                            isBuy,
                            isYes,
                            orderType
                        )
                    );
                }
            } else {
                lockShareAmount(shareAmount, msg.sender, isYes);

                _orderInsert(price, shareAmount, endTimestamp, isBuy, isYes);
            }
        }
    }

    function _orderInsert(
        uint8 price,
        uint96 shareAmount,
        uint48 endTimestamp,
        bool isBuy,
        bool isYes //
    ) internal {
        uint32 version = traderVersions[msg.sender];

        if (isYes) {
            if (isBuy) {
                if (price > bestYesBuyPrice) {
                    bestYesBuyPrice = price;

                    emit ChangeBestPrice(BestPriceType.bestYesBuyPrice, price);
                }
            } else {
                if (price < bestYesSellPrice) {
                    bestYesSellPrice = price;

                    emit ChangeBestPrice(BestPriceType.bestYesSellPrice, price);
                }
            }
            yesBitmap |= uint128(1 << price);
        } else {
            if (isBuy) {
                if (price > bestNoBuyPrice) {
                    bestNoBuyPrice = price;

                    emit ChangeBestPrice(BestPriceType.bestNoBuyPrice, price);
                }
            } else {
                if (price < bestNoSellPrice) {
                    bestNoSellPrice = price;

                    emit ChangeBestPrice(BestPriceType.bestNoSellPrice, price);
                }
            }
            noBitmap |= uint128(1 << price);
        }

        PriceOrders storage priceOrders = isYes
            ? yesOrderBook[price]
            : noOrderBook[price];

        uint32 orderIndex;

        Order memory newOrder = Order({
            trader: msg.sender,
            shareAmount: shareAmount,
            endTimestamp: endTimestamp,
            version: version,
            isBuy: isBuy,
            next: 0
        });

        if (priceOrders.freeList != 0) {
            // 从 free list 回收
            orderIndex = priceOrders.freeList;
            priceOrders.freeList = priceOrders.orders[orderIndex].next;
            priceOrders.orders[orderIndex] = newOrder;
        } else {
            // 新建
            if (priceOrders.orders.length == 0) {
                priceOrders.orders.push(); // sentinel
            }

            priceOrders.orders.push(newOrder);
            orderIndex = uint32(priceOrders.orders.length - 1);
        }

        // 加入 active linked list
        if (priceOrders.headOrderIndex == 0) {
            priceOrders.headOrderIndex = orderIndex;
            priceOrders.tailOrderIndex = orderIndex;
        } else {
            priceOrders.orders[priceOrders.tailOrderIndex].next = orderIndex;
            priceOrders.tailOrderIndex = orderIndex;
        }

        emit OrderInsertInfo(
            msg.sender,
            price,
            shareAmount,
            endTimestamp,
            version,
            isBuy,
            isYes,
            orderIndex
        );
    }

    function orderBatchInsert(
        OrderBatch[] calldata orders
    ) external onlyOpen nonReentrant {
        _delectExpiredOrder(true, true);
        _delectExpiredOrder(true, false);
        _delectExpiredOrder(false, true);
        _delectExpiredOrder(false, false);

        uint96 totalBuyUSDCAmount = 0;
        uint96 yesTotalSellAmount = 0;
        uint96 noTotalSellAmount = 0;
        uint96 highestYesBuyOrder;
        uint96 lowestYesSellOrder = 100;
        uint96 highestNoBuyOrder;
        uint96 lowestNoSellOrder = 100;

        for (uint256 i = 0; i < orders.length; i++) {
            if (orders[i].isBuy) {
                if (orders[i].isYes) {
                    highestYesBuyOrder = orders[i].prices > highestYesBuyOrder
                        ? orders[i].prices
                        : highestYesBuyOrder;
                } else {
                    highestNoBuyOrder = orders[i].prices > highestNoBuyOrder
                        ? orders[i].prices
                        : highestNoBuyOrder;
                }
            } else {
                if (orders[i].isYes) {
                    lowestYesSellOrder = orders[i].prices < lowestYesSellOrder
                        ? orders[i].prices
                        : lowestYesSellOrder;
                } else {
                    lowestNoSellOrder = orders[i].prices < lowestNoSellOrder
                        ? orders[i].prices
                        : lowestNoSellOrder;
                }
            }
        }
        require(
            highestYesBuyOrder < lowestYesSellOrder &&
                highestNoBuyOrder < lowestNoSellOrder,
            "invalid price"
        );

        for (uint256 i = 0; i < orders.length; i++) {
            _validateOrderInput(
                orders[i].prices,
                orders[i].shareAmounts,
                orders[i].endTimestamps,
                orders[i].orderType
            );

            if (orders[i].isBuy) {
                if (
                    (orders[i].isYes && orders[i].prices >= bestYesSellPrice) ||
                    (!orders[i].isYes && orders[i].prices >= bestNoSellPrice)
                ) {
                    if (orders[i].orderType == OrderType.Limit) {
                        uint96 shareAmountRemain = _buyShares(
                            orders[i].shareAmounts,
                            orders[i].isYes,
                            0,
                            orders[i].prices
                        );
                        if (shareAmountRemain > 0) {
                            totalBuyUSDCAmount +=
                                (shareAmountRemain * orders[i].prices) /
                                100;
                            _orderInsert(
                                orders[i].prices,
                                shareAmountRemain,
                                orders[i].endTimestamps,
                                orders[i].isBuy,
                                orders[i].isYes
                            );
                        }
                    } else if (orders[i].orderType == OrderType.PostOnly) {
                        emit PostOnlyOrderWouldTake(orders[i]);
                    }
                } else {
                    totalBuyUSDCAmount +=
                        (orders[i].shareAmounts * orders[i].prices) /
                        100;
                    _orderInsert(
                        orders[i].prices,
                        orders[i].shareAmounts,
                        orders[i].endTimestamps,
                        orders[i].isBuy,
                        orders[i].isYes
                    );
                }
            } else {
                if (
                    (orders[i].prices <= bestYesBuyPrice && orders[i].isYes) ||
                    (orders[i].prices <= bestNoBuyPrice && !orders[i].isYes)
                ) {
                    if (orders[i].orderType == OrderType.Limit) {
                        uint96 shareAmountRemain = _sellShares(
                            orders[i].shareAmounts,
                            orders[i].isYes,
                            0,
                            orders[i].orderType,
                            orders[i].prices
                        );
                        if (shareAmountRemain > 0) {
                            if (orders[i].isYes) {
                                yesTotalSellAmount += shareAmountRemain;
                            } else {
                                noTotalSellAmount += shareAmountRemain;
                            }
                            _orderInsert(
                                orders[i].prices,
                                shareAmountRemain,
                                orders[i].endTimestamps,
                                orders[i].isBuy,
                                orders[i].isYes
                            );
                        }
                    } else if (orders[i].orderType == OrderType.PostOnly) {
                        emit PostOnlyOrderWouldTake(orders[i]);
                    }
                } else {
                    if (orders[i].isYes) {
                        yesTotalSellAmount += orders[i].shareAmounts;
                    } else {
                        noTotalSellAmount += orders[i].shareAmounts;
                    }
                    _orderInsert(
                        orders[i].prices,
                        orders[i].shareAmounts,
                        orders[i].endTimestamps,
                        orders[i].isBuy,
                        orders[i].isYes
                    );
                }
            }
        }

        vault.lockDeposit(totalBuyUSDCAmount, msg.sender);
        traderInfos[msg.sender]._USDCLocked += totalBuyUSDCAmount;

        lockShareAmount(yesTotalSellAmount, msg.sender, true);
        lockShareAmount(noTotalSellAmount, msg.sender, false);
    }

    function deleteOrder(
        uint8 price,
        uint256 orderIndex,
        bool isYes
    ) external onlyOpen nonReentrant {
        PriceOrders storage priceOrders = isYes
            ? yesOrderBook[price]
            : noOrderBook[price];

        require(orderIndex < priceOrders.orders.length, "Invalid orderIndex");
        require(
            priceOrders.orders[orderIndex].trader == msg.sender,
            "Not order owner"
        );
        require(
            priceOrders.orders[orderIndex].shareAmount > 0,
            "Order already deleted"
        );
        require(
            priceOrders.orders[orderIndex].version ==
                traderVersions[msg.sender],
            "Order version invalid"
        );

        if (priceOrders.orders[orderIndex].isBuy) {
            vault.releaseDeposit(
                (priceOrders.orders[orderIndex].shareAmount * price) / 100,
                msg.sender
            );
            traderInfos[priceOrders.orders[orderIndex].trader]._USDCLocked -=
                (priceOrders.orders[orderIndex].shareAmount * price) /
                100;
            priceOrders.orders[orderIndex].shareAmount = 0;

            emit DeleteOrder(msg.sender, price, orderIndex, isYes);
            _delectExpiredOrder(isYes, true);
        } else {
            releaseShareAmount(
                priceOrders.orders[orderIndex].shareAmount,
                msg.sender,
                isYes
            );
            priceOrders.orders[orderIndex].shareAmount = 0;

            emit DeleteOrder(msg.sender, price, orderIndex, isYes);
            _delectExpiredOrder(isYes, false);
        }
    }

    function buyUSDCAmount(
        uint96 _USDCAmount,
        bool isYes,
        uint96 minShareOut,
        OrderType orderType,
        uint8 price
    ) external onlyOpen nonReentrant {
        require(
            orderType == OrderType.Market ||
                orderType == OrderType.FillOrKill ||
                orderType == OrderType.ImmediateOrCancel,
            "Invalid order type for buying USDC"
        );
        require(
            _USDCAmount > 0 && _USDCAmount % 100_000 == 0, // Minimum order size: 0.1 USDC (100_000 units with 6 decimals)
            "Invalid USDC amount"
        );
        require(price >= 0 && price <= 100, "Invalid price");

        _buyUSDCAmount(_USDCAmount, isYes, minShareOut, orderType, price);
    }

    function _buyUSDCAmount(
        uint96 _USDCAmount,
        bool isYes,
        uint96 minShareOut,
        OrderType orderType,
        uint8 price
    ) internal {
        uint8 bestPrice = isYes ? bestYesSellPrice : bestNoSellPrice;
        uint96 totalShareAmountOut = 0;
        uint96 _USDCAmountRemain = _USDCAmount;

        // MarkerResultInfo[8] memory makerFeeInfos;
        // uint8 makerFeeInfoCount = 0;
        bool isMarket = orderType == OrderType.Market;

        while (
            _USDCAmountRemain > 10 &&
            bestPrice != 100 &&
            (isMarket || (!isMarket && bestPrice <= price))
        ) {
            PriceOrders storage priceOrders = isYes
                ? yesOrderBook[bestPrice]
                : noOrderBook[bestPrice];

            uint32 headIndex = priceOrders.headOrderIndex;

            uint96 feePerShare = getFeePerShare(bestPrice);
            // Ensure the fee per share is calculated for the current best price
            while (_USDCAmountRemain > 10 && headIndex != 0) {
                Order storage order = priceOrders.orders[headIndex];

                if (
                    order.shareAmount == 0 ||
                    order.version < traderVersions[order.trader]
                ) {
                    order.shareAmount = 0; // Mark the order as invalid
                    uint32 nextOrder = order.next;
                    order.next = priceOrders.freeList;
                    priceOrders.freeList = headIndex;
                    headIndex = nextOrder;
                    continue;
                }
                if (
                    order.endTimestamp < block.timestamp &&
                    order.endTimestamp != 0
                ) {
                    // Order expired, remove it
                    releaseShareAmount(order.shareAmount, order.trader, isYes);

                    order.shareAmount = 0; // Mark the order as invalid
                    uint32 nextOrder = order.next;
                    order.next = priceOrders.freeList;
                    priceOrders.freeList = headIndex;
                    headIndex = nextOrder;
                    continue;
                }

                uint96 orderUSDAmount = (bestPrice * order.shareAmount) / 100;

                uint96 orderTakerFee = (feePerShare * order.shareAmount) /
                    1_000_000;

                if (_USDCAmountRemain >= orderTakerFee + orderUSDAmount) {
                    uint96 tradeUSDCAmount = orderUSDAmount + orderTakerFee;

                    uint96 makerFeeReceived = (orderTakerFee *
                        makerRebateRate) / RATE_SCALE;

                    _USDCAmountRemain -= tradeUSDCAmount;
                    totalShareAmountOut += order.shareAmount;
                    marketFeeReceived += orderTakerFee - makerFeeReceived;

                    if (isYes) {
                        traderInfos[order.trader].yesLockedAmount -= order
                            .shareAmount;
                    } else {
                        traderInfos[order.trader].noLockedAmount -= order
                            .shareAmount;
                    }

                    emit TradeInfo(
                        order.trader,
                        msg.sender,
                        order.shareAmount,
                        bestPrice,
                        makerFeeReceived,
                        orderTakerFee - makerFeeReceived,
                        true,
                        isYes,
                        headIndex
                    );

                    uint32 nextOrder = order.next;
                    order.next = priceOrders.freeList;
                    priceOrders.freeList = headIndex;
                    headIndex = nextOrder;

                    order.shareAmount = 0; // Mark the order as fully filled

                    vault.applyMakerResult(
                        makerFeeReceived + orderUSDAmount,
                        order.trader
                    );
                    //     order.trader)
                    // makerFeeInfoCount = _applyMakerFee(
                    //     makerFeeInfos,
                    //     makerFeeInfoCount,
                    //     makerFeeReceived + orderUSDAmount,
                    //     order.trader,
                    //     false
                    // );
                } else {
                    uint96 tradeShares = (_USDCAmountRemain * 1_000_000) /
                        (feePerShare + bestPrice * RATE_SCALE);

                    orderTakerFee = (feePerShare * tradeShares) / 1_000_000;

                    uint96 makerFeeReceived = (orderTakerFee *
                        makerRebateRate) / RATE_SCALE;
                    uint96 tradeUSDCAmount = (bestPrice * tradeShares) / 100;

                    // Update the order amount and the remaining USD amount
                    order.shareAmount -= tradeShares;
                    marketFeeReceived += orderTakerFee - makerFeeReceived;
                    totalShareAmountOut += tradeShares;

                    if (isYes) {
                        traderInfos[order.trader]
                            .yesLockedAmount -= tradeShares;
                    } else {
                        traderInfos[order.trader].noLockedAmount -= tradeShares;
                    }

                    emit TradeInfo(
                        order.trader,
                        msg.sender,
                        tradeShares,
                        bestPrice,
                        makerFeeReceived,
                        orderTakerFee - makerFeeReceived,
                        true,
                        isYes,
                        headIndex
                    );

                    vault.applyMakerResult(
                        tradeUSDCAmount + makerFeeReceived,
                        order.trader
                    );
                    // makerFeeInfoCount = _applyMakerFee(
                    //     makerFeeInfos,
                    //     makerFeeInfoCount,
                    //     tradeUSDCAmount + makerFeeReceived,
                    //     order.trader,
                    //     false
                    // );
                    _USDCAmountRemain -= tradeUSDCAmount + orderTakerFee;
                }
            }

            priceOrders.headOrderIndex = headIndex;

            if (headIndex == 0) {
                // No more orders at this price, update the best sell price
                if (isYes) {
                    yesBitmap &= ~(uint128(1 << bestPrice));
                    bestPrice = _changeBestPrice(bestPrice, isYes, true);
                } else {
                    noBitmap &= ~(uint128(1 << bestPrice));
                    bestPrice = _changeBestPrice(bestPrice, isYes, true);
                }
            }
        }

        if (orderType == OrderType.FillOrKill && _USDCAmountRemain > 10) {
            revert("FillOrKill order cannot be fully filled");
        }

        require(
            totalShareAmountOut >= minShareOut,
            "Insufficient output amount"
        );

        vault.lockDeposit(_USDCAmount - _USDCAmountRemain, msg.sender);

        // makerFeeInfoCount = _applyMakerFee(
        //     makerFeeInfos,
        //     makerFeeInfoCount,
        //     0,
        //     address(0),
        //     true
        // );

        if (isYes) {
            bestYesSellPrice = bestPrice;
            traderInfos[msg.sender].yesAmount += totalShareAmountOut;
        } else {
            traderInfos[msg.sender].noAmount += totalShareAmountOut;
            bestNoSellPrice = bestPrice;
        }
    }

    function _buyShares(
        uint96 shareAmount,
        bool isYes,
        uint96 minShareAmountOut,
        uint8 price
    ) internal returns (uint96) {
        BuySharesProgress memory progress = BuySharesProgress({
            bestPrice: isYes ? bestYesSellPrice : bestNoSellPrice,
            totalUSDCAmountIn: 0,
            shareAmountRemain: shareAmount
        });

        // MarkerResultInfo[8] memory makerFeeInfos;
        // uint8 makerFeeInfoCount = 0;

        while (
            progress.shareAmountRemain > 0 && progress.bestPrice != 100 && progress.bestPrice <= price
        ) {
            PriceOrders storage priceOrders = isYes
                ? yesOrderBook[progress.bestPrice]
                : noOrderBook[progress.bestPrice];

            uint32 headIndex = priceOrders.headOrderIndex;

            uint96 feePerShare = getFeePerShare(progress.bestPrice);
            while (progress.shareAmountRemain > 0 && headIndex != 0) {
                Order storage order = priceOrders.orders[headIndex];

                // uint32 newHeadIndex = _removeInvalidOrdert(
                //     priceOrders,
                //     headIndex,
                //     isYes
                // );
                // if (newHeadIndex != headIndex) {
                //     headIndex = newHeadIndex;
                //     continue;
                // }
                if (
                    order.shareAmount == 0 ||
                    order.version < traderVersions[order.trader]
                ) {
                    order.shareAmount = 0;
                    uint32 nextOrder = order.next;
                    order.next = priceOrders.freeList;
                    priceOrders.freeList = headIndex;
                    headIndex = nextOrder;
                    continue;
                }

                if (
                    order.endTimestamp < block.timestamp &&
                    order.endTimestamp != 0
                ) {
                    // Order expired, remove it
                    require(
                        isYes
                            ? traderInfos[order.trader].yesLockedAmount >=
                                order.shareAmount
                            : traderInfos[order.trader].noLockedAmount >=
                                order.shareAmount,
                        "Insufficient lockedAmount to release"
                    );
                    releaseShareAmount(order.shareAmount, order.trader, isYes);

                    order.shareAmount = 0; // Mark the order as invalid
                    uint32 nextOrder = order.next;
                    order.next = priceOrders.freeList;
                    priceOrders.freeList = headIndex;
                    headIndex = nextOrder;
                    continue;
                }

                if (progress.shareAmountRemain >= order.shareAmount) {
                    uint96 orderUSDAmount = (progress.bestPrice * order.shareAmount) /
                        100;
                    uint96 orderTakerFee = (feePerShare * order.shareAmount) /
                        1_000_000;
                    uint96 makerFeeReceived = (orderTakerFee *
                        makerRebateRate) / RATE_SCALE;
                    progress.shareAmountRemain -= order.shareAmount;
                    if (isYes) {
                        traderInfos[order.trader].yesLockedAmount -= order
                            .shareAmount;
                    } else {
                        traderInfos[order.trader].noLockedAmount -= order
                            .shareAmount;
                    }
                    marketFeeReceived += orderTakerFee - makerFeeReceived;
                    emit TradeInfo(
                        order.trader,
                        msg.sender,
                        order.shareAmount,
                        progress.bestPrice,
                        makerFeeReceived,
                        orderTakerFee - makerFeeReceived,
                        true,
                        isYes,
                        headIndex
                    );

                    uint32 nextOrder = order.next;
                    order.next = priceOrders.freeList;
                    priceOrders.freeList = headIndex;
                    headIndex = nextOrder;

                    vault.applyMakerResult(
                        makerFeeReceived + orderUSDAmount,
                        order.trader
                    );
                    // makerFeeInfoCount = _applyMakerFee(
                    //     makerFeeInfos,
                    //     makerFeeInfoCount,
                    //     makerFeeReceived + orderUSDAmount,
                    //     order.trader,
                    //     false
                    // );
                    order.shareAmount = 0; // Mark the order as fully filled
                    progress.totalUSDCAmountIn += orderUSDAmount + orderTakerFee;
                } else {
                    uint96 tradeTakerFee = (feePerShare * progress.shareAmountRemain) /
                        1_000_000;
                    uint96 tradeUSDCAmount = (progress.bestPrice * progress.shareAmountRemain) /
                        100;
                    uint96 makerFeeReceived = (tradeTakerFee *
                        makerRebateRate) / RATE_SCALE;
                    if (isYes) {
                        traderInfos[order.trader]
                            .yesLockedAmount -= progress.shareAmountRemain;
                    } else {
                        traderInfos[order.trader]
                            .noLockedAmount -= progress.shareAmountRemain;
                    }
                    order.shareAmount -= progress.shareAmountRemain;

                    emit TradeInfo(
                        order.trader,
                        msg.sender,
                        progress.shareAmountRemain,
                        progress.bestPrice,
                        makerFeeReceived,
                        tradeTakerFee - makerFeeReceived,
                        true,
                        isYes,
                        headIndex
                    );

                    vault.applyMakerResult(
                        makerFeeReceived + tradeUSDCAmount,
                        order.trader
                    );
                    // makerFeeInfoCount = _applyMakerFee(
                    //     makerFeeInfos,
                    //     makerFeeInfoCount,
                    //     makerFeeReceived + tradeUSDCAmount,
                    //     order.trader,
                    //     false
                    // );
                    progress.shareAmountRemain = 0;
                    marketFeeReceived += tradeTakerFee - makerFeeReceived;
                    progress.totalUSDCAmountIn += tradeUSDCAmount + tradeTakerFee;
                }
            }

            if (headIndex == 0) {
                // No more orders at this price, update the best sell price
                if (isYes) {
                    yesBitmap &= ~(uint128(1 << progress.bestPrice));
                    progress.bestPrice = _changeBestPrice(progress.bestPrice, isYes, true);
                } else {
                    noBitmap &= ~(uint128(1 << progress.bestPrice));
                    progress.bestPrice = _changeBestPrice(progress.bestPrice, isYes, true);
                }
            }

            priceOrders.headOrderIndex = headIndex;
        }

        require(
            (shareAmount - progress.shareAmountRemain) >= minShareAmountOut ||
                minShareAmountOut == 0,
            "Outsufficient output amount"
        );

        if (isYes) {
            bestYesSellPrice = progress.bestPrice;

            traderInfos[msg.sender].yesAmount +=
                shareAmount -
                progress.shareAmountRemain;
        } else {
            bestNoSellPrice = progress.bestPrice;

            traderInfos[msg.sender].noAmount += shareAmount - progress.shareAmountRemain;
        }

        // makerFeeInfoCount = _applyMakerFee(
        //     makerFeeInfos,
        //     makerFeeInfoCount,
        //     0,
        //     address(0),
        //     true
        // );

        vault.lockDeposit(progress.totalUSDCAmountIn, msg.sender);

        return progress.shareAmountRemain;
    }

    function sellShares(
        uint96 shareAmount,
        bool isYes,
        uint96 minUSDCAmountOut,
        OrderType orderType,
        uint8 price
    ) external onlyOpen nonReentrant {
        require(
            orderType == OrderType.Market ||
                orderType == OrderType.FillOrKill ||
                orderType == OrderType.ImmediateOrCancel,
            "Invalid order type for selling shares"
        );
        require(
            shareAmount >= 1_000_000 &&
                (
                    isYes
                        ? traderInfos[msg.sender].yesAmount >= shareAmount
                        : traderInfos[msg.sender].noAmount >= shareAmount
                ),
            "Invalid share amount"
        );
        require(price >= 0 && price <= 100, "Invalid price");

        _sellShares(shareAmount, isYes, minUSDCAmountOut, orderType, price);
    }

    function _sellShares(
        uint96 shareAmount,
        bool isYes,
        uint96 minUSDCAmountOut,
        OrderType orderType,
        uint8 price
    ) internal returns (uint96) {
        uint8 bestPrice = isYes ? bestYesBuyPrice : bestNoBuyPrice;
        uint96 totalUSDCAmountOut = 0;
        uint96 shareAmountRemain = shareAmount;

        // MarkerResultInfo[8] memory makerFeeInfos;
        // uint8 makerFeeInfoCount = 0;
        bool isMarket = orderType == OrderType.Market;

        while (
            shareAmountRemain > 0 &&
            bestPrice != 0 &&
            (isMarket || (!isMarket && bestPrice >= price))
        ) {
            PriceOrders storage priceOrders = isYes
                ? yesOrderBook[bestPrice]
                : noOrderBook[bestPrice];

            uint32 headIndex = priceOrders.headOrderIndex;

            uint96 feePerShare = getFeePerShare(bestPrice);
            while (shareAmountRemain > 0 && headIndex != 0) {
                Order storage order = priceOrders.orders[headIndex];

                if (
                    order.shareAmount == 0 ||
                    order.version < traderVersions[order.trader]
                ) {
                    order.shareAmount = 0;
                    headIndex = _nextHeadIndex(priceOrders, order, headIndex);
                    // uint32 nextOrder = order.next;
                    // order.next = priceOrders.freeList;
                    // priceOrders.freeList = headIndex;
                    // headIndex = nextOrder;
                    continue;
                }

                if (
                    order.endTimestamp < block.timestamp &&
                    order.endTimestamp != 0
                ) {
                    // Order expired, remove it
                    require(
                        traderInfos[order.trader]._USDCLocked >=
                            (order.shareAmount * bestPrice) / 100,
                        "Insufficient _USDCLocked to release"
                    );
                    vault.releaseDeposit(
                        (order.shareAmount * bestPrice) / 100,
                        order.trader
                    );
                    traderInfos[order.trader]._USDCLocked -=
                        (order.shareAmount * bestPrice) /
                        100;

                    order.shareAmount = 0; // Mark the order as invalid
                    headIndex = _nextHeadIndex(priceOrders, order, headIndex);
                    // uint32 nextOrder = order.next;
                    // order.next = priceOrders.freeList;
                    // priceOrders.freeList = headIndex;
                    // headIndex = nextOrder;
                    continue;
                }

                if (shareAmountRemain >= order.shareAmount) {
                    (
                        shareAmountRemain,
                        headIndex,
                        totalUSDCAmountOut
                    ) = _handleFullSell(
                        priceOrders,
                        order,
                        bestPrice,
                        feePerShare,
                        shareAmountRemain,
                        headIndex,
                        isYes,
                        totalUSDCAmountOut
                    );
                    /* uint96 orderUSDAmount = (bestPrice * order.shareAmount) /
                        100;
                    uint96 orderTakerFee = (feePerShare * order.shareAmount) /
                        1_000_000;
                    uint96 makerFeeReceived = (orderTakerFee *
                        makerRebateRate) / RATE_SCALE;

                    shareAmountRemain -= order.shareAmount;
                    if (isYes) {
                        traderInfos[msg.sender].yesAmount -= order.shareAmount;
                        traderInfos[order.trader].yesAmount += order
                            .shareAmount;
                    } else {
                        traderInfos[msg.sender].noAmount -= order.shareAmount;
                        traderInfos[order.trader].noAmount += order.shareAmount;
                    }

                    emit TradeInfo(
                        order.trader,
                        msg.sender,
                        order.shareAmount,
                        bestPrice,
                        makerFeeReceived,
                        orderTakerFee - makerFeeReceived,
                        false,
                        isYes,
                        headIndex
                    );
                    headIndex = _nextHeadIndex(priceOrders, order, headIndex);
                    // uint32 nextOrder = order.next;
                    // order.next = priceOrders.freeList;
                    // priceOrders.freeList = headIndex;
                    // headIndex = nextOrder;

                    vault.applyMakerResult(makerFeeReceived, order.trader);
                    // makerFeeInfoCount = _applyMakerFee(
                    //     makerFeeInfos,
                    //     makerFeeInfoCount,
                    //     makerFeeReceived,
                    //     order.trader,
                    //     false
                    // );

                    traderInfos[order.trader]._USDCLocked -= orderUSDAmount;
                    order.shareAmount = 0; // Mark the order as fully filled
                    marketFeeReceived += orderTakerFee - makerFeeReceived;
                    totalUSDCAmountOut += orderUSDAmount - orderTakerFee; */
                } else {
                    uint96 tradeTakerFee = (feePerShare * shareAmountRemain) /
                        1_000_000;
                    uint96 tradeUSDCAmount = (bestPrice * shareAmountRemain) /
                        100;
                    uint96 makerFeeReceived = (tradeTakerFee *
                        makerRebateRate) / RATE_SCALE;

                    if (isYes) {
                        traderInfos[msg.sender].yesAmount -= shareAmountRemain;
                        traderInfos[order.trader]
                            .yesAmount += shareAmountRemain;
                    } else {
                        traderInfos[msg.sender].noAmount -= shareAmountRemain;
                        traderInfos[order.trader].noAmount += shareAmountRemain;
                    }
                    order.shareAmount -= shareAmountRemain;

                    emit TradeInfo(
                        order.trader,
                        msg.sender,
                        shareAmountRemain,
                        bestPrice,
                        makerFeeReceived,
                        tradeTakerFee - makerFeeReceived,
                        false,
                        isYes,
                        headIndex
                    );

                    traderInfos[order.trader]._USDCLocked -= tradeUSDCAmount;

                    vault.applyMakerResult(makerFeeReceived, order.trader);
                    // makerFeeInfoCount = _applyMakerFee(
                    //     makerFeeInfos,
                    //     makerFeeInfoCount,
                    //     makerFeeReceived,
                    //     order.trader,
                    //     false
                    // );

                    shareAmountRemain = 0;
                    marketFeeReceived += tradeTakerFee - makerFeeReceived;
                    totalUSDCAmountOut += tradeUSDCAmount - tradeTakerFee;
                }
            }

            if (headIndex == 0) {
                // No more orders at this price, update the best sell price
                if (isYes) {
                    yesBitmap &= ~(uint128(1 << bestPrice));
                    bestPrice = _changeBestPrice(bestPrice, isYes, false);
                } else {
                    noBitmap &= ~(uint128(1 << bestPrice));
                    bestPrice = _changeBestPrice(bestPrice, isYes, false);
                }
            }

            priceOrders.headOrderIndex = headIndex;
        }

        if (orderType == OrderType.FillOrKill && shareAmountRemain > 0) {
            revert("FillOrKill order cannot be fully filled");
        }

        require(
            totalUSDCAmountOut >= minUSDCAmountOut,
            "Insufficient output amount"
        );

        if (isYes) {
            bestYesBuyPrice = bestPrice;
        } else {
            bestNoBuyPrice = bestPrice;
        }

        // makerFeeInfoCount = _applyMakerFee(
        //     makerFeeInfos,
        //     makerFeeInfoCount,
        //     0,
        //     address(0),
        //     true
        // );

        vault.releaseDeposit(totalUSDCAmountOut, msg.sender);

        return shareAmountRemain;
    }

    function _nextHeadIndex(
        PriceOrders storage priceOrders,
        Order storage order,
        uint32 headIndex
    ) internal returns (uint32 nextOrder) {
        nextOrder = order.next;
        order.next = priceOrders.freeList;
        priceOrders.freeList = headIndex;
    }

    function _handleFullSell(
        PriceOrders storage priceOrders,
        Order storage order,
        uint8 bestPrice,
        uint96 feePerShare,
        uint96 shareAmountRemain,
        uint32 headIndex,
        bool isYes,
        uint96 totalUSDCAmountOut
    ) internal returns (uint96, uint32, uint96) {
        uint96 orderUSDAmount = (bestPrice * order.shareAmount) / 100;
        uint96 orderTakerFee = (feePerShare * order.shareAmount) / 1_000_000;
        uint96 makerFeeReceived = (orderTakerFee * makerRebateRate) /
            RATE_SCALE;

        shareAmountRemain -= order.shareAmount;
        if (isYes) {
            traderInfos[msg.sender].yesAmount -= order.shareAmount;
            traderInfos[order.trader].yesAmount += order.shareAmount;
        } else {
            traderInfos[msg.sender].noAmount -= order.shareAmount;
            traderInfos[order.trader].noAmount += order.shareAmount;
        }

        emit TradeInfo(
            order.trader,
            msg.sender,
            order.shareAmount,
            bestPrice,
            makerFeeReceived,
            orderTakerFee - makerFeeReceived,
            false,
            isYes,
            headIndex
        );
        headIndex = _nextHeadIndex(priceOrders, order, headIndex);
        // uint32 nextOrder = order.next;
        // order.next = priceOrders.freeList;
        // priceOrders.freeList = headIndex;
        // headIndex = nextOrder;

        vault.applyMakerResult(makerFeeReceived, order.trader);
        // makerFeeInfoCount = _applyMakerFee(
        //     makerFeeInfos,
        //     makerFeeInfoCount,
        //     makerFeeReceived,
        //     order.trader,
        //     false
        // );

        traderInfos[order.trader]._USDCLocked -= orderUSDAmount;
        order.shareAmount = 0; // Mark the order as fully filled
        marketFeeReceived += orderTakerFee - makerFeeReceived;
        totalUSDCAmountOut += orderUSDAmount - orderTakerFee;
        return (shareAmountRemain, headIndex, totalUSDCAmountOut);
    }

    function _validateOrderInput(
        uint8 price,
        uint96 shareAmount,
        uint48 endTimestamp,
        OrderType orderType
    ) internal view {
        require(price > 0 && price < 100, "invalid price");
        require(shareAmount >= 1_000_000, "invalid share amount");
        require(
            endTimestamp > block.timestamp || endTimestamp == 0,
            "invalid endTimestamp"
        );
        require(
            orderType == OrderType.Limit || orderType == OrderType.PostOnly,
            "Only Limit and PostOnly orders are supported for orderInsert"
        );
    }

    // function _removeInvalidOrdert(
    //     PriceOrders storage priceOrders,
    //     uint32 headIndex,
    //     bool isYes
    // ) internal returns (uint32 nextOrder) {
    //     Order storage order = priceOrders.orders[headIndex];

    //     if (
    //         order.shareAmount == 0 ||
    //         order.version < traderVersions[order.trader]
    //     ) {
    //         order.shareAmount = 0;

    //         nextOrder = order.next;
    //         order.next = priceOrders.freeList;
    //         priceOrders.freeList = headIndex;

    //         return nextOrder;
    //     }

    //     if (order.endTimestamp < block.timestamp && order.endTimestamp != 0) {
    //         // Order expired, remove it
    //         require(
    //             isYes
    //                 ? traderInfos[order.trader].yesLockedAmount >=
    //                     order.shareAmount
    //                 : traderInfos[order.trader].noLockedAmount >=
    //                     order.shareAmount,
    //             "Insufficient _USDCLocked to release"
    //         );
    //         releaseShareAmount(order.shareAmount, order.trader, isYes);

    //         order.shareAmount = 0; // Mark the order as invalid

    //         nextOrder = order.next;
    //         order.next = priceOrders.freeList;
    //         priceOrders.freeList = headIndex;

    //         return nextOrder;
    //     }

    //     return headIndex;
    // }

    function _delectExpiredOrder(bool isYes, bool isBuy) internal {
        uint8 bestPrice;
        if (isBuy) {
            bestPrice = isYes ? bestYesBuyPrice : bestNoBuyPrice;
        } else {
            bestPrice = isYes ? bestYesSellPrice : bestNoSellPrice;
        }

        while (bestPrice != 100 && bestPrice != 0) {
            PriceOrders storage priceOrders = isYes
                ? yesOrderBook[bestPrice]
                : noOrderBook[bestPrice];

            uint32 headIndex = priceOrders.headOrderIndex;

            if (headIndex == 0) {
                // No more orders at this price, update the best buy price
                if (isYes) {
                    yesBitmap &= ~(uint128(1 << bestPrice));
                    bestPrice = _changeBestPrice(bestPrice, isYes, !isBuy);
                } else {
                    noBitmap &= ~(uint128(1 << bestPrice));
                    bestPrice = _changeBestPrice(bestPrice, isYes, !isBuy);
                }

                if (bestPrice == 0) {
                    if (isBuy) {
                        if (isYes) {
                            bestYesBuyPrice = bestPrice;
                        } else {
                            bestNoBuyPrice = bestPrice;
                        }
                    } else {
                        if (isYes) {
                            bestYesSellPrice = bestPrice;
                        } else {
                            bestNoSellPrice = bestPrice;
                        }
                    }
                    break;
                }
                continue; // Skip to the next iteration to check the new best price
            }

            while (headIndex != 0) {
                Order storage order = priceOrders.orders[headIndex];

                if (
                    order.shareAmount == 0 ||
                    order.version < traderVersions[order.trader]
                ) {
                    order.shareAmount = 0; // Mark the order as invalid
                    uint32 nextOrder = order.next;
                    order.next = priceOrders.freeList;
                    priceOrders.freeList = headIndex;
                    headIndex = nextOrder;
                    continue;
                }

                if (
                    order.endTimestamp < block.timestamp &&
                    order.endTimestamp != 0
                ) {
                    if (isBuy) {
                        // Order expired, remove it
                        uint96 lockedUSDC = (order.shareAmount * bestPrice) /
                            100;
                        traderInfos[order.trader]._USDCLocked -= lockedUSDC;
                        vault.releaseDeposit(lockedUSDC, order.trader);
                    } else {
                        // Order expired, remove it
                        releaseShareAmount(
                            order.shareAmount,
                            order.trader,
                            isYes
                        );
                    }

                    order.shareAmount = 0; // Mark the order as invalid
                    uint32 nextOrder = order.next;
                    order.next = priceOrders.freeList;
                    priceOrders.freeList = headIndex;
                    headIndex = nextOrder;
                    continue;
                }

                if (isBuy) {
                    if (isYes) {
                        bestYesBuyPrice = bestPrice;
                    } else {
                        bestNoBuyPrice = bestPrice;
                    }
                } else {
                    if (isYes) {
                        bestYesSellPrice = bestPrice;
                    } else {
                        bestNoSellPrice = bestPrice;
                    }
                }
                break;
            }
            priceOrders.headOrderIndex = headIndex;

            if (headIndex != 0) {
                break;
            }
        }
    }

    function _changeBestPrice(
        uint8 bestPrice,
        bool isYes,
        bool isBuy
    ) internal returns (uint8) {
        if (isYes) {
            if (isBuy) {
                uint256 b = uint256(yesBitmap);
                uint256 mask = type(uint256).max << bestPrice;
                uint256 masked = b & mask;

                if (masked == 0) return (100);

                uint8 price = uint8(Math.log2(masked & (~masked + 1)));

                emit ChangeBestPrice(BestPriceType.bestYesBuyPrice, price);
                return (price);
            } else {
                uint256 b = uint256(yesBitmap);
                uint256 mask = (1 << (bestPrice + 1)) - 1;
                uint256 masked = b & mask;

                if (masked == 0) return (0);

                uint8 price = uint8(Math.log2(uint256(masked)));

                emit ChangeBestPrice(BestPriceType.bestYesSellPrice, price);
                return (price);
            }
        } else {
            if (isBuy) {
                uint256 b = uint256(noBitmap);
                uint256 mask = type(uint256).max << bestPrice;
                uint256 masked = b & mask;

                if (masked == 0) return (100);

                uint8 price = uint8(Math.log2(masked & (~masked + 1)));

                emit ChangeBestPrice(BestPriceType.bestNoBuyPrice, price);
                return (price);
            } else {
                uint256 b = uint256(noBitmap);
                uint256 mask = (1 << (bestPrice + 1)) - 1;
                uint256 masked = b & mask;

                if (masked == 0) return (0);

                uint8 price = uint8(Math.log2(uint256(masked)));

                emit ChangeBestPrice(BestPriceType.bestNoSellPrice, price);
                return (price);
            }
        }
    }

    function getActiveOrderShareAmount(
        uint8 price,
        bool isYes
    ) external view returns (uint256 totalShareAmount) {
        require(price > 0 && price < 100, "invalid price");

        PriceOrders storage priceOrders = isYes
            ? yesOrderBook[price]
            : noOrderBook[price];

        uint32 cursor = priceOrders.headOrderIndex;

        while (cursor != 0) {
            Order storage order = priceOrders.orders[cursor];

            if (
                order.shareAmount > 0 &&
                order.version >= traderVersions[order.trader] &&
                (order.endTimestamp == 0 ||
                    order.endTimestamp >= block.timestamp)
            ) {
                totalShareAmount += order.shareAmount;
            }

            cursor = order.next;
        }
    }
}
