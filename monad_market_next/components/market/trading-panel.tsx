"use client";
import { useState } from "react";
import { formatUnits } from "viem";
import { useAccount } from "wagmi";
import { type DemoMarket, targetLabel } from "@/lib/market-data";
import { configuredAddress, marketAddresses, marketKey } from "@/lib/contracts/config";
import { tradeCall } from "@/lib/contracts/transactions";
import { useTransactions } from "../transactions-provider";
import { FundsControls } from "./funds-controls";
import { AssetSymbol } from "./icons";
import { Dropdown, Modal } from "./ui";
import { DEMO_MARKET, useChainDemoData } from "../chain-demo/reader";

export function TradingPanel({ market, day, target, outcome, onOutcome, orderType, onOrderType, price, onPrice }: {
  market: DemoMarket;
  day: number;
  target: number;
  probability: number;
  outcome: "yes" | "no";
  onOutcome: (value: "yes" | "no") => void;
  orderType: string;
  onOrderType: (value: string) => void;
  price: number;
  onPrice: (value: number) => void;
  onNotice: (message: string) => void;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [expiry, setExpiry] = useState("gtc");
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState("");
  const { isConnected } = useAccount();
  const { busy, run } = useTransactions();
  const address = configuredAddress(market.chainAddress) ?? configuredAddress(marketAddresses[marketKey(market.id, day, target)]);
  const chain = useChainDemoData(address ?? DEMO_MARKET);
  const yesPrice = side === "buy" ? chain.best?.bestYesSellPrice : chain.best?.bestYesBuyPrice;
  const noPrice = side === "buy" ? chain.best?.bestNoSellPrice : chain.best?.bestNoBuyPrice;
  const marketClosed = chain.best !== undefined && chain.best.marketState !== 0;
  const cashInput = orderType === "market" && side === "buy";
  const input = { address: address!, side, outcome, type: orderType, amount, price, minimum: "0", expiry };
  function validate() {
    setError("");
    try {
      if (!address) throw new Error("尚未配置当前市场地址。");
      tradeCall(input);
      setPreview(true);
    } catch (error) { setError(error instanceof Error ? error.message : "输入无效。"); }
  }
  async function submit() {
    setError("");
    try {
      if (!address) throw new Error("尚未配置当前市场地址。");
      const ok = await run([{ label: `${orderType === "limit" ? "限价" : "市价"}${side === "buy" ? "买入" : "卖出"}`, call: tradeCall(input) }]);
      if (ok) { setPreview(false); setAmount(""); }
    } catch (error) { setError(error instanceof Error ? error.message : "输入无效。"); }
  }
  return <aside className="trade-sidebar">
    <div className="trading-panel" id="trade-panel">
      <div className="panel-market-summary">
        <div className="mini-market-icon" style={{ background: market.color }}><AssetSymbol symbol={market.symbol} fallback={market.icon} /></div>
        <div><div className="panel-question">{market.title}在9月{day}日高于</div><div className="panel-answer">${targetLabel(target)} · {outcome === "yes" ? "是" : "否"}</div></div>
        <span className="demo-badge">测试网</span>
      </div>
      <fieldset disabled={busy} className="trade-fieldset">
        <div className="panel-tabs">
          <button className={side === "buy" ? "active" : ""} onClick={() => { setSide("buy"); setAmount(""); }}>买入</button>
          <button className={side === "sell" ? "active" : ""} onClick={() => { setSide("sell"); setAmount(""); }}>卖出</button>
          <Dropdown label="订单类型" value={orderType} options={[{ value: "market", label: "市价单" }, { value: "limit", label: "限价单" }]} onChange={onOrderType} />
        </div>
        <div className="panel-form">
          <div className="outcome-buttons">
            <button className={`yes ${outcome === "yes" ? "active" : ""}`} onClick={() => onOutcome("yes")}><span>是 YES</span><small>{yesPrice === undefined || yesPrice === 0 || yesPrice === 100 ? "—" : `${yesPrice}¢`}</small></button>
            <button className={`no ${outcome === "no" ? "active" : ""}`} onClick={() => onOutcome("no")}><span>否 NO</span><small>{noPrice === undefined || noPrice === 0 || noPrice === 100 ? "—" : `${noPrice}¢`}</small></button>
          </div>
          {orderType === "limit" && <div className="limit-section"><label htmlFor="limit-price">限价（每份 / ¢）</label><div className="price-input"><button type="button" aria-label="降低限价" onClick={() => onPrice(Math.max(1, price - 1))} disabled={price <= 1}>−</button><input id="limit-price" type="number" min={1} max={99} step={1} value={price} onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 99) onPrice(value); }} /><button type="button" aria-label="提高限价" onClick={() => onPrice(Math.min(99, price + 1))} disabled={price >= 99}>+</button></div></div>}
          <div className="amount-label"><label htmlFor="trade-amount">{cashInput ? "金额" : "份额"}</label><span>{side === "buy" ? `Vault 可用 USDC：${chain.vault === undefined ? "—" : formatUnits(chain.vault, 6)}` : `可用 ${outcome.toUpperCase()}：${chain.trader === undefined ? "—" : formatUnits(chain.trader[outcome === "yes" ? 1 : 3], 6)}`}</span></div>
          <div className="amount-input-wrap"><input id="trade-amount" inputMode="decimal" placeholder="0" value={amount} onChange={event => setAmount(event.target.value)} /><span className="amount-unit">{cashInput ? "USDC" : "份"}</span></div>
          <p className="trade-disclaimer">{cashInput ? "买入金额须为 0.1 USDC 的整数倍。" : orderType === "limit" ? "份额须大于 1，最多 6 位小数。" : "卖出至少 1 份，最多 6 位小数。"}</p>
          {orderType === "limit" && <div className="expiry-row"><span>有效期</span><Dropdown label="订单有效期" value={expiry} options={[{ value: "gtc", label: "直到取消" }, { value: "day", label: "24 小时" }, { value: "hour", label: "1 小时" }]} onChange={setExpiry} /></div>}
          {error && <p role="alert" className="text-red">{error}</p>}
          <button className={`panel-cta ${outcome === "no" ? "negative" : ""}`} disabled={busy || marketClosed || !isConnected || !address} onClick={validate}>{!isConnected ? "请先连接钱包" : !address ? "尚未配置当前市场地址" : marketClosed ? "市场已结算" : "预览订单"}</button>
          <p className="trade-disclaimer">订单将在 Monad Testnet 提交；页面行情为演示数据，真实成交以合约执行为准。</p>
        </div>
      </fieldset>
    </div>
    <FundsControls marketAddress={address} />
    {preview && <Modal title="确认订单" onClose={() => { if (!busy) setPreview(false); }}>
      <h3>{market.title} · 9月{day}日 · ${targetLabel(target)}</h3>
      <div className="preview-details">
        <div><span>方向</span><strong>{side === "buy" ? "买入" : "卖出"} {outcome.toUpperCase()} · {orderType === "limit" ? "限价单" : "市价单"}</strong></div>
        <div><span>{cashInput ? "最大支出" : "提交份额"}</span><strong>{amount} {cashInput ? "USDC" : "份"}</strong></div>
        {orderType === "limit" && <><div><span>限价</span><strong>{price}¢</strong></div><div><span>有效期</span><strong>{expiry === "gtc" ? "直到取消" : expiry === "day" ? "提交起 24 小时" : "提交起 1 小时"}</strong></div></>}
      </div>
      <p className="modal-note">{orderType === "limit" ? "订单按所填限价或更优价格撮合，未成交份额将继续挂单，直到成交、取消或到期。" : "成交价格、手续费和实际成交数量由链上订单簿决定。"}</p>
      <p className="contract-destination">市场：{address}</p>
      {error && <p role="alert" className="text-red">{error}</p>}
      <button className="primary-button full-width" disabled={busy} onClick={() => void submit()}>{busy ? "交易处理中…" : "确认并在钱包中签名"}</button>
    </Modal>}
  </aside>;
}
