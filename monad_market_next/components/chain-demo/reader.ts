"use client";

import { useEffect, useState } from "react";
import { type Address, type Hex } from "viem";
import { useAccount } from "wagmi";

export const DEMO_MARKET: Address = "0x46042b770f4d2d32dc7f16f42d1e7ea3fe739dd1";
export const DEMO_KEY = "monad:2026-09-15:1";

export type BookSide = "bid" | "ask";
export type ChainOrderLevel = { price: number; shares: bigint; side: BookSide; isYes: boolean };
export type BestPrices = {
  bestYesBuyPrice: number;
  bestYesSellPrice: number;
  bestNoBuyPrice: number;
  bestNoSellPrice: number;
};
type ChainData = {
  vault?: bigint;
  trader?: readonly bigint[];
  best?: BestPrices & { marketState: number };
  levels: ChainOrderLevel[];
  loading: boolean;
  error?: string;
};

// Solidity packs the bitmap into the low 16 bytes and the two prices after it.
export function decodeBestPrices(yesWord: Hex, noWord: Hex): BestPrices {
  const unpack = (word: Hex) => {
    const value = BigInt(word);
    return [Number((value >> BigInt(128)) & BigInt(255)), Number((value >> BigInt(136)) & BigInt(255))];
  };
  const [bestYesBuyPrice, bestYesSellPrice] = unpack(yesWord);
  const [bestNoBuyPrice, bestNoSellPrice] = unpack(noWord);
  return { bestYesBuyPrice, bestYesSellPrice, bestNoBuyPrice, bestNoSellPrice };
}

export function nearbyPrices(best: BestPrices): Array<Pick<ChainOrderLevel, "price" | "side" | "isYes">> {
  const queries: Array<Pick<ChainOrderLevel, "price" | "side" | "isYes">> = [];
  for (const isYes of [true, false]) {
    const bid = isYes ? best.bestYesBuyPrice : best.bestNoBuyPrice;
    const ask = isYes ? best.bestYesSellPrice : best.bestNoSellPrice;
    for (let offset = 0; offset < 5; offset++) {
      if (bid - offset >= 1 && bid - offset <= 99) queries.push({ price: bid - offset, side: "bid", isYes });
      if (ask + offset >= 1 && ask + offset <= 99) queries.push({ price: ask + offset, side: "ask", isYes });
    }
  }
  return queries;
}

export function useChainDemoData(market: Address = DEMO_MARKET): ChainData {
  const { address } = useAccount();
  const [data, setData] = useState<ChainData>({ levels: [], loading: true });
  useEffect(() => {
    setData({ levels: [], loading: true });
    const params = new URLSearchParams({ market, stream: "1" });
    if (address) params.set("trader", address);
    const source = new EventSource(`/api/indexer?${params}`);
    let stopped = false;
    let loading = false;
    let pending = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let orders: Array<{ price: number; isYes: boolean; isBuy: boolean; shareAmount: string; endTimestamp: string }> = [];
    const abort = new AbortController();
    const updateLevels = () => {
      if (stopped) return;
      clearTimeout(expiry);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const active = orders.filter(order => BigInt(order.shareAmount) > BigInt(0) &&
        (order.endTimestamp === "0" || BigInt(order.endTimestamp) > now));
      setData(previous => ({ ...previous, levels: active.map(order => ({ price: order.price, isYes: order.isYes,
        side: order.isBuy ? "bid" : "ask", shares: BigInt(order.shareAmount) })) }));
      const deadlines = active.map(order => Number(order.endTimestamp) * 1000).filter(time => time > 0);
      if (deadlines.length) expiry = setTimeout(updateLevels, Math.min(2147483647, Math.max(1, Math.min(...deadlines) - Date.now())));
    };
    const refresh = async () => {
      if (stopped) return;
      if (loading) { pending = true; return; }
      loading = true;
      clearTimeout(retry);
      try {
        const snapshotParams = new URLSearchParams({ market });
        if (address) snapshotParams.set("trader", address);
        const response = await fetch(`/api/indexer?${snapshotParams}`, { cache: "no-store", signal: abort.signal });
        if (!response.ok) throw new Error("无法读取索引器数据。");
        const indexed = await response.json() as {
          MarketState: Array<BestPrices & { marketState: number }>;
          MarketOrders: Array<{ price: number; isYes: boolean; isBuy: boolean; shareAmount: string; endTimestamp: string }>;
          VaultBalance: Array<{ balance: string }>;
          MarketPosition: Array<{ usdcLocked: string; yesAmount: string; yesLocked: string; noAmount: string; noLocked: string }>;
        };
        if (stopped) return;
        const best = indexed.MarketState[0];
        if (!best) throw new Error("该市场暂时没有索引数据。");
        const position = indexed.MarketPosition[0];
        orders = indexed.MarketOrders;
        setData({ best,
          levels: indexed.MarketOrders.map(order => ({ price: order.price, isYes: order.isYes, side: order.isBuy ? "bid" : "ask", shares: BigInt(order.shareAmount) })),
          vault: address ? BigInt(indexed.VaultBalance[0]?.balance ?? "0") : undefined,
          trader: address ? position ? [position.usdcLocked, position.yesAmount, position.yesLocked, position.noAmount, position.noLocked].map(BigInt) : Array<bigint>(5).fill(BigInt(0)) : undefined,
          loading: false });
        updateLevels();
      } catch (error) {
        if (stopped) return;
        retry = setTimeout(() => void refresh(), 3000);
        setData(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : "索引数据读取失败。" }));
      } finally {
        loading = false;
        if (pending && !stopped) { pending = false; void refresh(); }
      }
    };
    const onRefresh = () => void refresh();
    source.addEventListener("refresh", onRefresh);
    const onError = () => setData(previous => ({ ...previous, loading: false, error: "索引数据连接中断，正在重试。" }));
    source.onerror = onError;
    source.addEventListener("indexer-error", onError);
    return () => {
      stopped = true;
      source.close();
      abort.abort();
      clearTimeout(retry);
      clearTimeout(expiry);
    };
  }, [address, market]);
  return data;
}
