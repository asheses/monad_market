// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./MarketVault.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

contract Market is MarketVault, Initializable {
    struct Order {
        address trader;
        uint96 shareAmount;
        uint48 endTimestamp;
        uint32 version;
        bool isBuy;
    }

    struct PriceOrders {
        Order[] orders;
        uint256 firstOrderIndex;
    }

    struct OrderBatch {
        uint8 prices;
        uint96 shareAmounts;
        uint48 endTimestamps;
        bool isBuy;
        bool isYes;
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
        uint256 index
    );

    event OrderInsertInfo(
        address indexed trader,
        uint8 price,
        uint96 shareAmount,
        uint48 endTimestamp,
        uint32 version,
        bool isBuy,
        bool isYes,
        uint256 index
    );

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

        releaseDepositShareAmount(
            traderInfos[msg.sender].yesDepositAmount,
            msg.sender,
            true
        );
        releaseDepositShareAmount(
            traderInfos[msg.sender].noDepositAmount,
            msg.sender,
            false
        );

        vault.releaseDeposit(traderInfos[msg.sender].deposit, msg.sender);
        traderInfos[msg.sender].deposit = 0;

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
        bool isYes
    ) external onlyOpen nonReentrant {
        //挂买入、卖出单时，order.amount应该按shareAmount计算
        _validateOrderInput(price, shareAmount, endTimestamp);
        _delectExpiredOrder(isYes, !isBuy);

        if (isBuy) {
            if (
                (price >= bestYesSellPrice && isYes) ||
                (price >= bestNoSellPrice && !isYes)
            ) {
                _buyShares(shareAmount, isYes, 0); // 限价订单的处理方式
            } else {
                vault.lockDeposit((shareAmount * price) / 100, msg.sender);
                traderInfos[msg.sender].deposit += (shareAmount * price) / 100;

                _orderInsert(price, shareAmount, endTimestamp, isBuy, isYes);
            }
        } else {
            // For sell orders.
            if (
                (price <= bestYesBuyPrice && isYes) ||
                (price <= bestNoBuyPrice && !isYes)
            ) {
                _sellShares(shareAmount, isYes, 0);
            } else {
                lockDepositShareAmount(shareAmount, msg.sender, isYes);

                _orderInsert(price, shareAmount, endTimestamp, isBuy, isYes);
            }
        }
    }

    function _orderInsert(
        uint8 price,
        uint96 shareAmount,
        uint48 endTimestamp,
        bool isBuy,
        bool isYes
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

        priceOrders.orders.push(
            Order({
                trader: msg.sender,
                shareAmount: shareAmount,
                endTimestamp: endTimestamp,
                version: version,
                isBuy: isBuy
            })
        );

        emit OrderInsertInfo(
            msg.sender,
            price,
            shareAmount,
            endTimestamp,
            version,
            isBuy,
            isYes,
            priceOrders.orders.length
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
                orders[i].endTimestamps
            );

            if (orders[i].isBuy) {
                if (
                    (orders[i].isYes && orders[i].prices >= bestYesSellPrice) ||
                    (!orders[i].isYes && orders[i].prices >= bestNoSellPrice)
                ) {
                    _buyShares(orders[i].shareAmounts, orders[i].isYes, 0);
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
                    _sellShares(orders[i].shareAmounts, orders[i].isYes, 0);
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
        traderInfos[msg.sender].deposit += totalBuyUSDCAmount;

        lockDepositShareAmount(yesTotalSellAmount, msg.sender, true);
        lockDepositShareAmount(noTotalSellAmount, msg.sender, false);
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
            traderInfos[priceOrders.orders[orderIndex].trader].deposit -=
                (priceOrders.orders[orderIndex].shareAmount * price) /
                100;
            delete priceOrders.orders[orderIndex];

            emit DeleteOrder(msg.sender, price, orderIndex, isYes);
            _delectExpiredOrder(isYes, true);
        } else {
            releaseDepositShareAmount(
                priceOrders.orders[orderIndex].shareAmount,
                msg.sender,
                isYes
            );
            delete priceOrders.orders[orderIndex];

            emit DeleteOrder(msg.sender, price, orderIndex, isYes);
            _delectExpiredOrder(isYes, false);
        }
    }

    function buyUSDCAmount(
        uint96 _USDCAmount,
        bool isYes,
        // 补充各种订单
        uint96 minShareOut
    ) external onlyOpen nonReentrant {
        require(
            _USDCAmount > 0 && _USDCAmount % 100_000 == 0, // Minimum order size: 0.1 USDC (100_000 units with 6 decimals)
            "Invalid USDC amount"
        );

        _buyUSDCAmount(_USDCAmount, isYes, minShareOut);
    }

    function _buyUSDCAmount(
        uint96 _USDCAmount,
        bool isYes,
        uint96 minShareOut
    ) internal {
        uint8 bestPrice = isYes ? bestYesSellPrice : bestNoSellPrice;
        uint96 totalShareAmountOut = 0;
        uint96 _USDCAmountRemain = _USDCAmount;

        MarkerResultInfo[8] memory makerFeeInfos;
        uint8 makerFeeInfoCount = 0;

        while (_USDCAmountRemain > 10 && bestPrice != 100) {
            PriceOrders storage priceOrders = isYes
                ? yesOrderBook[bestPrice]
                : noOrderBook[bestPrice];

            uint256 firstOrderIndex = priceOrders.firstOrderIndex;

            uint96 feePerShare = getFeePerShare(bestPrice);
            // Ensure the fee per share is calculated for the current best price
            while (
                firstOrderIndex < priceOrders.orders.length &&
                _USDCAmountRemain > 10
            ) {
                Order storage order = priceOrders.orders[firstOrderIndex];

                if (
                    order.shareAmount == 0 ||
                    order.version < traderVersions[order.trader]
                ) {
                    order.shareAmount = 0; // Mark the order as invalid
                    firstOrderIndex++;
                    continue;
                }
                if (
                    order.endTimestamp < block.timestamp &&
                    order.endTimestamp != 0
                ) {
                    // Order expired, remove it
                    releaseDepositShareAmount(
                        order.shareAmount,
                        order.trader,
                        isYes
                    );
                    order.shareAmount = 0; // Mark the order as invalid
                    firstOrderIndex++;
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
                        traderInfos[order.trader].yesDepositAmount -= order
                            .shareAmount;
                    } else {
                        traderInfos[order.trader].noDepositAmount -= order
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
                        firstOrderIndex
                    );
                    firstOrderIndex++;

                    order.shareAmount = 0; // Mark the order as fully filled

                    makerFeeInfoCount = _applyMakerFee(
                        makerFeeInfos,
                        makerFeeInfoCount,
                        makerFeeReceived + orderUSDAmount,
                        order.trader,
                        false
                    );
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
                            .yesDepositAmount -= tradeShares;
                    } else {
                        traderInfos[order.trader]
                            .noDepositAmount -= tradeShares;
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
                        firstOrderIndex
                    );

                    makerFeeInfoCount = _applyMakerFee(
                        makerFeeInfos,
                        makerFeeInfoCount,
                        tradeUSDCAmount + makerFeeReceived,
                        order.trader,
                        false
                    );
                    _USDCAmountRemain -= tradeUSDCAmount + orderTakerFee;
                }
            }
            priceOrders.firstOrderIndex = firstOrderIndex;

            if (firstOrderIndex >= priceOrders.orders.length) {
                // No more orders at this price, update the best sell price
                if (isYes) {
                    delete yesOrderBook[bestPrice];
                    yesBitmap &= ~(uint128(1 << bestPrice));
                    bestPrice = _changeBestPrice(bestPrice, isYes, true);
                } else {
                    delete noOrderBook[bestPrice];
                    noBitmap &= ~(uint128(1 << bestPrice));
                    bestPrice = _changeBestPrice(bestPrice, isYes, true);
                }
            }
        }

        require(
            totalShareAmountOut >= minShareOut,
            "Insufficient output amount"
        );

        vault.lockDeposit(_USDCAmount - _USDCAmountRemain, msg.sender);

        makerFeeInfoCount = _applyMakerFee(
            makerFeeInfos,
            makerFeeInfoCount,
            0,
            address(0),
            true
        );

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
        uint96 minShareAmountOut
    ) internal {
        uint8 bestPrice = isYes ? bestYesSellPrice : bestNoSellPrice;
        uint96 totalUSDCAmountIn = 0;
        uint96 shareAmountRemain = shareAmount;

        MarkerResultInfo[8] memory makerFeeInfos;
        uint8 makerFeeInfoCount = 0;

        while (shareAmountRemain > 0 && bestPrice != 100) {
            PriceOrders storage priceOrders = isYes
                ? yesOrderBook[bestPrice]
                : noOrderBook[bestPrice];

            uint96 feePerShare = getFeePerShare(bestPrice);

            uint256 firstOrderIndex = priceOrders.firstOrderIndex;

            while (
                firstOrderIndex < priceOrders.orders.length &&
                shareAmountRemain > 0
            ) {
                Order storage order = priceOrders.orders[firstOrderIndex];

                if (
                    order.shareAmount == 0 ||
                    order.version < traderVersions[order.trader]
                ) {
                    firstOrderIndex++;
                    continue;
                }

                if (
                    order.endTimestamp < block.timestamp &&
                    order.endTimestamp != 0
                ) {
                    // Order expired, remove it
                    require(
                        isYes
                            ? traderInfos[order.trader].yesDepositAmount >=
                                order.shareAmount
                            : traderInfos[order.trader].noDepositAmount >=
                                order.shareAmount,
                        "Insufficient deposit to release"
                    );
                    releaseDepositShareAmount(
                        order.shareAmount,
                        order.trader,
                        isYes
                    );

                    order.shareAmount = 0;
                    firstOrderIndex++;
                    continue;
                }

                if (shareAmountRemain >= order.shareAmount) {
                    uint96 orderUSDAmount = (bestPrice * order.shareAmount) /
                        100;
                    uint96 orderTakerFee = (feePerShare * order.shareAmount) /
                        1_000_000;
                    uint96 makerFeeReceived = (orderTakerFee *
                        makerRebateRate) / RATE_SCALE;

                    shareAmountRemain -= order.shareAmount;
                    if (isYes) {
                        traderInfos[order.trader].yesDepositAmount -= order
                            .shareAmount;
                    } else {
                        traderInfos[order.trader].noDepositAmount -= order
                            .shareAmount;
                    }

                    marketFeeReceived += orderTakerFee - makerFeeReceived;

                    emit TradeInfo(
                        order.trader,
                        msg.sender,
                        order.shareAmount,
                        bestPrice,
                        makerFeeReceived,
                        orderTakerFee - makerFeeReceived,
                        true,
                        isYes,
                        firstOrderIndex
                    );
                    firstOrderIndex++;

                    makerFeeInfoCount = _applyMakerFee(
                        makerFeeInfos,
                        makerFeeInfoCount,
                        makerFeeReceived + orderUSDAmount,
                        order.trader,
                        false
                    );

                    order.shareAmount = 0; // Mark the order as fully filled
                    totalUSDCAmountIn += orderUSDAmount + orderTakerFee;
                } else {
                    uint96 tradeTakerFee = (feePerShare * shareAmountRemain) /
                        1_000_000;
                    uint96 tradeUSDCAmount = (bestPrice * shareAmountRemain) /
                        100;
                    uint96 makerFeeReceived = (tradeTakerFee *
                        makerRebateRate) / RATE_SCALE;

                    if (isYes) {
                        traderInfos[order.trader]
                            .yesDepositAmount -= shareAmountRemain;
                    } else {
                        traderInfos[order.trader]
                            .noDepositAmount -= shareAmountRemain;
                    }
                    order.shareAmount -= shareAmountRemain;

                    emit TradeInfo(
                        order.trader,
                        msg.sender,
                        shareAmountRemain,
                        bestPrice,
                        makerFeeReceived,
                        tradeTakerFee - makerFeeReceived,
                        true,
                        isYes,
                        firstOrderIndex
                    );

                    makerFeeInfoCount = _applyMakerFee(
                        makerFeeInfos,
                        makerFeeInfoCount,
                        makerFeeReceived + tradeUSDCAmount,
                        order.trader,
                        false
                    );

                    shareAmountRemain = 0;
                    marketFeeReceived += tradeTakerFee - makerFeeReceived;
                    totalUSDCAmountIn += tradeUSDCAmount + tradeTakerFee;
                }
            }
            priceOrders.firstOrderIndex = firstOrderIndex;

            if (firstOrderIndex >= priceOrders.orders.length) {
                // No more orders at this price, update the best buy price
                if (isYes) {
                    delete yesOrderBook[bestPrice];
                    yesBitmap &= ~(uint128(1 << bestPrice));
                    bestPrice = _changeBestPrice(bestPrice, isYes, true);
                } else {
                    delete noOrderBook[bestPrice];
                    noBitmap &= ~(uint128(1 << bestPrice));
                    bestNoSellPrice++;
                    bestPrice = _changeBestPrice(bestPrice, isYes, true);
                }
                continue; // Skip to the next iteration to check the new best price
            }
        }

        require(
            (shareAmount - shareAmountRemain) <= minShareAmountOut ||
                minShareAmountOut == 0,
            "Insufficient output amount"
        );

        if (isYes) {
            bestYesSellPrice = bestPrice;

            traderInfos[msg.sender].yesAmount +=
                shareAmount -
                shareAmountRemain;
        } else {
            bestNoSellPrice = bestPrice;

            traderInfos[msg.sender].noAmount += shareAmount - shareAmountRemain;
        }

        makerFeeInfoCount = _applyMakerFee(
            makerFeeInfos,
            makerFeeInfoCount,
            0,
            address(0),
            true
        );

        vault.lockDeposit(totalUSDCAmountIn, msg.sender);
    }

    function sellShares(
        uint96 shareAmount,
        bool isYes,
        uint96 minUSDCAmountOut
    ) external onlyOpen nonReentrant {
        require(
            shareAmount >= 1_000_000 &&
                (
                    isYes
                        ? traderInfos[msg.sender].yesAmount >= shareAmount
                        : traderInfos[msg.sender].noAmount >= shareAmount
                ),
            "Invalid share amount"
        );

        _sellShares(shareAmount, isYes, minUSDCAmountOut);
    }

    function _sellShares(
        uint96 shareAmount,
        bool isYes,
        uint96 minUSDCAmountOut
    ) internal {
        uint8 bestPrice = isYes ? bestYesBuyPrice : bestNoBuyPrice;
        uint96 totalUSDCAmountOut = 0;
        uint96 shareAmountRemain = shareAmount;

        MarkerResultInfo[8] memory makerFeeInfos;
        uint8 makerFeeInfoCount = 0;

        while (shareAmountRemain > 0 && bestPrice != 0) {
            PriceOrders storage priceOrders = isYes
                ? yesOrderBook[bestPrice]
                : noOrderBook[bestPrice];

            uint256 firstOrderIndex = priceOrders.firstOrderIndex;

            uint96 feePerShare = getFeePerShare(bestPrice);

            while (
                firstOrderIndex < priceOrders.orders.length &&
                shareAmountRemain > 0
            ) {
                Order storage order = priceOrders.orders[firstOrderIndex];

                if (
                    order.shareAmount == 0 ||
                    order.version < traderVersions[order.trader]
                ) {
                    firstOrderIndex++;
                    continue;
                }

                if (
                    order.endTimestamp < block.timestamp &&
                    order.endTimestamp != 0
                ) {
                    // Order expired, remove it
                    require(
                        traderInfos[order.trader].deposit >=
                            (order.shareAmount * bestPrice) / 100,
                        "Insufficient deposit to release"
                    );
                    vault.releaseDeposit(
                        (order.shareAmount * bestPrice) / 100,
                        order.trader
                    );
                    traderInfos[order.trader].deposit -=
                        (order.shareAmount * bestPrice) /
                        100;

                    order.shareAmount = 0;
                    firstOrderIndex++;
                    continue;
                }

                if (shareAmountRemain >= order.shareAmount) {
                    uint96 orderUSDAmount = (bestPrice * order.shareAmount) /
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
                        firstOrderIndex
                    );
                    firstOrderIndex++;

                    makerFeeInfoCount = _applyMakerFee(
                        makerFeeInfos,
                        makerFeeInfoCount,
                        makerFeeReceived,
                        order.trader,
                        false
                    );

                    traderInfos[order.trader].deposit -= orderUSDAmount;
                    order.shareAmount = 0; // Mark the order as fully filled
                    marketFeeReceived += orderTakerFee - makerFeeReceived;
                    totalUSDCAmountOut += orderUSDAmount - orderTakerFee;
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
                        firstOrderIndex
                    );

                    traderInfos[order.trader].deposit -= tradeUSDCAmount;
                    makerFeeInfoCount = _applyMakerFee(
                        makerFeeInfos,
                        makerFeeInfoCount,
                        makerFeeReceived,
                        order.trader,
                        false
                    );

                    shareAmountRemain = 0;
                    marketFeeReceived += tradeTakerFee - makerFeeReceived;
                    totalUSDCAmountOut += tradeUSDCAmount - tradeTakerFee;
                }
            }
            priceOrders.firstOrderIndex = firstOrderIndex;

            if (firstOrderIndex >= priceOrders.orders.length) {
                // No more orders at this price, update the best buy price
                if (isYes) {
                    delete yesOrderBook[bestPrice];
                    yesBitmap &= ~(uint128(1 << bestPrice));
                    bestPrice = _changeBestPrice(bestPrice, isYes, false);
                } else {
                    delete noOrderBook[bestPrice];
                    noBitmap &= ~(uint128(1 << bestPrice));
                    bestPrice = _changeBestPrice(bestPrice, isYes, false);
                }
                continue; // Skip to the next iteration to check the new best price
            }
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

        makerFeeInfoCount = _applyMakerFee(
            makerFeeInfos,
            makerFeeInfoCount,
            0,
            address(0),
            true
        );

        vault.releaseDeposit(totalUSDCAmountOut, msg.sender);
    }

    function _validateOrderInput(
        uint8 price,
        uint96 shareAmount,
        uint48 endTimestamp
    ) internal view {
        require(price > 0 && price < 100, "invalid price");
        require(shareAmount > 1_000_000, "invalid share amount");
        require(
            endTimestamp > block.timestamp || endTimestamp == 0,
            "invalid endTimestamp"
        );
    }

    function _delectExpiredOrder(bool isYes, bool isBuy) internal {
        uint8 works = 0;
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

            uint256 firstOrderIndex = priceOrders.firstOrderIndex;

            if (firstOrderIndex >= priceOrders.orders.length) {
                works++;
                // No more orders at this price, update the best buy price
                if (isYes) {
                    delete yesOrderBook[bestPrice];
                    yesBitmap &= ~(uint128(1 << bestPrice));
                    bestPrice = _changeBestPrice(bestPrice, isYes, !isBuy);
                } else {
                    delete noOrderBook[bestPrice];
                    noBitmap &= ~(uint128(1 << bestPrice));
                    bestPrice = _changeBestPrice(bestPrice, isYes, !isBuy);
                }

                if (works >= 4 || bestPrice == 0) {
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

            if (works >= 4 || bestPrice == 0) {
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

            while (firstOrderIndex < priceOrders.orders.length && works < 4) {
                works++;

                Order storage order = priceOrders.orders[firstOrderIndex];
                if (
                    order.shareAmount == 0 ||
                    order.version < traderVersions[order.trader]
                ) {
                    order.shareAmount = 0; // Mark the order as invalid
                    firstOrderIndex++;
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
                        traderInfos[order.trader].deposit -= lockedUSDC;
                        vault.releaseDeposit(lockedUSDC, order.trader);
                    } else {
                        // Order expired, remove it
                        releaseDepositShareAmount(
                            order.shareAmount,
                            order.trader,
                            isYes
                        );
                    }
                    order.shareAmount = 0; // Mark the order as invalid
                    firstOrderIndex++;
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

            if (firstOrderIndex < priceOrders.orders.length) {
                break;
            }
            priceOrders.firstOrderIndex = firstOrderIndex;
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
}
