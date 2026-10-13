"use client";
import { formatUnits } from "viem";
import { useChainDemoData, DEMO_MARKET } from "./reader";
export function ChainAccountPanel() { const data = useChainDemoData(DEMO_MARKET); const t = data.trader; return <div className="chain-account-panel"><strong>链上数据 Demo</strong><span>Vault：{data.vault === undefined ? "—" : formatUnits(data.vault, 6)} USDC</span><span>YES：{t ? formatUnits(t[1], 6) : "—"}</span><span>NO：{t ? formatUnits(t[3], 6) : "—"}</span></div>; }
