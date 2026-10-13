# Monad Market

[English README](./README_EN.md)

基于 Monad Testnet 的链上二元预测市场 Demo。用户可以围绕一个结果为 **YES / NO** 的事件进行拆分、挂单、撮合和结算；所有资金锁定、订单状态、成交和最终兑付都由 Solidity 合约完成，Next.js 负责交互展示，Envio 负责把链上事件整理成可查询的订单簿和账户视图。

这个项目的重点不是模拟一个交易页面，而是展示一个完整的链上市场闭环：**抵押 USDC → 生成 YES/NO 份额 → 订单簿交易 → 预言机裁决 → 获胜份额兑付**。

## 项目结构

```text
monad_market/
├── foundry/              # Solidity 合约、部署脚本和测试
│   ├── src/bitmapLink/   # 当前演示使用的合约实现
│   ├── script/           # Monad 测试网部署和演示脚本
│   └── test/             # 单元测试与交易场景测试
├── monad_market_next/    # Next.js + wagmi + viem 前端
└── envio/                # Envio HyperIndex 链上事件索引服务
```

## 合约设计

### 1. Vault：统一资金账户

`Vault` 持有 USDC，并维护每个用户可用的 `balances`。用户先把 USDC 存入 Vault，之后的下单、拆分、合并和结算只改变 Vault 内部记账，不需要每次交易都移动 ERC20。

- `deposit / withdraw`：用户充值和提现。
- `lockDeposit`：已注册市场锁定用户的可用 USDC，用于买单抵押或生成份额。
- `releaseDeposit`：市场释放抵押、合并份额或结算时把 USDC 记回用户。
- 只有 Factory 注册的 Market 才能修改用户余额，避免任意合约伪造结算。

Vault 和 Factory 使用 UUPS 代理，实际交互地址应使用代理地址；单个市场使用 EIP-1167 clone 创建，降低部署成本。

### 2. MarketVault：抵押品与结果份额

每个市场为用户维护五类数据：可用 YES、锁定 YES、可用 NO、锁定 NO，以及买单锁定的 USDC。

`splitUSDC(x)` 是市场的核心机制：锁定 `x` USDC，同时铸造 `x` 个 YES 和 `x` 个 NO。YES 与 NO 各代表同一单位抵押品的一种结果，因此两者合计始终有明确的抵押来源。

`mergeShares(x)` 消耗用户手中各 `x` 个未锁定 YES 和 NO，释放 `x` USDC。交易中的卖出份额会先进入 locked 状态，避免同一份份额被重复使用。

预言机在市场开放时可以暂停或恢复市场，并在最终结果确定后设置：

- `1`：YES 胜，YES 份额按 1:1 兑付；
- `2`：NO 胜，NO 份额按 1:1 兑付；
- `3`：暂停交易。

结算后用户调用 `redeem()`，获胜份额、未成交买单抵押和对应余额会统一释放回 Vault。

### 3. Market：基于 Bitmap 的订单簿撮合

YES 和 NO 各自拥有独立订单簿。价格是 1～99 的整数，表示 1～99 美分；价格 100 美分的互补结果由抵押关系表达，而不是作为普通报价。

每个价格是一个 bucket，bucket 内按先进先出保存订单；Bitmap 记录哪些价格存在有效订单，合约可以快速跳过空价格并定位最佳买价和卖价。订单还带有版本号和过期时间：用户调用 `updateVersion()` 可以一次性使自己的旧订单失效并释放锁定资产。

支持的链上交易包括：

| 能力 | 合约入口 | 说明 |
| --- | --- | --- |
| 限价单 | `orderInsert` | 指定价格和份额，未成交部分进入订单簿 |
| 市价买入 | `buyUSDCAmount` | 指定预算和最低份额输出 |
| 市价卖出 | `sellShares` | 指定份额和最低 USDC 输出 |
| 撤单 | `deleteOrder` | 按价格、订单索引和 YES/NO 撤销 |
| 拆分/合并 | `splitUSDC` / `mergeShares` | 在 USDC 与结果份额之间转换 |
| 结算 | `redeem` | 预言机裁决后领取获胜结果 |

### 订单类型与生命周期

合约 `OrderType` 枚举实现五种订单类型：

1. **Limit（限价单）**：指定价格和份额；能够立即成交的部分先撮合，剩余数量挂入订单簿。
2. **PostOnly（只挂单）**：如果订单会立即吃掉对手盘，合约只发出 `PostOnlyOrderWouldTake` 事件而不成交，适合保证 maker 身份。
3. **Market（市价单）**：沿最佳价格逐档撮合，直到预算或份额用完；支持最低输出保护。
4. **FillOrKill（全部成交或取消）**：必须一次性完全成交，否则整笔交易回滚，不留下部分成交。
5. **ImmediateOrCancel（立即成交或取消）**：立即撮合可成交部分，未成交余量不进入订单簿。

限价单可以设置 `endTimestamp`：`0` 表示永不过期，也可以设置未来的 Unix 时间戳。撮合、订单簿清理和用户主动操作时会检查过期订单；买单会释放锁定 USDC，卖单会释放锁定份额。订单插入支持单笔和 `orderBatchInsert` 批量提交。

