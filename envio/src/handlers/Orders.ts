import { indexer } from "envio";

function slot(market: string, isYes: boolean, price: number, index: bigint) {
  return `${market}:${isYes ? "yes" : "no"}:${price}:${index}`;
}

function eventId(hash: string, logIndex: number) {
  return `${hash.toLowerCase()}:${logIndex}`;
}

indexer.onEvent(
  { contract: "Market", event: "OrderInsertInfo" },
  async ({ event, context }) => {
    const p = event.params;
    const id = slot(event.srcAddress, p.isYes, Number(p.price), p.index);
    const logId = eventId(event.transaction.hash, event.logIndex);
    context.MarketOrders.set({
      id,
      marketAddress: event.srcAddress,
      traderAddress: p.trader,
      isYes: p.isYes,
      isBuy: p.isBuy,
      price: Number(p.price),
      orderIndex: p.index,
      version: Number(p.version),
      shareAmount: p.shareAmount,
      endTimestamp: p.endTimestamp,
      insertEventId: logId,
      createdAt: event.block.timestamp,
      updatedAt: event.block.timestamp,
    });
    context.MarketOrderHistory.set({
      id: logId,
      marketAddress: event.srcAddress,
      traderAddress: p.trader,
      orderType: "OrderInsert",
      price: Number(p.price),
      shareAmount: p.shareAmount,
      endTimestamp: p.endTimestamp,
      version: Number(p.version),
      isBuy: p.isBuy,
      isYes: p.isYes,
      orderIndex: p.index,
      transactionHash: event.transaction.hash,
      logIndex: event.logIndex,
      timestamp: event.block.timestamp,
    });
  },
);

indexer.onEvent(
  { contract: "Market", event: "UpdateVersion" },
  async ({ event, context }) => {
    const p = event.params;
    const orders = await context.MarketOrders.getWhere({
      marketAddress: { _eq: event.srcAddress },
      traderAddress: { _eq: p.trader },
    });
    for (const order of orders) {
      if (order.version < Number(p.newVersion)) context.MarketOrders.deleteUnsafe(order.id);
    }
    context.MarketOrderHistory.set({
      id: eventId(event.transaction.hash, event.logIndex),
      marketAddress: event.srcAddress,
      traderAddress: p.trader,
      orderType: "UpdateVersion",
      price: undefined,
      shareAmount: undefined,
      endTimestamp: undefined,
      version: Number(p.newVersion),
      isBuy: undefined,
      isYes: undefined,
      orderIndex: undefined,
      transactionHash: event.transaction.hash,
      logIndex: event.logIndex,
      timestamp: event.block.timestamp,
    });
  },
);

indexer.onEvent(
  { contract: "Market", event: "DeleteOrder" },
  async ({ event, context }) => {
    const p = event.params;
    const id = slot(event.srcAddress, p.isYes, Number(p.price), p.orderIndex);
    const order = await context.MarketOrders.get(id);
    context.MarketOrders.deleteUnsafe(id);
    context.MarketOrderHistory.set({
      id: eventId(event.transaction.hash, event.logIndex),
      marketAddress: event.srcAddress,
      traderAddress: p.trader,
      orderType: "DeleteOrder",
      price: Number(p.price),
      shareAmount: order?.shareAmount,
      endTimestamp: order?.endTimestamp,
      version: order?.version,
      isBuy: order?.isBuy,
      isYes: p.isYes,
      orderIndex: p.orderIndex,
      transactionHash: event.transaction.hash,
      logIndex: event.logIndex,
      timestamp: event.block.timestamp,
    });
  },
);

indexer.onEvent(
  { contract: "Market", event: "TradeInfo" },
  async ({ event, context }) => {
    const p = event.params;
    const logId = eventId(event.transaction.hash, event.logIndex);
    const id = slot(event.srcAddress, p.isYes, Number(p.price), p.index);
    const order = await context.MarketOrders.get(id);
    if (!order) throw new Error(`TradeInfo references unknown order ${id}`);
    if (order.traderAddress !== p.maker || order.shareAmount < p.shareAmount) {
      throw new Error(`TradeInfo does not match active order ${id}`);
    }
    const remaining = order.shareAmount - p.shareAmount;
    if (remaining === 0n) {
      context.MarketOrders.deleteUnsafe(id);
    } else {
      context.MarketOrders.set({ ...order, shareAmount: remaining, updatedAt: event.block.timestamp });
    }
    context.MarketTransaction.set({
      id: logId,
      marketAddress: event.srcAddress,
      makerAddress: p.maker,
      takerAddress: p.taker,
      shareAmount: p.shareAmount,
      price: Number(p.price),
      makerFeeAmount: p.makerFeeAmount,
      marketFeeAmount: p.marketFeeAmount,
      isBuy: p.isBuy,
      isYes: p.isYes,
      orderIndex: p.index,
      transactionHash: event.transaction.hash,
      logIndex: event.logIndex,
      timestamp: event.block.timestamp,
    });
    const state = await context.MarketState.getOrThrow(event.srcAddress);
    context.MarketState.set({
      ...state,
      marketFeeReceived: state.marketFeeReceived + p.marketFeeAmount,
      updatedAt: event.block.timestamp,
    });
  },
);
