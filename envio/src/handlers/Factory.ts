import { indexer } from "envio";

const vaultAddress = "0x5fe1b0b06c228252427b26087ccf2d573c5ff142";
const factoryAddress = "0x7498c4f4e23921d0029a3384beb594431eb46d44";

indexer.contractRegister(
  { contract: "MarketFactory", event: "CreateMarket" },
  async ({ event, context }) => {
    context.chain.Market.add(event.params.market);
  },
);

indexer.onEvent(
  { contract: "MarketFactory", event: "CreateMarket" },
  async ({ event, context }) => {
    const address = event.params.market;
    const now = event.block.timestamp;
    context.MarketState.set({
      id: address,
      marketAddress: address,
      takerFeeRate: event.params.feeRate,
      makerRebateRate: event.params.makerRebateRate,
      marketState: 0,
      oracle: event.params.oracle,
      vault: vaultAddress,
      marketFeeReceived: 0n,
      bestNoBuyPrice: 0,
      bestNoSellPrice: 100,
      bestYesBuyPrice: 0,
      bestYesSellPrice: 100,
      createdAt: now,
      updatedAt: now,
    });
    context.ContractRegistry.set({
      id: address,
      name: "Market",
      address,
      setTime: now,
    });
    context.ContractRegistry.set({
      id: event.params.oracle,
      name: "Oracle",
      address: event.params.oracle,
      setTime: now,
    });
  },
);

indexer.onEvent(
  { contract: "MarketFactory", event: "SetVault" },
  async ({ event, context }) => {
    const address = event.params.vaultAddress;
    context.ContractRegistry.set({
      id: address,
      name: "Vault",
      address,
      setTime: event.block.timestamp,
    });
    context.ContractRegistry.set({
      id: factoryAddress,
      name: "MarketFactory",
      address: factoryAddress,
      setTime: event.block.timestamp,
    });
  },
);

indexer.onEvent(
  { contract: "Vault", event: "SetMarketFactory" },
  async ({ event, context }) => {
    context.ContractRegistry.set({
      id: event.params.marketFactory,
      name: "MarketFactory",
      address: event.params.marketFactory,
      setTime: event.block.timestamp,
    });
  },
);

indexer.onEvent(
  { contract: "Vault", event: "RegisterMarket" },
  async ({ event, context }) => {
    context.ContractRegistry.set({
      id: event.params.market,
      name: "Market",
      address: event.params.market,
      setTime: event.block.timestamp,
    });
  },
);
