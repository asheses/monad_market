# bitmapLink 测试网演示

以下命令都在 `foundry/` 目录执行。现有 `.env` 中的私钥不会被覆盖，也不会写入本文档。

下面的 `--skip-simulation` 会跳过 Foundry 的额外链上模拟以减少 RPC 请求；交易仍会广播并等待确认。源码未改动时，`forge script` 会自动跳过编译，不需要手动检查或强制重新编译。不要加 `--slow`，它会逐笔等待前一笔确认。若需要在广播前完整模拟，删掉 `--skip-simulation` 即可。

## 0. 检查并补充 `.env`

```bash
cd /home/xxx/monad_market/foundry

# 仅在变量不存在时补充，不会修改已有私钥或地址。
grep -q '^MONAD_RPC_URL=' .env || printf '\nMONAD_RPC_URL=https://testnet-rpc.monad.xyz\n' >> .env
grep -q '^ORACLE_PRIVATE_KEY=' .env || printf 'ORACLE_PRIVATE_KEY=\n' >> .env
grep -q '^TAKER_FEE_RATE=' .env || printf 'TAKER_FEE_RATE=100\n' >> .env
grep -q '^MAKER_REBATE_RATE=' .env || printf 'MAKER_REBATE_RATE=5000\n' >> .env

set -a
source .env
set +a

# ORACLE_PRIVATE_KEY 已配置时使用它，否则使用 PRIVATE_KEY。
ORACLE_KEY="${ORACLE_PRIVATE_KEY:-$PRIVATE_KEY}"
export ORACLE_ADDRESS="$(cast wallet address --private-key "$ORACLE_KEY")"
sed -i "s|^ORACLE_ADDRESS=.*|ORACLE_ADDRESS=$ORACLE_ADDRESS|" .env
```

确认当前变量已经加载：

```bash
awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/{print $1}' .env
```

## 1. 部署测试 USDC

```bash
set -a; source .env; set +a
forge script script/bitmap/DeployTestUSDC.s.sol:DeployTestUSDC \
  --broadcast \
  --skip-simulation \
  --rpc-url "$MONAD_RPC_URL" \
  --private-key "$PRIVATE_KEY"
```

从输出中复制 `USDC_ADDRESS=...`，然后写回 `.env`：

```bash
export USDC_ADDRESS=0x这里填写DeployTestUSDC输出的地址
sed -i "s|^USDC_ADDRESS=.*|USDC_ADDRESS=$USDC_ADDRESS|" .env
```

## 2. 部署 bitmapLink Vault 和 MarketFactory

```bash
set -a; source .env; set +a
forge script script/bitmapLink/DeployBitmapLink.s.sol:DeployBitmapLink \
  --broadcast \
  --skip-simulation \
  --rpc-url "$MONAD_RPC_URL" \
  --private-key "$PRIVATE_KEY"
```

从输出中复制代理地址并写回 `.env`：

```bash
export VAULT_ADDRESS=0x这里填写VAULT_ADDRESS输出的地址
export FACTORY_ADDRESS=0x这里填写FACTORY_ADDRESS输出的地址
sed -i "s|^VAULT_ADDRESS=.*|VAULT_ADDRESS=$VAULT_ADDRESS|" .env
sed -i "s|^FACTORY_ADDRESS=.*|FACTORY_ADDRESS=$FACTORY_ADDRESS|" .env
```

## 3. 创建新 market

```bash
set -a; source .env; set +a
forge script script/bitmapLink/CreateMarketLink.s.sol:CreateMarketLink \
  --broadcast \
  --skip-simulation \
  --rpc-url "$MONAD_RPC_URL" \
  --private-key "$PRIVATE_KEY"
```

从输出中复制 `MARKET_ADDRESS=...`，然后写回 `.env`：

```bash
export MARKET_ADDRESS=0x这里填写CreateMarketLink输出的地址
sed -i "s|^MARKET_ADDRESS=.*|MARKET_ADDRESS=$MARKET_ADDRESS|" .env
```

## 4. 批量发限价单

脚本会自动为部署钱包执行 `mint`（余额不足时）、`approve`、`deposit`、`splitUSDC`，然后批量提交以下 YES 订单：

```text
YES sell: 46 / 10 share
YES sell: 47 / 20 share
YES sell: 48 / 40 share
YES buy : 44 / 10 share
YES buy : 43 / 20 share
YES buy : 42 / 40 share
```

执行：

```bash
set -a; source .env; set +a
forge script script/bitmapLink/PlaceOrdersLink.s.sol:PlaceOrdersLink \
  --broadcast \
  --skip-simulation \
  --rpc-url "$MONAD_RPC_URL" \
  --private-key "$PRIVATE_KEY"
```

## 5. 更改 market 状态为 YES 胜

`marketState = 1` 表示 YES 胜。脚本优先使用 `ORACLE_PRIVATE_KEY`，为空时回退到 `PRIVATE_KEY`。

```bash
set -a; source .env; set +a
forge script script/bitmapLink/SetYesWinLink.s.sol:SetYesWinLink \
  --broadcast \
  --skip-simulation \
  --rpc-url "$MONAD_RPC_URL" \
  --private-key "${ORACLE_PRIVATE_KEY:-$PRIVATE_KEY}"
```

## 备注

- `ORACLE_ADDRESS` 必须等于 `ORACLE_PRIVATE_KEY` 对应地址；如果没有独立 oracle 私钥，则等于 `PRIVATE_KEY` 对应地址。
- 部署钱包需要 Monad 测试网 MON 作为 gas。
- `PlaceOrdersLink.s.sol` 假定 `USDC_ADDRESS` 是项目内的 `TestUSDC`，因为它会调用测试币的 `mint()`。
