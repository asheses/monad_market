"use client";

import { useState, type CSSProperties } from "react";
import { formatUnits } from "viem";
import { DEMO_MARKET, useChainDemoData, type ChainOrderLevel } from "../chain-demo/reader";
import { Icon } from "./icons";
import { Dropdown } from "./ui";

type DisplayLevel = { price: number; startPrice: number; endPrice: number; side: "ask" | "bid"; shares: bigint; total: bigint };

function groupLevels(levels: ChainOrderLevel[], step: number): DisplayLevel[] {
  const groups = new Map<string, DisplayLevel>();
  for (const level of levels) {
    if (level.shares === BigInt(0)) continue;
    const start = Math.floor((level.price - 1) / step) * step + 1;
    const key = `${level.side}:${start}`;
    const total = (level.shares * BigInt(level.price)) / BigInt(100);
    const current = groups.get(key);
    if (current) {
      current.shares += level.shares;
      current.total += total;
      current.price = level.side === "ask" ? Math.min(current.price, level.price) : Math.max(current.price, level.price);
      current.startPrice = Math.min(current.startPrice, level.price);
      current.endPrice = Math.max(current.endPrice, level.price);
    } else {
      groups.set(key, { price: level.price, startPrice: level.price, endPrice: level.price, side: level.side, shares: level.shares, total });
    }
  }
  return [...groups.values()];
}

export function MarketOrderBook({ outcome, onOutcome, onPrice, marketAddress }: {
  probability: number;
  outcome: "yes" | "no";
  onOutcome: (outcome: "yes" | "no") => void;
  onPrice: (price: number) => void;
  marketAddress?: `0x${string}`;
}) {
  const [expanded, setExpanded] = useState(true);
  const [step, setStep] = useState("1");
  const { best, levels, loading, error } = useChainDemoData(marketAddress ?? DEMO_MARKET);
  const isYes = outcome === "yes";
  const shown = groupLevels(levels.filter(level => level.isYes === isYes), Number(step));
  const asks = shown.filter(level => level.side === "ask").sort((a, b) => b.price - a.price);
  const bids = shown.filter(level => level.side === "bid").sort((a, b) => b.price - a.price);
  const maxShares = shown.reduce((max, level) => level.shares > max ? level.shares : max, BigInt(0));
  const bestBid = isYes ? best?.bestYesBuyPrice : best?.bestNoBuyPrice;
  const bestAsk = isYes ? best?.bestYesSellPrice : best?.bestNoSellPrice;
  const spread = bestBid !== undefined && bestAsk !== undefined && bestBid > 0 && bestAsk < 100 ? bestAsk - bestBid : undefined;

  function renderLevel(level: DisplayLevel) {
    const depth = maxShares > BigInt(0) ? Number(level.shares * BigInt(100) / maxShares) : 0;
    return <button key={`${level.side}:${level.price}`} className={`book-row ${level.side}`}
      style={{ "--depth": `${depth}%` } as CSSProperties}
      onClick={() => onPrice(level.price)} aria-label={`将限价设为${level.price}美分`}>
      <span>{level.startPrice === level.endPrice ? `${level.price}¢` : `${level.startPrice}–${level.endPrice}¢`}</span>
      <span>{formatUnits(level.shares, 6)}</span>
      <span>{formatUnits(level.total, 6)}</span>
    </button>;
  }

  return <section className="order-book-section">
    <div className="section-title-row">
      <button className="section-toggle" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        <h2>订单簿</h2><Icon name="chevron" size={16} className={expanded ? "rotated" : ""} />
      </button>
      <div className="book-controls">
        <div className="small-segment" aria-label="订单簿结果">
          <button className={isYes ? "active" : ""} aria-pressed={isYes} onClick={() => onOutcome("yes")}>是 YES</button>
          <button className={!isYes ? "active" : ""} aria-pressed={!isYes} onClick={() => onOutcome("no")}>否 NO</button>
        </div>
        <Dropdown label="价格精度" value={step} options={[{ value: "1", label: "1¢" }, { value: "2", label: "2¢" }, { value: "5", label: "5¢" }]} onChange={setStep} />
      </div>
    </div>
    {expanded && <>
      <div className="order-book-columns"><span>价格 (¢)</span><span>份额</span><span>估算总计 (USDC)</span></div>
      <div className="book-levels">
        {asks.map(renderLevel)}
        {best && <div className="book-spread"><span>最高买价 <strong>{bestBid === 0 ? "—" : `${bestBid}¢`}</strong></span><span>最低卖价 <strong>{bestAsk === 100 ? "—" : `${bestAsk}¢`}</strong></span><span>价差 {spread === undefined ? "—" : `${spread}¢`}</span></div>}
        {bids.map(renderLevel)}
        {!loading && !error && shown.length === 0 && <p className="book-empty">当前没有活跃挂单</p>}
        {loading && <p className="book-empty">正在读取链上订单簿…</p>}
        {error && <p className="book-empty" role="alert">{error}</p>}
      </div>
      <div className="book-hint"><Icon name="info" size={13} /> 点击价格可填写右侧限价</div>
    </>}
  </section>;
}
