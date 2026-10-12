import { indexer, type VaultBalance, type VaultTransaction } from "envio";

type EventMeta = {
  transaction: { hash: string };
  logIndex: number;
  block: { timestamp: number };
};

function transaction(
  event: EventMeta,
  tradeType: string,
  traderAddress: string | undefined,
  usdcAmount: bigint,
  marketAddress: string | undefined,
): VaultTransaction {
  const hash = event.transaction.hash;
  return {
    id: `${hash.toLowerCase()}:${event.logIndex}`,
    tradeType,
    traderAddress,
    usdcAmount,
    marketAddress,
    transactionHash: hash,
    logIndex: event.logIndex,
    timestamp: event.block.timestamp,
  };
}

async function balanceChange(
  trader: string,
  amount: bigint,
  now: number,
  get: (id: string) => Promise<VaultBalance | undefined>,
  set: (row: VaultBalance) => void,
) {
  const current = await get(trader);
  const next = (current?.balance ?? 0n) + amount;
  if (next < 0n) throw new Error(`Negative Vault balance for ${trader}`);
  set({
    id: trader,
    traderAddress: trader,
    balance: next,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  });
}

indexer.onEvent(
  { contract: "Vault", event: "Deposit" },
  async ({ event, context }) => {
    const p = event.params;
    await balanceChange(p.trader, p._USDCAmount, event.block.timestamp,
      (id) => context.VaultBalance.get(id), (row) => context.VaultBalance.set(row));
    context.VaultTransaction.set(transaction(event, "DEPOSIT", p.trader, p._USDCAmount, undefined));
  },
);

indexer.onEvent(
  { contract: "Vault", event: "WithDraw" },
  async ({ event, context }) => {
    const p = event.params;
    await balanceChange(p.trader, -p._USDCAmount, event.block.timestamp,
      (id) => context.VaultBalance.get(id), (row) => context.VaultBalance.set(row));
    context.VaultTransaction.set(transaction(event, "WITHDRAW", p.trader, p._USDCAmount, undefined));
  },
);

indexer.onEvent(
  { contract: "Vault", event: "LockDeposit" },
  async ({ event, context }) => {
    const p = event.params;
    await balanceChange(p.trader, -p._USDCAmount, event.block.timestamp,
      (id) => context.VaultBalance.get(id), (row) => context.VaultBalance.set(row));
    context.VaultTransaction.set(transaction(event, "LOCK_DEPOSIT", p.trader, p._USDCAmount, p.market));
  },
);

indexer.onEvent(
  { contract: "Vault", event: "ReleaseDeposit" },
  async ({ event, context }) => {
    const p = event.params;
    await balanceChange(p.trader, p._USDCAmount, event.block.timestamp,
      (id) => context.VaultBalance.get(id), (row) => context.VaultBalance.set(row));
    context.VaultTransaction.set(transaction(event, "RELEASE_DEPOSIT", p.trader, p._USDCAmount, p.market));
  },
);

indexer.onEvent(
  { contract: "Vault", event: "ApplyMakerResult" },
  async ({ event, context }) => {
    const p = event.params;
    await balanceChange(p.trader, p._USDCAmount, event.block.timestamp,
      (id) => context.VaultBalance.get(id), (row) => context.VaultBalance.set(row));
    context.VaultTransaction.set(transaction(event, "APPLY_MAKER_RESULT", p.trader, p._USDCAmount, p.market));
  },
);

indexer.onEvent(
  { contract: "Vault", event: "GetMarketFee" },
  async ({ event, context }) => {
    const p = event.params;
    context.VaultTransaction.set(transaction(event, "GET_MARKET_FEE", undefined, p._USDCAmount, p.market));
    const state = await context.MarketState.getOrThrow(p.market);
    context.MarketState.set({ ...state, marketFeeReceived: 0n, updatedAt: event.block.timestamp });
  },
);

indexer.onEvent(
  { contract: "Vault", event: "WithDrawFee" },
  async ({ event, context }) => {
    const p = event.params;
    context.VaultTransaction.set(transaction(event, "WITHDRAW_FEE", p.owner, p._USDCAmount, undefined));
  },
);
