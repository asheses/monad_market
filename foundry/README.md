# bitmapLink 市场：Monad 测试网部署

所有命令在 `foundry/` 目录执行。需要支持 Monad 的 Foundry（`forge`、`cast`、`anvil`），保留本项目 `foundry.toml` 的 Monad / solc 0.8.28 / prague 配置。
网络：Monad Testnet，chain ID **10143**，gas 使用 **MON**。部署钱包需先领取测试 MON。
官方网络资料：https://docs.monad.xyz/developer-essentials/testnet

## 1. 环境配置

```bash
cd /home/xxx/monad_market/foundry
cp -n .env.example .env
chmod 600 .env
# 编辑 .env，填入 PRIVATE_KEY 和 ORACLE_ADDRESS
```

`.env.example` 是完整模板。字段填写方式：

| 字段 | 填写方式 |
| --- | --- |
| `MONAD_RPC_URL` | 默认 `https://testnet-rpc.monad.xyz`，也可替换为自己的 Monad 测试网 RPC |
| `PRIVATE_KEY` | 部署钱包私钥：`0x` 加 64 位十六进制；创建市场时必须是 Factory owner 的私钥 |
| `USDC_ADDRESS` | 第一步成功广播后输出的测试代币地址 |
| `VAULT_ADDRESS` | 第二步输出的 Vault **代理**地址，供存款和前端使用 |
| `FACTORY_ADDRESS` | 第二步输出的 Factory **代理**地址，第三步使用 |
| `ORACLE_ADDRESS` | 非零地址，拥有暂停、恢复和裁决市场权限；测试时可用部署钱包地址 |
| `TAKER_FEE_RATE` | 0..10000 整数，默认 100；费率系数为 1%，还会乘以 `p*(1-p)` |
| `MAKER_REBATE_RATE` | 0..10000 整数，默认 5000，表示把 taker 手续费的 50% 返给 maker |
| `MARKET_ADDRESS` | 第三步成功后输出的 Market 克隆地址，供后续交互 |
| `MONAD_EXPLORER_KEY` | 源码验证必填：Etherscan API key（支持 MonadScan） |

Forge 自动读取当前目录 `.env`。下面用 shell 展开变量的命令，还需要加载：

```bash
set -a
source .env
set +a
cast chain-id --rpc-url "$MONAD_RPC_URL"
# 应输出 10143
```

**每次编辑 `.env` 后重新执行以上加载命令**，避免 shell 中旧变量覆盖新值。不要分享或提交真实私钥；`.env` 已被 gitignore 排除。

## 2. 部署测试 USDC

```bash
forge script script/bitmap/DeployTestUSDC.s.sol:DeployTestUSDC \
  --rpc-url "$MONAD_RPC_URL" --broadcast --skip-simulation
```

成功后把日志中的 `USDC_ADDRESS` 写入 `.env`，重新加载环境变量。
合约位于 `src/test/TestUSDC.sol`，名称 Test USDC，符号 USDC，6 位小数，初始供应量为 0。
任何人可调用 `mint()` 给**自己**新增 **1000 USDC**，条件是调用前钱包余额严格小于 1000 USDC。
例如 999 USDC 可领取至 1999 USDC；恰好 1000 USDC 不能领取。没有管理员铸币、任意收款人或任意数量入口。
判断的是 ERC20 钱包余额，不包含已存入 Vault 的余额；转出/存入后可以再次满足条件，没有冷却期。

```bash
cast send "$USDC_ADDRESS" 'mint()' \
  --rpc-url "$MONAD_RPC_URL" --private-key "$PRIVATE_KEY"
```

## 3. 部署并关联 bitmapLink 合约

```bash
forge script script/bitmapLink/DeployBitmapLink.s.sol:DeployBitmapLink \
  --rpc-url "$MONAD_RPC_URL" --broadcast --skip-simulation
```

