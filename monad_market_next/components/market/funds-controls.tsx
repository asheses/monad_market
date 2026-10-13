"use client";

import { useState } from "react";
import { formatUnits, type Address } from "viem";
import { useAccount } from "wagmi";
import { configuredAddress, contractConfig } from "@/lib/contracts/config";
import { amountUnits, orderIndexValue, priceValue, UNIT, type ContractCall } from "@/lib/contracts/transactions";
import { useTransactions } from "../transactions-provider";
import { DEMO_MARKET, useChainDemoData } from "../chain-demo/reader";

// Balances are injected by the future query adapter; undefined never means zero.
export function UsdcControls({ balance }: { balance?: bigint }) {
  const { isConnected } = useAccount();
  const { busy, run } = useTransactions();
  const token = configuredAddress(contractConfig.usdc);
  return <div className="usdc-controls">
    <span title="钱包 USDC 余额；查询服务尚未接入">{balance === undefined ? "—" : formatUnits(balance, 6)} USDC</span>
    <button className="secondary-button" disabled={!token || !isConnected || busy || (balance !== undefined && balance >= UNIT * BigInt(1000))}
      title={!token ? "尚未配置测试 USDC 地址" : "钱包余额低于 1,000 USDC 时可领取；需要 MON 支付 gas"}
      onClick={() => token && void run([{ label: "领取 1,000 测试 USDC", call: { address: token, functionName: "mint", args: [] } }])}>
      Mint 测试 USDC
    </button>
  </div>;
}

const labels = { deposit: "Vault 充值", withdraw: "Vault 提现", splitUSDC: "拆分 USDC", mergeShares: "合并份额", redeem: "结算领取", deleteOrder: "撤单" };
type Action = keyof typeof labels;

export function FundsControls({ marketAddress }: { marketAddress?: Address }) {
  const [action, setAction] = useState<Action>("deposit");
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [index, setIndex] = useState("");
  const [isYes, setIsYes] = useState(true);
  const [error, setError] = useState("");
  const { isConnected } = useAccount();
  const { busy, run } = useTransactions();
  const chain = useChainDemoData(marketAddress ?? DEMO_MARKET);
  const vault = configuredAddress(contractConfig.vault);
  const token = configuredAddress(contractConfig.usdc);
  const destination = action === "deposit" || action === "withdraw" ? vault : marketAddress;

  async function submit() {
    setError("");
    try {
      if (!destination) throw new Error("尚未配置合约地址。");
      let call: ContractCall;
      if (action === "redeem") call = { address: destination, functionName: action, args: [] };
      else if (action === "deleteOrder") call = { address: destination, functionName: action, args: [priceValue(price), orderIndexValue(index), isYes] };
      else {
        const value = amountUnits(amount);
        if (action === "splitUSDC" && value <= UNIT) throw new Error("拆分金额必须大于 1 USDC。");
        call = { address: destination, functionName: action, args: [value] };
        if (action === "deposit") {
          if (!token) throw new Error("尚未配置 USDC 地址。");
          await run([
            { label: "授权本次充值金额", call: { address: token, functionName: "approve", args: [destination, value] } },
            { label: labels[action], call },
          ]);
          return;
        }
      }
      await run([{ label: labels[action], call }]);
    } catch (error) { setError(error instanceof Error ? error.message : "输入无效。"); }
  }

  return <section className="funds-panel">
    <h3>资金与订单管理</h3>
    <div className="chain-funds"><span>Vault 可用 USDC：{chain.vault === undefined ? "—" : formatUnits(chain.vault, 6)}</span><span>YES：{chain.trader ? formatUnits(chain.trader[1], 6) : "—"}</span><span>NO：{chain.trader ? formatUnits(chain.trader[3], 6) : "—"}</span></div>
    <fieldset disabled={busy}>
      <label>操作<select value={action} onChange={event => { setAction(event.target.value as Action); setError(""); }}>
        {Object.entries(labels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select></label>
      {action !== "redeem" && action !== "deleteOrder" && <label>{action === "mergeShares" ? "合并配对份额" : "数量（USDC）"}
        <input value={amount} inputMode="decimal" onChange={event => setAmount(event.target.value)} placeholder="最多 6 位小数" />
      </label>}
      {action === "deleteOrder" && <>
        <label>结果<select value={isYes ? "yes" : "no"} onChange={event => setIsYes(event.target.value === "yes")}><option value="yes">YES</option><option value="no">NO</option></select></label>
        <label>订单价格（1–99¢）<input value={price} inputMode="numeric" onChange={event => setPrice(event.target.value)} /></label>
        <label>订单索引（从 0 开始）<input value={index} inputMode="numeric" onChange={event => setIndex(event.target.value)} /></label>
        <p>填写原订单的价格、结果和索引；订单列表将在查询服务接入后提供。</p>
      </>}
      <p>{action === "deposit" ? "分两笔交易：授权本次金额，再充值到 Vault。授权成功但充值失败时，授权仍然有效。"
        : action === "withdraw" ? "将 Vault 可用 USDC 提回当前钱包。"
        : action === "splitUSDC" ? "每 1 USDC 拆分为 1 YES + 1 NO，使用 Vault 可用余额。"
        : action === "mergeShares" ? "销毁相同数量的可用 YES 和 NO，将 USDC 退回 Vault。"
        : action === "redeem" ? "市场结算后领取获胜份额及订单退款到 Vault；再通过提现转入钱包。" : "仅能撤销当前钱包在所选市场的订单。"}</p>
      <button className="primary-button full-width" disabled={busy || !isConnected || !destination || (action === "deposit" && !token)} onClick={() => void submit()}>
        {!isConnected ? "请先连接钱包" : !destination || (action === "deposit" && !token) ? "尚未配置合约地址" : labels[action]}
      </button>
    </fieldset>
    {error && <p role="alert" className="text-red">{error}</p>}
  </section>;
}
