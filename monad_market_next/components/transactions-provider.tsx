"use client";

import { createContext, useContext, useRef, useState } from "react";
import { BaseError, type Hash } from "viem";
import { monadTestnet } from "viem/chains";
import { getAccount, getWalletClient } from "@wagmi/core";
import { useAccount, useConfig, usePublicClient, useSwitchChain } from "wagmi";
import { transactionAbi, type ContractCall } from "@/lib/contracts/transactions";

type Step = { label: string; call: ContractCall };
type Transactions = {
  busy: boolean;
  run: (steps: Step[]) => Promise<boolean>;
};
const Context = createContext<Transactions | null>(null);

export function TransactionsProvider({ children }: { children: React.ReactNode }) {
  const config = useConfig();
  const { address } = useAccount();
  const client = usePublicClient({ chainId: monadTestnet.id });
  const { switchChainAsync } = useSwitchChain();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [hash, setHash] = useState<Hash>();
  const [failed, setFailed] = useState(false);

  async function run(steps: Step[]) {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setHash(undefined);
    setFailed(false);
    let submitted = false;
    try {
      if (!address || !client) throw new Error("请先连接钱包。");
      const sender = address;
      if (getAccount(config).chainId !== monadTestnet.id) {
        setStatus("请在钱包中切换到 Monad Testnet。");
        await switchChainAsync({ chainId: monadTestnet.id });
      }
      for (const step of steps) {
        setHash(undefined);
        submitted = false;
        const assertAccount = () => {
          const current = getAccount(config);
          if (current.address !== sender || current.chainId !== monadTestnet.id)
            throw new Error("钱包账户或网络已改变，请重新提交。");
        };
        assertAccount();
        const wallet = await getWalletClient(config, { chainId: monadTestnet.id });
        setStatus(`${step.label}：检查交易…`);
        if (!await client.getCode({ address: step.call.address }))
          throw new Error("配置的地址在 Monad Testnet 上没有合约代码。");
        const { request } = await client.simulateContract({
          ...step.call, abi: transactionAbi, account: sender,
        });
        assertAccount();
        setStatus(`${step.label}：请在钱包中确认。`);
        const tx = await wallet.writeContract(request);
        submitted = true;
        setHash(tx);
        setStatus(`${step.label}：已提交，等待链上确认…`);
        let replacedWithDifferentCall = false;
        const receipt = await client.waitForTransactionReceipt({
          hash: tx,
          onReplaced: replacement => {
            setHash(replacement.transaction.hash);
            if (replacement.reason !== "repriced") replacedWithDifferentCall = true;
          },
        });
        if (replacedWithDifferentCall) {
          submitted = false;
          throw new Error(`${step.label}已在钱包中取消或被其他交易替换，未继续后续操作。`);
        }
        if (receipt.status !== "success") {
          submitted = false;
          throw new Error(`${step.label}交易已回滚。`);
        }
        submitted = false;
        // Future balance / order query adapters can subscribe to this event.
        window.dispatchEvent(new CustomEvent("market:transaction-confirmed", {
          detail: { hash: receipt.transactionHash, account: sender, call: step.call.functionName },
        }));
        setHash(receipt.transactionHash);
        setStatus(`${step.label}：链上确认成功。`);
      }
      return true;
    } catch (error) {
      setFailed(true);
      const message = error instanceof BaseError ? error.shortMessage
        : error instanceof Error ? error.message : "交易失败，请重试。";
      setStatus(submitted ? `交易已广播，但暂未取得回执；请通过交易链接检查状态，避免重复提交。${message}` : message);
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return <Context.Provider value={{ busy, run }}>
    {children}
    {status && <div className={`transaction-status ${failed ? "transaction-error" : ""}`} role="status" aria-live="polite">
      <span>{status}</span>
      {hash && <a href={`${monadTestnet.blockExplorers.default.url}/tx/${hash}`} target="_blank" rel="noreferrer">查看交易 ↗</a>}
      {!busy && <button aria-label="关闭交易状态" onClick={() => setStatus("")}>×</button>}
    </div>}
  </Context.Provider>;
}

export function useTransactions() {
  const value = useContext(Context);
  if (!value) throw new Error("TransactionsProvider is required");
  return value;
}