脚本使用 `USDC_ADDRESS`，检查代币已部署（本流程使用 6 位小数的 TestUSDC），然后依次执行：

1. 部署 Vault implementation 和 ERC1967Proxy，在代理构造时原子初始化 USDC/owner。
2. 部署 MarketFactory implementation 和 ERC1967Proxy，在代理构造时初始化 owner，并由 Factory 初始化代码部署 Market implementation。
3. 调用 Vault 代理的 `setMarketFactory`，再调用 Factory 代理的 `setVault`。
4. 输出代理及实现地址。

将 `VAULT_ADDRESS`、`FACTORY_ADDRESS` 写入 `.env`，重新加载。两者 owner 均为 `PRIVATE_KEY` 对应钱包。
`MarketVault` 是 Market 的继承基类，已包含在 Market 字节码内，不单独部署。此步骤只建立 Market 模板，实际市场在下一步创建。
对外使用代理地址，不能用 `VAULT_IMPLEMENTATION` / `FACTORY_IMPLEMENTATION` 代替。

## 4. 通过 Factory 创建市场

设置 `ORACLE_ADDRESS`、`TAKER_FEE_RATE`、`MAKER_REBATE_RATE` 并重新加载 `.env`：

```bash
forge script script/bitmapLink/CreateMarketLink.s.sol:CreateMarketLink \
  --rpc-url "$MONAD_RPC_URL" --broadcast --skip-simulation
```

脚本检查 chain ID、Factory owner 和费率，调用 `createMarket` 并输出 `MARKET_ADDRESS`。
Factory 会自动创建 Market 克隆、初始化并注册至 Vault。每次重新运行都会创建一个新市场。
当前 Factory 不接受标题、描述或截止时间；这些业务元数据由应用另外管理。
默认参数中，在价格 0.5 时，100 股的 taker 手续费为 0.25 USDC，其中 maker 得到 0.125 USDC。

可验证链上关联：

```bash
cast call "$VAULT_ADDRESS" 'USDCAddress()(address)' --rpc-url "$MONAD_RPC_URL"
cast call "$VAULT_ADDRESS" 'marketFactory()(address)' --rpc-url "$MONAD_RPC_URL"
cast call "$FACTORY_ADDRESS" 'vault()(address)' --rpc-url "$MONAD_RPC_URL"
cast call "$VAULT_ADDRESS" 'markets(address)(bool)' "$MARKET_ADDRESS" --rpc-url "$MONAD_RPC_URL"
```

## 5. 试用存款

领取后授权 Vault 代理并存入 100 USDC（最小单位为 `100000000`）：

```bash
cast send "$USDC_ADDRESS" 'approve(address,uint256)' "$VAULT_ADDRESS" 100000000 \
  --rpc-url "$MONAD_RPC_URL" --private-key "$PRIVATE_KEY"
cast send "$VAULT_ADDRESS" 'deposit(uint96)' 100000000 \
  --rpc-url "$MONAD_RPC_URL" --private-key "$PRIVATE_KEY"
```

## 6. 在 MonadScan 验证并公开源码

官方指南：https://docs.monad.xyz/guides/verify-smart-contract/foundry

部署完成后执行本节。必须使用部署时相同的源码、依赖和 `foundry.toml` 编译配置；更改源码后应重新部署，不能用新源码验证旧字节码。不要使用旧 bitmap 实现地址。

在 `.env` 中填写 Etherscan API key，并保存部署输出中的实现地址：

