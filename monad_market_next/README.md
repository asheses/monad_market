# Monad Market

Next.js 预测市场前端，使用 RainbowKit / wagmi 连接钱包，通过 viem 向 Monad Testnet 提交交易。

## 配置与运行

```bash
npm install
cp .env.example .env.local
npm run dev
```

在 `.env.local` 填写 `NEXT_PUBLIC_TEST_USDC_ADDRESS`、`NEXT_PUBLIC_VAULT_ADDRESS`（Vault 的代理地址）。`NEXT_PUBLIC_MONAD_RPC_URL` 可选，默认使用 viem 的 Monad Testnet RPC。修改环境变量后重新启动 / 构建。

在 `lib/contracts/config.ts` 的 `marketAddresses` 中填写市场地址。当前唯一配置的 `bitmapLink` 市场是 `monad:2026-09-15:1`，地址 `0xDc60bB47dF26fB4D2e08eb7D1c9708E251305F8d`；Vault 地址为 `0xABd50Bf4066D6383fbf02B905E3C0180b0aF41D1`。每个日期和目标价对应独立合约，未配置的组合不能下单。当前页面日期为 2026 年 9 月；扩展日期时同步更新 `marketKey`。

## 交易功能

| 页面操作 | 合约调用 |
| --- | --- |
| Mint 测试 USDC | TestUSDC.mint() |
| Vault 充值 | TestUSDC.approve(vault, amount)，确认后 Vault.deposit(amount) |
| Vault 提现 | Vault.withdraw(amount) |
| 限价买入 / 卖出 | Market.orderInsert(price, shares, expiry, isBuy, isYes) |
| 市价买入 | Market.buyUSDCAmount(budget, isYes, minShareOut) |
| 市价卖出 | Market.sellShares(shares, isYes, minUSDCAmountOut) |
| 撤单 | Market.deleteOrder(price, zeroBasedIndex, isYes) |
| 拆分 / 合并 | Market.splitUSDC(amount) / mergeShares(amount) |
| 结算领取 | Market.redeem() |

USDC 和份额按 6 位小数编码，价格为 1–99 美分整数。市价买入金额为 0.1 USDC 的正整数倍；限价份额和拆分金额须大于 1；市价卖出至少 1 份。市价单必须显式填写最低输出，0 表示不设置最低输出保护。有效期支持永不过期、提交起 1 小时或 24 小时。

保留“限价单”名称。当前合约价格触发撮合后不保证每笔成交受输入限价约束，未成交余量不挂单；确认弹窗有对应说明。修改合约语义后同步更新说明。

交易先模拟，再请求钱包签名，等待成功回执后才提示成功。网络错误导致回执未知时保留交易链接，避免把已广播交易视为未提交。充值每次授权精确金额，无须读取 allowance；授权成功但充值失败不会回滚授权。结算和合并所得 USDC 回到 Vault，可继续提现到钱包。Mint 每次领取 1,000 USDC，钱包余额须低于 1,000；查询接入前由合约模拟验证此条件。

## 后续查询接入

临时链上读取位于 `components/chain-demo/`：连接钱包后读取 Vault 可用余额与市场 YES/NO 持仓；订单簿从 `bitmapLink.getActiveOrderShareAmount` 读取最佳买卖价附近各 5 档的活跃份额，并通过 multicall 汇总。当前市场是否可交易由合约模拟验证，不使用演示日期判断。顶部钱包 USDC 余额尚未接入查询，缺失时显示 `—`。

撤单暂手动填写原订单价格、YES/NO 和从 0 开始的订单索引。后续订单列表可复用对应调用；注意索引在价格桶重用时可能变化。

`TransactionsProvider` 每次收到成功回执会派发 `market:transaction-confirmed` 浏览器事件，`detail` 包含 `{ hash, account, call }`，后续查询层可监听并刷新。此事件不是持久化交易历史。

图表、市场卡片、动态与市场规则仍为演示数据；订单簿为链上活跃挂单总量，点击价位可填写限价。评论和收藏保留本地交互。

## 验证

```bash
npm run lint
npx tsc --noEmit
node --experimental-strip-types --test tests/transactions.test.mjs
npm run build
```

测试使用 Node.js 22.6+ 的 TypeScript 类型剥离，覆盖 6 位小数、uint96/uint256 边界、订单最低数量、市价输出保护及 calldata 编码。部署地址未填写前无法验证真实测试网交易。
# Envio data and SSE

The order book, Vault balance and market positions read Envio through `/api/indexer`.
`/api/indexer?market=0x...&trader=0x...&stream=1` sends SSE `refresh` events after
database commits affecting that market/wallet. Each Node process shares one PostgreSQL
LISTEN connection. There is no periodic GraphQL polling; SSE heartbeats run every 15 seconds.
The browser fetches a snapshot after a notification and on every connection/reconnection.
Failed snapshot requests retry after three seconds. Order expiration is handled locally by
an expiry timer, without database writes or periodic queries.

Install `envio/sql/realtime.sql` after initializing Envio and again after resetting its tables.
See `../envio/README.md` for the installation command. Start Envio indexing with `npm run dev`
in `../envio`; running PostgreSQL/Hasura alone does not index chain events.

Server configuration (local Envio defaults are used if omitted):

```dotenv
ENVIO_GRAPHQL_URL=http://127.0.0.1:8080/v1/graphql
ENVIO_DATABASE_URL=postgresql://postgres:testing@127.0.0.1:5433/envio-dev
```

For a Docker frontend, replace `127.0.0.1` with `host.docker.internal` and enable host
gateway access. Use a persistent Node server and configure reverse proxies to disable SSE
buffering and allow long connections. Database credentials belong only on the server.

Integration verification with Envio services and Next running:

```bash
TEST_FRONTEND_URL=http://localhost:3000 node tests/indexer-realtime.mjs
```

The test uses temporary random market/wallet records, checks batching, rollback, scoped
delivery, deletion and reconnect, then cleans them up. It terminates the application's
database listener to verify recovery, briefly reconnecting any existing SSE clients.

