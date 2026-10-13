# Monad Market

[中文 README](./README.md)

A fully on-chain binary prediction market demo on Monad Testnet. Users trade YES/NO outcome shares through collateralized USDC, an on-chain order book, oracle resolution, and contract-based redemption. The Next.js frontend provides wallet interaction, while Envio indexes market events into queryable order-book and account views.

## Architecture

```text
monad_market/
├── foundry/              # Solidity contracts, deployment scripts, tests
│   ├── src/bitmapLink/   # Current demo contracts
│   ├── script/           # Monad deployment and scenario scripts
│   └── test/             # Unit and scenario tests
├── monad_market_next/    # Next.js + wagmi + viem frontend
└── envio/                # Envio HyperIndex event indexer
```

## Contract mechanics

### Vault: the collateral ledger

`Vault` custody holds USDC and tracks each user's withdrawable `balances`. Users deposit once; orders, splits, merges, and settlement then update internal accounting instead of moving ERC20 tokens on every trade. Only markets registered by `MarketFactory` can lock or release user balances. Vault and Factory use UUPS proxies; each market is deployed as an EIP-1167 clone.

### MarketVault: collateral and outcome shares

`splitUSDC(x)` locks `x` USDC and creates `x` YES plus `x` NO shares. `mergeShares(x)` burns equal free amounts of YES and NO and releases `x` USDC. Sell orders lock shares, while buy orders lock USDC, preventing double spending.

The oracle controls the market state: `0` open, `3` paused, `1` YES wins, and `2` NO wins. After resolution, `redeem()` releases the winning shares and eligible locked collateral back to the Vault.

### Market: bitmap order book

YES and NO have separate books. Prices are integers from 1 to 99 cents. Each price is a FIFO bucket; a bitmap tracks non-empty prices so the contract can find the best bid and ask efficiently. Orders emit insertion, trade, deletion, best-price, and settlement evidence on-chain.

### Five order types

The `OrderType` enum implements five execution policies:

1. **Limit**: match immediately executable quantity, then place the remainder on the book.
2. **PostOnly**: if the order would take liquidity immediately, emit `PostOnlyOrderWouldTake` and do not trade or post it.
3. **Market**: consume the best available prices until the budget or requested shares are exhausted; supports minimum-output protection.
4. **FillOrKill**: revert the entire transaction unless the requested amount can be fully filled.
5. **ImmediateOrCancel**: execute the immediately fillable quantity and discard any remainder.

Limit orders accept an `endTimestamp`. `0` means no expiry; otherwise the timestamp must be in the future. Expired orders are removed lazily during matching or cleanup: locked USDC is returned for buy orders and locked shares are returned for sell orders. The contract also supports `orderBatchInsert` for submitting multiple orders in one call.

Each order stores the trader's current version. Calling `updateVersion()` increments that version and invalidates all of the trader's older orders. Their locked YES/NO shares and buy collateral are released as stale orders are cleaned up, providing an efficient batch-cancel and emergency-exit mechanism. Price-bucket indices are reused after fills, expiry, version invalidation, or explicit cancellation.

Fees use 10,000 as the rate scale and vary with `p × (1-p)`. The taker pays the trading fee, a configured portion can be rebated to the maker, and the remainder is accumulated as market fees. Amounts and shares use six-decimal integer accounting.

## Frontend and language switch

The frontend in [`monad_market_next`](./monad_market_next) uses Next.js, RainbowKit, wagmi, and viem. It supports wallet connection, Test USDC minting, Vault deposit/withdraw, YES/NO splitting, limit and market trading, order cancellation, order-book display, and post-resolution redemption. Transactions are simulated before signing and are considered successful only after a confirmed receipt.

This repository provides two switchable README languages: use **[中文 README](./README.md)** or **[English README](./README_EN.md)** at the top of either document. The application UI currently presents the demo market in Chinese; README language switching is available independently for reviewers and developers.

## Envio indexer

`envio/` indexes Factory, Vault, and Market events into active orders, order history, trades, balances, and positions. The frontend obtains snapshots through `/api/indexer` and receives SSE refresh notifications after database commits, avoiding high-frequency RPC polling.

## Quick start

```bash
cd monad_market_next
npm install
cp .env.example .env.local
# Set NEXT_PUBLIC_TEST_USDC_ADDRESS and NEXT_PUBLIC_VAULT_ADDRESS
npm run dev
```

Compile and test contracts:

```bash
cd foundry
forge build
forge test -vv
```

The complete Monad Testnet deployment and walkthrough is in [`foundry/bitmapLink-testnet-demo.md`](./foundry/bitmapLink-testnet-demo.md). The flow deploys TestUSDC, Vault, and Factory, creates a market, deposits collateral, submits example orders, resolves the market, and redeems the winning outcome. Monad Testnet uses chain ID `10143` and MON for gas.

Start the indexer with the instructions in [`envio/README.md`](./envio/README.md).

## Reviewer walkthrough

Connect a wallet, mint Test USDC, deposit into the Vault, split collateral into YES/NO, place different order types with and without expiry, observe matching and order-book changes, call `updateVersion()` to invalidate outstanding orders, then let the oracle resolve the market and call `redeem()`.

This sequence demonstrates that collateral, order state, matching evidence, version invalidation, oracle resolution, and redemption are enforced by contracts rather than by frontend database writes.

## Current boundaries

- Market title, description, and settlement metadata are currently maintained by the application layer.
- Charts, comments, and favorites are demo UI; core balances, orders, trades, and redemption are on-chain or indexed from chain events.
- TestUSDC is for testnet demonstration only.
- The accounting model assumes a six-decimal, non-rebasing, fee-free-transfer USDC token.
