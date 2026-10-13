import { parseAbi, parseUnits, type Address } from "viem";

export const transactionAbi = parseAbi([
  "function mint()",
  "error BalanceNotBelowThreshold()",
  "function approve(address spender, uint256 value) returns (bool)",
  "function deposit(uint96 amount)",
  "function withdraw(uint96 amount)",
  "function orderInsert(uint8 price, uint96 shareAmount, uint48 endTimestamp, bool isBuy, bool isYes, uint8 orderType)",
  "function orderBatchInsert((uint8 prices,uint96 shareAmounts,uint48 endTimestamps,bool isBuy,bool isYes,uint8 orderType)[] orders)",
  "function buyUSDCAmount(uint96 amount, bool isYes, uint96 minShareOut, uint8 orderType, uint8 price)",
  "function sellShares(uint96 amount, bool isYes, uint96 minUSDCAmountOut, uint8 orderType, uint8 price)",
  "function deleteOrder(uint8 price, uint256 orderIndex, bool isYes)",
  "function splitUSDC(uint96 amount)",
  "function mergeShares(uint96 amount)",
  "function redeem()",
]);

export const UNIT = BigInt(1_000_000);
// Values from Market.sol's OrderType enum; only these types are exposed by the UI.
export const OrderType = { Limit: 0, PostOnly: 1, Market: 2, FillOrKill: 3, ImmediateOrCancel: 4 } as const;
const MAX_UINT96 = (BigInt(1) << BigInt(96)) - BigInt(1);

export function amountUnits(value: string, allowZero = false): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(value))
    throw new Error("请输入最多 6 位小数的非负金额或份额。");
  const amount = parseUnits(value, 6);
  if ((!allowZero && amount === BigInt(0)) || amount > MAX_UINT96)
    throw new Error("金额或份额必须大于 0 且不超过 uint96 范围。");
  return amount;
}

export function priceValue(value: string | number): number {
  const price = Number(value);
  if (!Number.isInteger(price) || price < 1 || price > 99)
    throw new Error("价格必须为 1–99 的整数（美分）。");
  return price;
}

export function orderIndexValue(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error("订单索引必须是从 0 开始的整数。");
  const index = BigInt(value);
  if (index >= BigInt(1) << BigInt(256)) throw new Error("订单索引超出范围。");
  return index;
}

export type ContractCall = { address: Address } & (
  | { functionName: "mint" | "redeem"; args: readonly [] }
  | { functionName: "approve"; args: readonly [Address, bigint] }
  | { functionName: "deposit" | "withdraw" | "splitUSDC" | "mergeShares"; args: readonly [bigint] }
  | { functionName: "buyUSDCAmount" | "sellShares"; args: readonly [bigint, boolean, bigint, typeof OrderType.Market, number] }
  | { functionName: "orderInsert"; args: readonly [number, bigint, number, boolean, boolean, number] }
  | { functionName: "orderBatchInsert"; args: readonly [{ prices:number; shareAmounts:bigint; endTimestamps:number; isBuy:boolean; isYes:boolean; orderType:number }[]] }
  | { functionName: "deleteOrder"; args: readonly [number, bigint, boolean] }
);

export type TradeInput = {
  address: Address;
  side: "buy" | "sell";
  outcome: "yes" | "no";
  type: string;
  amount: string;
  price: number;
  minimum: string;
  expiry: string;
};

export function tradeCall(input: TradeInput, now = Date.now()): ContractCall {
  const amount = amountUnits(input.amount);
  const isYes = input.outcome === "yes";
  if (input.type === "limit") {
    if (amount <= UNIT) throw new Error("限价单份额必须大于 1。");
    const expires = input.expiry === "gtc" ? 0
      : input.expiry === "hour" ? Math.floor(now / 1000) + 3600
      : input.expiry === "day" ? Math.floor(now / 1000) + 86400
      : NaN;
    if (!Number.isFinite(expires)) throw new Error("无效的订单有效期。");
    return { address: input.address, functionName: "orderInsert", args: [priceValue(input.price), amount, expires, input.side === "buy", isYes, OrderType.Limit] };
  }
  if (input.type !== "market") throw new Error("无效的订单类型。");
  const minimum = amountUnits(input.minimum, true);
  if (input.side === "buy") {
    if (amount % BigInt(100_000) !== BigInt(0)) throw new Error("市价买入金额必须为 0.1 USDC 的整数倍。");
    return { address: input.address, functionName: "buyUSDCAmount", args: [amount, isYes, minimum, OrderType.Market, 100] };
  }
  if (amount < UNIT) throw new Error("市价卖出至少需要 1 份。");
  return { address: input.address, functionName: "sellShares", args: [amount, isYes, minimum, OrderType.Market, 0] };
}
