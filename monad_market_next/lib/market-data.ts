export type MarketPricePoint = { timestamp: number; price: number };
export type DemoMarket = {
  id: string;
  title: string;
  category: string;
  symbol: string;
  icon: string;
  color: string;
  price: number;
  change: number;
  volume: number;
  probability: number;
  targets: number[];
  chainAddress?: string;
  settleAt?: string;
  status?: string;
};
// Database settlement timestamps are displayed in the market's UTC+8 timezone.
export function marketDateLabel(market: DemoMarket, day = 15, includeYear = false) {
  if (!market.settleAt) return `${includeYear ? "2026年" : ""}9月${day}日`;
  const date = new Date(market.settleAt);
  if (Number.isNaN(date.getTime())) return "日期待确认";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(date);
  const value = (type: string) => parts.find(part => part.type === type)?.value;
  return `${includeYear ? `${value("year")}年` : ""}${value("month")}月${value("day")}日`;
}
export function marketSettlementLabel(market: DemoMarket, day = 15) {
  if (!market.settleAt) return `2026/09/${day} 12:00 UTC`;
  const date = new Date(market.settleAt);
  if (Number.isNaN(date.getTime())) return "时间待确认";
  return `${new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(date)} UTC+8`;
}
export const markets: DemoMarket[] = [
  {
    id: "bitcoin",
    title: "比特币",
    category: "加密货币",
    symbol: "BTC",
    icon: "₿",
    color: "#f7931a",
    price: 77354.01,
    change: 2.12,
    volume: 452540,
    probability: 64,
    targets: [74000, 76000, 78000, 80000, 82000],
  },
  {
    id: "ethereum",
    title: "以太坊",
    category: "加密货币",
    symbol: "ETH",
    icon: "Ξ",
    color: "#6c7de9",
    price: 2846.32,
    change: 1.84,
    volume: 286320,
    probability: 72,
    targets: [2600, 2800, 3000, 3200, 3400],
  },
  {
    id: "monad",
    title: "Monad",
    category: "加密货币",
    symbol: "MON",
    icon: "M",
    color: "#8361ec",
    price: 0.84,
    change: 5.26,
    volume: 198760,
    probability: 58,
    targets: [0.6, 0.8, 1, 1.2, 1.4],
  },
  {
    id: "solana",
    title: "Solana",
    category: "加密货币",
    symbol: "SOL",
    icon: "◎",
    color: "#242d43",
    price: 168.42,
    change: -1.35,
    volume: 174280,
    probability: 46,
    targets: [140, 160, 180, 200, 220],
  },
  {
    id: "sp500",
    title: "标普 500",
    category: "金融",
    symbol: "SPX",
    icon: "↗",
    color: "#3481b8",
    price: 5842.6,
    change: 0.62,
    volume: 328650,
    probability: 67,
    targets: [5600, 5800, 6000, 6200, 6400],
  },
  {
    id: "gold",
    title: "黄金",
    category: "金融",
    symbol: "XAU",
    icon: "Au",
    color: "#bc933c",
    price: 3284.5,
    change: 0.93,
    volume: 216400,
    probability: 62,
    targets: [3000, 3200, 3400, 3600, 3800],
  },
];
export const money = (value: number) =>
  value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
export const targetLabel = (value: number | undefined) =>
  (value ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
export function probabilityFor(market: DemoMarket, index: number, day: number) {
  return Math.max(
    3,
    Math.min(97, market.probability + (2 - index) * 17 + (day - 15) * 2),
  );
}
export function makePriceData(
  market: DemoMarket,
  day: number,
  range: string,
): MarketPricePoint[] {
  const hours =
    (
      { "1H": 1, "6H": 6, "1D": 24, "1W": 168, ALL: 336 } as Record<
        string,
        number
      >
    )[range] ?? 24;
  const end = Date.UTC(2026, 8, day, 12);
  const oscillation = (i: number) =>
    Math.sin(i * 1.9 + day + hours * 0.03) * 0.003 +
    Math.sin(i * 0.47 + hours * 0.01) * 0.007 +
    Math.cos(i * 0.17 + hours * 0.02) * 0.008;
  return Array.from({ length: 85 }, (_, i) => {
    const t = i / 84;
    const movement = oscillation(i);
    const anchor = oscillation(84);
    return {
      timestamp: end - (1 - t) * hours * 3600000,
      price:
        market.price *
        (1 + (movement - anchor + (t - 1) * 0.032) * Math.sqrt(hours / 24)),
    };
  });
}
