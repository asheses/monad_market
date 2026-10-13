import "server-only";
import { Client } from "pg";
import { createPublicClient, createWalletClient, http, parseAbi, decodeEventLog, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const rpc = process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const dbUrl = process.env.ENVIO_DATABASE_URL ?? "postgresql://postgres:testing@127.0.0.1:5433/envio-dev";
const chainId = 10143;
const factoryAbi = parseAbi(["function createMarket(address oracle,uint96 feeRate,uint96 makerRebateRate) returns (address market)"]);
const vaultAbi = parseAbi(["function setMarketState(uint8 state)"]);
function key(value: string) { return value.startsWith("0x") ? value as `0x${string}` : `0x${value}` as `0x${string}`; }
function account(name: "PRIVATE_KEY" | "ORACLE_PRIVATE_KEY") {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 未配置`);
  return privateKeyToAccount(key(value));
}
export async function db() { const client = new Client({ connectionString: dbUrl }); await client.connect(); return client; }
export async function createMarketOnChain(oracle: Address, feeRate: bigint, rebate: bigint) {
  const owner = account("PRIVATE_KEY");
  const wallet = createWalletClient({ account: owner, chain: { id: chainId, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }, transport: http(rpc) });
  const factory = process.env.FACTORY_ADDRESS ?? process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
  if (!factory) throw new Error("FACTORY_ADDRESS 未配置");
  const hash = await wallet.writeContract({ address: factory as Address, abi: factoryAbi, functionName: "createMarket", args: [oracle, feeRate, rebate] });
  const receipt = await createPublicClient({ transport: http(rpc) }).waitForTransactionReceipt({ hash });
  const event = receipt.logs.map(log => { try { return decodeEventLog({ abi: parseAbi(["event CreateMarket(address market,address oracle,uint96 feeRate,uint96 makerRebateRate)"]), data: log.data, topics: log.topics }); } catch { return undefined; } }).find(Boolean);
  if (!event || !("args" in event)) throw new Error("创建成功但未找到 CreateMarket 事件");
  return { hash, market: event.args.market as Address };
}
export async function settleMarket(market: Address, state: 1 | 2) {
  const oracle = account("ORACLE_PRIVATE_KEY");
  const wallet = createWalletClient({ account: oracle, chain: { id: chainId, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }, transport: http(rpc) });
  return wallet.writeContract({ address: market, abi: vaultAbi, functionName: "setMarketState", args: [state] });
}
