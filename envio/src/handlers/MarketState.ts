import { indexer } from "envio";

indexer.onEvent(
  { contract: "Market", event: "SetMarketState" },
  async ({ event, context }) => {
    const state = await context.MarketState.getOrThrow(event.srcAddress);
    context.MarketState.set({ ...state, marketState: Number(event.params._state), updatedAt: event.block.timestamp });
  },
);

indexer.onEvent(
  { contract: "Market", event: "SetOracle" },
  async ({ event, context }) => {
    const state = await context.MarketState.getOrThrow(event.srcAddress);
    context.MarketState.set({ ...state, oracle: event.params._oracle, updatedAt: event.block.timestamp });
    context.ContractRegistry.set({
      id: event.params._oracle,
      name: "Oracle",
      address: event.params._oracle,
      setTime: event.block.timestamp,
    });
  },
);

indexer.onEvent(
  { contract: "Market", event: "ChangeBestPrice" },
  async ({ event, context }) => {
    const state = await context.MarketState.getOrThrow(event.srcAddress);
    const price = Number(event.params.price);
    const kind = Number(event.params.bestPriceType);
    context.MarketState.set({
      ...state,
      ...(kind === 0 ? { bestNoBuyPrice: price } : {}),
      ...(kind === 1 ? { bestNoSellPrice: price } : {}),
      ...(kind === 2 ? { bestYesBuyPrice: price } : {}),
      ...(kind === 3 ? { bestYesSellPrice: price } : {}),
      updatedAt: event.block.timestamp,
    });
  },
);