```bash
# 编辑 .env 中的 MONAD_EXPLORER_KEY，保留已有私钥
nano .env

# 用本次部署的实际地址替换以下值
export VAULT_IMPLEMENTATION=0x本次Vault实现地址
export FACTORY_IMPLEMENTATION=0x本次Factory实现地址
# Market 实现在 Factory 初始化时创建，通过代理读取
set -a
source .env
set +a
export MARKET_IMPLEMENTATION=$(cast call "$FACTORY_ADDRESS" 'marketImplementation()(address)' --rpc-url "$MONAD_RPC_URL")

# 保存实现地址（已有字段就更新，缺少就追加）
for name in VAULT_IMPLEMENTATION FACTORY_IMPLEMENTATION MARKET_IMPLEMENTATION; do
  if rg -q "^${name}=" .env; then
    sed -i "s|^${name}=.*|${name}=${!name}|" .env
  else
    printf '%s=%s\n' "$name" "${!name}" >> .env
  fi
done
```

验证 TestUSDC 和三个实现合约。它们均无构造参数；MarketVault 是基类，不单独部署或验证：

```bash
forge verify-contract "$USDC_ADDRESS" src/test/TestUSDC.sol:TestUSDC --chain 10143 --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/
forge verify-contract "$VAULT_IMPLEMENTATION" src/bitmapLink/Vault.sol:Vault --chain 10143 --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/
forge verify-contract "$FACTORY_IMPLEMENTATION" src/bitmapLink/MarketFactory.sol:MarketFactory --chain 10143 --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/
forge verify-contract "$MARKET_IMPLEMENTATION" src/bitmapLink/Market.sol:Market --chain 10143 --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/
```

验证两个 ERC1967Proxy，构造参数必须包含部署时的实现地址与初始化 calldata：

```bash
VAULT_INIT=$(cast calldata 'initialize(address)' "$USDC_ADDRESS")
FACTORY_INIT=$(cast calldata 'initialize()')
VAULT_ARGS=$(cast abi-encode 'constructor(address,bytes)' "$VAULT_IMPLEMENTATION" "$VAULT_INIT")
FACTORY_ARGS=$(cast abi-encode 'constructor(address,bytes)' "$FACTORY_IMPLEMENTATION" "$FACTORY_INIT")

forge verify-contract "$VAULT_ADDRESS" lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy --constructor-args "$VAULT_ARGS" --chain 10143 --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/
forge verify-contract "$FACTORY_ADDRESS" lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy --constructor-args "$FACTORY_ARGS" --chain 10143 --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/
```

看到验证成功后，在 `https://testnet.monadscan.com/address/<合约地址>#code` 查看源码。若代理页面尚未显示实现关联，使用 MonadScan 的代理识别 / Verify Proxy 功能关联已验证实现。

`MARKET_ADDRESS` 是 EIP-1167 最小代理克隆，不要把它作为完整 Market 字节码提交 `forge verify-contract`。先验证 `MARKET_IMPLEMENTATION`，再在克隆地址的浏览器页面检查实现关联；如未自动识别，使用浏览器的代理识别功能。

## 模拟、恢复及测试

去掉 `--broadcast` 可先模拟；模拟输出地址不能作为已部署地址使用。
部署及交互脚本仅允许 chain ID 10143。`--skip-simulation` 跳过额外链上模拟；删除此参数可恢复完整模拟。源码未变时自动跳过编译。
部署过程包含多笔交易，不是整体原子操作；中途失败时先查看 `broadcast/<脚本名>/10143/run-latest.json` 和链上回执。
若需继续同一次广播，可在原命令追加 `--resume --private-key "$PRIVATE_KEY"`（恢复不重新运行脚本，因此需显式指定签名私钥；保持原钱包 nonce 未被其他交易占用）；不要把普通重跑当作恢复，普通重跑会新建合约/市场。
只有广播完成且回执成功后才把输出地址用于下一步。广播记录保存在上述目录；脚本不会自动覆盖 `.env`。

```bash
forge build
forge test -vv
# 现有独立交易场景：需相邻 monad_market_next 项目已安装 viem
node script/bitmap/run_receipt_scenarios.cjs # 旧 bitmap 场景，与本部署流程无关
```

本流程对应 `test/bitmapLink/` 中的合约测试；旧 `test/bitmap/Deployment.t.sol` 测试的是 bitmap 部署脚本。
