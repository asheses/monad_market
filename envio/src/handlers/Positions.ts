import { createEffect, indexer, S, type EvmOnEventContext } from "envio";
import { createPublicClient, http, parseAbi } from "viem";

const client = createPublicClient({
  transport: http(process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz"),
});

const traderInfoAbi = parseAbi([
  "function traderInfos(address trader) view returns (uint96 _USDCLocked, uint96 yesAmount, uint96 yesLockedAmount, uint96 noAmount, uint96 noLockedAmount)",
]);

const readPosition = createEffect(
  {
    name: "readMarketPositionAtBlock",
    input: {
      market: S.string,
      trader: S.string,
      blockNumber: S.number,
      blockHash: S.string,
    },
    output: {
      usdcLocked: S.string,
      yesAmount: S.string,
      yesLocked: S.string,
      noAmount: S.string,
      noLocked: S.string,
    },
    cache: true,
    rateLimit: { calls: 10, per: "second" },
  },
  async ({ input }) => {
    const [usdcLocked, yesAmount, yesLocked, noAmount, noLocked] = await client.readContract({
      address: input.market as `0x${string}`,
      abi: traderInfoAbi,
      functionName: "traderInfos",
      args: [input.trader as `0x${string}`],
      blockNumber: BigInt(input.blockNumber),
    });
    return {
      usdcLocked: usdcLocked.toString(),
      yesAmount: yesAmount.toString(),
      yesLocked: yesLocked.toString(),
      noAmount: noAmount.toString(),
      noLocked: noLocked.toString(),
    };
  },
);

type PositionEvent = {
  srcAddress: string;
  block: { number: number; hash: string; timestamp: number };
};

async function refresh(
  context: EvmOnEventContext,
  event: PositionEvent,
  market: string,
  trader: string,
) {
  const id = `${market}:${trader}`;
  const current = await context.MarketPosition.get(id);
  const position = await context.effect(readPosition, {
    market,
    trader,
    blockNumber: event.block.number,
    blockHash: event.block.hash,
  });
  context.MarketPosition.set({
    id,
    marketAddress: market,
    traderAddress: trader,
    usdcLocked: BigInt(position.usdcLocked),
    yesAmount: BigInt(position.yesAmount),
    yesLocked: BigInt(position.yesLocked),
    noAmount: BigInt(position.noAmount),
    noLocked: BigInt(position.noLocked),
    createdAt: current?.createdAt ?? event.block.timestamp,
    updatedAt: event.block.timestamp,
  });
}

for (const name of ["LockShareAmount", "ReleaseShareAmount", "SplitUSDC", "MergeShares", "Redeem", "OrderInsertInfo", "DeleteOrder", "UpdateVersion"] as const) {
  indexer.onEvent(
    { contract: "Market", event: name },
    async ({ event, context }) => {
      await refresh(context, event, event.srcAddress, event.params.trader);
    },
  );
}

indexer.onEvent(
  { contract: "Market", event: "TradeInfo" },
  async ({ event, context }) => {
    await refresh(context, event, event.srcAddress, event.params.maker);
    if (event.params.taker !== event.params.maker) {
      await refresh(context, event, event.srcAddress, event.params.taker);
    }
  },
);

for (const name of ["LockDeposit", "ReleaseDeposit"] as const) {
  indexer.onEvent(
    { contract: "Vault", event: name },
    async ({ event, context }) => {
      await refresh(context, event, event.params.market, event.params.trader);
    },
  );
}