每个订单记录创建者的 `version`。用户调用 `updateVersion()` 后，自己的旧版本订单立即失效，同时释放所有锁定的 YES/NO 份额和买单抵押；这是一种无需逐笔遍历撤单的紧急退出和批量撤单机制。订单索引采用价格桶内索引，订单成交、过期、版本失效或撤销后会被标记为空并回收。

撮合时，买方支付成交本金和 taker 手续费，卖方收到本金；maker 可获得部分手续费返还，剩余部分计入市场手续费。费率使用 10,000 为基数，并乘以 `p × (1-p)`，使价格接近中间价时流动性成本最高、接近两端时成本降低。所有 USDC、份额和费用均采用 6 位小数的整数记账。

### 4. MarketFactory：创建和注册市场

Factory 保存 Market implementation。创建市场时：

1. clone 出一个新的 Market；
2. 初始化 Vault、oracle、taker fee 和 maker rebate；
3. 向 Vault 注册新市场；
4. 返回独立的市场地址。

这样可以在同一套资金和权限体系下创建多个事件市场，同时保持每个市场的订单簿和结算状态隔离。

## 前端功能

前端位于 [`monad_market_next`](./monad_market_next)，使用 Next.js、RainbowKit、wagmi 和 viem 连接 Monad Testnet。

- 连接钱包并切换 Monad Testnet；
- 领取 Demo Test USDC（余额低于 1,000 USDC 时每次领取 1,000）；
- 授权并充值 Vault，查看可用余额；
- 拆分 USDC，获得 YES/NO 份额；
- 提交限价买入、限价卖出、市价买入和市价卖出；
- 查看链上订单簿、YES/NO 持仓，撤销订单；
- 预言机裁决后领取结算资金。

前端交易会先进行模拟，再请求钱包签名，并在链上回执确认后提示成功；市价交易支持最低输出保护，避免成交结果低于用户预期。当前市场标题、图表和部分展示数据仍是 Demo UI，订单和账户核心数据来自链上/索引器。

## Envio 索引与实时更新

`envio/` 监听 Factory、Vault 和 Market 事件，维护订单历史、活跃订单、Vault 余额、持仓和成交记录。前端通过 `/api/indexer` 获取快照，并使用 SSE 接收数据库提交后的刷新通知，因此不需要高频轮询 RPC。

索引器保留订单插入、成交、撤单和版本失效等链上证据；活跃订单按 `market + YES/NO + price + orderIndex` 定位，并过滤已过期订单。余额和份额使用链上 6 位小数原始整数，避免浮点误差。

## 快速开始

### 运行前端

```bash
cd monad_market_next
npm install
cp .env.example .env.local
# 在 .env.local 填入 NEXT_PUBLIC_TEST_USDC_ADDRESS 和 NEXT_PUBLIC_VAULT_ADDRESS
npm run dev
```

### 编译和测试合约

```bash
cd foundry
forge build
forge test -vv
```

### Monad 测试网部署

完整部署流程见 [`foundry/bitmapLink-testnet-demo.md`](./foundry/bitmapLink-testnet-demo.md)，包括：

1. 部署 TestUSDC；
2. 部署 Vault 和 MarketFactory 代理；
3. 创建并注册 Market；
4. 充值、拆分并提交示例订单；
5. 使用 oracle 设置 YES/NO 结果并执行结算。

Monad Testnet chain ID 为 `10143`，gas 使用 MON。部署钱包、oracle 和前端地址配置完成后，才能在真实测试网上完成端到端演示。

### 启动索引器

```bash
cd envio
npm ci
npm run codegen
npm run typecheck
npm run dev
```

本地索引需要 Docker、PostgreSQL/Hasura 和 Envio API token；详细配置见 [`envio/README.md`](./envio/README.md)。

## 评委体验建议

推荐按以下顺序体验：连接钱包 → 领取 Test USDC → 充值 Vault → 拆分得到 YES/NO → 在不同价格挂出买卖单 → 观察订单簿和成交 → 由 oracle 设置结果 → 调用 `redeem()` 领取获胜份额。

这个流程可以直接验证项目的核心价值：资金始终有抵押来源，订单撮合有可追踪事件，市场结果由指定 oracle 裁决，最终兑付由合约按份额完成，而不是由前端数据库修改余额。

## 验证命令

```bash
cd monad_market_next
npm run lint
npx tsc --noEmit
npm run build
node --experimental-strip-types --test tests/transactions.test.mjs
```

## 已知边界

- 当前 Factory 的市场元数据（标题、描述、截止时间）由应用层维护，不写入 Market 初始化参数。
- 订单簿的核心状态在链上，图表、评论、收藏等部分 UI 仍属于演示功能。
- `TestUSDC` 仅用于测试网体验，不代表生产稳定币发行方式。
- 合约默认使用 6 位小数、无转账税且不 rebasing 的 USDC；更换代币模型需要重新审计记账逻辑。

