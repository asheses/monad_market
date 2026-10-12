# Bitmap Prediction Market Handoff

## Scope and working agreement

- Applies to `Market.sol`, `MarketVault.sol`, `Vault.sol`, and `MarketFactory.sol` here.
- This is the bitmap implementation. Do not import assumptions from other prediction-market implementations in this repository.
- The user has established the testing workflow below as the default for future work on these contracts. Preserve and extend these tests when changing behavior; follow the current task's authorization for production edits.
- Validate `TradeInfo` as evidence of fill order, price, quantity, fees, and its current final `orderIndex` field, together with account and order-book assertions. If the event ABI changes, update the topic hash and ABI decoder in `BitmapMarketScenario.t.sol`; event-only assertions do not establish accounting correctness.
- Read current source before reporting a problem. Previous review findings listed in conversation history may already be fixed; do not treat this document as proof that a bug exists.

## Contract map and trust boundaries

| Contract | Responsibility |
| --- | --- |
| `Vault` | Holds USDC, tracks withdrawable `balances`, registers markets, credits market settlements, and collects fees. |
| `MarketVault` | Tracks per-market collateral and shares; implements split, merge, redeem, oracle control, and fee calculations. |
| `Market` | Owns price buckets, bitmaps, matching, cancellation, version invalidation, and expiry cleanup. |
| `MarketFactory` | Creates and initializes Market clones and registers them in Vault. |

- Vault and Factory use UUPS proxies; Market uses clones. Supply proxy addresses for Vault/Factory wiring.
- Deployment order: initialize Vault proxy, initialize Factory proxy, set Factory in Vault, set Vault in Factory, then create markets.
- Factory initialization deploys the Market implementation. Existing clones remain linked to their implementation; editing source or upgrading Factory does not update them automatically.
- Factory/Vault owners control upgrades and configuration. The oracle controls resolution and oracle replacement.
- Registered markets are trusted to maintain accounting: Vault does not enforce a separate collateral cap for each market. Its release/credit methods can increase user balances when called by a registered market.
- Accounting assumes a six-decimal USDC token that transfers the requested amount without transfer fees or rebasing.

## Units and accounting

- USDC amounts and shares use six decimals. Prices are integers 1 through 99, representing price / 100.
- `Vault.balances[trader]` is withdrawable USDC. Locking subtracts from it; releasing adds to it.
- `TraderInfo.deposit` aggregates unfilled buy collateral across both YES and NO. It is not the collateral backing all outstanding shares.
- `yesAmount` / `noAmount` are free shares; `yesDepositAmount` / `noDepositAmount` are shares locked for sell orders.
- `splitUSDC(x)` locks x USDC and creates x YES plus x NO. `mergeShares(x)` burns x of each free share and releases x USDC.
- For a fill of q units at price p, principal is `floor(q * p / 100)`.
- Fee scale is 10,000. `getFeePerShare(p)` computes `floor(takerFeeRate * p * (100-p) * 1e6 / 1e8)`; the fill fee is `floor(feePerShare * q / 1e6)`.
- Despite its name, `makerRebateRate` is currently a fraction of the taker fee: maker rebate = `floor(takerFee * makerRebateRate / 10_000)`. Market fee is the remainder.
- Buying an ask debits taker principal plus taker fee; maker receives principal plus rebate. Selling into a bid consumes maker collateral; taker receives principal minus taker fee, and maker receives rebate.
- Preserve integer-rounding accounting. Partial bid fills and subsequent cancellation may leave refundable dust in aggregate `deposit`; `updateVersion` or final redemption releases it.

## Books, pointers, and lifecycle

- YES and NO have separate books. Within each book, bids and asks share a bitmap and price-bucket array.
- Normal insertion prevents active buy and sell orders at the same price. Sharing a bitmap is not itself a defect.
- No best bid is represented by 0; no best ask by 100. Actual prices are 1..99.
- Each bucket holds `orders` and `firstOrderIndex`. This head pointer already exists; improve its advancement rather than proposing another field.
- `_changeBestPrice` has a misleading boolean name: true searches upward and returns 100 if absent; false searches downward and returns 0 if absent. Cleanup passes `!isBuy`; buy matching searches upward through asks, sell matching downward through bids.
- Matching and bounded cleanup can leave stale entries for later inspection. Validate quantity, version, and expiry before filling; never infer an order side from a potentially stale best price.
- `Order.isBuy` is authoritative for cancellation. `deleteOrder` uses a zero-based array index. Whole-bucket deletion can reset indices when that price is reused.
- Expiry is `endTimestamp != 0 && endTimestamp < block.timestamp`; zero means no expiry.
- `updateVersion` invalidates all the caller's old orders and immediately releases all their buy collateral and locked shares. Later removal of old-version orders must not refund again.
- Every fill, cancellation, and expiry refund must update the order owner's matching collateral/share field. Taker share debits use the actual filled quantity.

## Confirmed API semantics

- Crossing `orderInsert` / `orderBatchInsert` orders intentionally become market orders after the submitted price triggers matching. The price is not a per-fill limit; unfilled taker remainder is not posted as a passive order.
- Limit-price protection is a future feature, not a current guarantee. Do not repeatedly report the confirmed behavior as a limit-order bug.
- Batch validation compares YES and NO independently. Absent buy/sell extremes of 0/100 correctly permit buy-only and sell-only batches.
- Batch passive collateral is locked at the end. With the current guarded, atomic execution, this ordering alone is not a defect; verify concrete accounting paths before reporting it.
- `buyUSDCAmount` is best effort and checks `minShareOut`. Both matching loops stop when remaining USDC is <= 10 smallest units (0.000010 USDC); the remainder stays in Vault balance.
- Partial buys subtract actual principal plus taker fee from the budget, not principal plus maker rebate. Keep inner and outer stopping conditions consistent.
- `sellShares` checks available shares and `minUSDCAmountOut`; only filled shares are consumed.
- Current input minima: passive/trigger orders require more than 1 share; split requires more than 1 USDC; sellShares allows at least 1 share; buyUSDCAmount accepts positive multiples of 0.1 USDC.

## State and settlement

- State 0: trading open. State 3: reusable processing/pause state; 3 -> 0 is intentional.
- States 1 (YES wins) and 2 (NO wins) are terminal. Neither may transition back to another state.
- `redeem` releases free plus locked winning shares and aggregate buy deposit, then deletes the trader record. Losing shares are discarded.
- `mergeShares` is not restricted to open state; burning equal free YES/NO shares preserves the paired payout.

## Deferred work agreed with the user

- Limit-price protection for triggered orders.
- Cleanup gas/work-budget improvements. Encountering a valid head currently breaks only the inner loop and can recheck it; deleting a whole bucket clears a historical dynamic array and is not constant work.
- A future cleanup design should budget both bucket transitions and order scans, stop at the first valid head, and avoid unbounded historical-array deletion. Budget exhaustion must not be interpreted as an empty book.

## Build and verification

- Current config: Monad / `monad:MonadTen`, solc 0.8.28, EVM prague, optimizer 200 runs, `via_ir = true`.
- Do not switch to Ethereum/Hardhat defaults to assess Monad deployment. Compiler stack-depth errors and chain bytecode-size limits are separate concerns.
- All paths in the testing sections below are relative to `foundry/`, unless a Markdown link states otherwise.
- For changes to these contracts or their behavioral tests, run the full Foundry suite and the independent-transaction runner before reporting verification complete. Focused tests may be used during iteration; they do not replace the full checks.
- Documentation-only changes require checking the documented commands, paths, and facts; they do not require rerunning the transaction suite.

```bash
# Run from foundry/
forge test -vv
node script/bitmap/run_receipt_scenarios.cjs
```

- The transaction runner runs `forge build`, starts its own local Monad Anvil on a temporary loopback port, executes the scenarios, writes reports, and stops its node. It requires Node.js, Monad-capable `forge`/`anvil`, and the `viem` dependency installed in the adjacent `monad_market_next` project.
- If the required environment is unavailable, report the exact blocker and which checks ran. Do not silently substitute an Ethereum node, remove assertions, or present historical reports as results of the current source.
- Baseline recorded on 2026-09-16: **14 Foundry tests passed**, and **6 independent-transaction scenarios passed with 324 mined transactions, including 34 expected reverts**. These counts describe the current suite, not a cap on future coverage or proof of correctness for later changes. Earlier temporary regressions/fuzz runs are not additional persistent repository tests.

## Persistent test entry points

| Entry point | Required coverage |
| --- | --- |
| `test/bitmap/BitmapMarket.t.sol` | Original 6 regressions: Factory registration, buy-only/sell-only batches, internally crossed batch rejection, expiry-cleanup gas, full/partial budget buys. |
| `test/bitmap/BitmapMarketScenario.t.sol` | 2 complete A/O/B-I sessions, one per YES/NO outcome; per-call full ledger, orders, FIFO fills, lifecycle, and final settlement checks. |
| `test/bitmap/BitmapMarketExecution.t.sol` | 6 regressions covering budget buys, partial fills/unspent budget, minimum-share rollback, cross-price sales, and minimum-proceeds rollback, on both YES and NO. |
| `script/bitmap/run_receipt_scenarios.cjs` | Real signed local transactions for `mainline-YES`, `mainline-NO`, `budget-YES`, `budget-NO`, `cross-sell-YES`, and `cross-sell-NO`; receipts, native fees, rollback proofs, and final payout checks. |

## Mainline scenario to preserve

Use a six-decimal, ordinary ERC20 mock, actual Vault/Factory UUPS proxies, and a Factory-created Market clone. Market parameters are `takerFeeRate=100` and `makerRebateRate=5000`. O is a separate oracle; A is the deployment/configuration owner and platform-fee recipient.

| Actor | Initial USDC deposit | Initial split | Behavior |
| --- | ---: | ---: | --- |
| A | 0 | 0 | Deploy and wire contracts, create market, collect and withdraw platform fees. |
| O | 0 | 0 | Pause, resume, and resolve the market. |
| B | 2,000 | 800 | First maker: 8 passive orders with some expiries; cancel remaining 200-share YES bid at 40; merge 300 pairs. |
| C | 2,000 | 600 | Second maker: 9 passive orders; invalidate old orders with `updateVersion`; post 60 YES ask at 70 and 80 NO bid at 25; merge 200 pairs. |
| D | 1,000 | 0 | Buy 250 YES at 55 FIFO; later buy 100 NO across 45/55 while skipping an expired ask. |
| E | 1,500 | 0 | Buy 400 YES across 55/58/60. |
| F | 1,000 | 400 | Sell 220 YES at 45; merge 100 pairs. |
| G | 500 | 200 | Sell 150 NO at 35; merge 50 pairs. |
| H | 500 | 100 | Buy 200 NO at 45; merge 50 pairs. |
| I | 500 | 100 | Sell 100 NO at 30 after the remaining bid at 35 expires. |

The exact passive order arrays, relative timestamps, and full expected balances are in [the scenario plan](../../docs/bitmap-realistic-market-test-plan.md) and the test sources. Preserve B-before-C FIFO and B's two separate asks at 55. The independent runner uses a market-relative time origin after deployment/funding; do not require its absolute timestamps to equal the unit test's timestamps.

| Taker action | Exact expected USDC movement, including taker fees |
| --- | ---: |
| D buys 250 YES | Pays 138.118750 |
| E buys 400 YES | Pays 235.469150 |
| F sells 220 YES | Receives 98.455500 |
| G sells 150 NO | Receives 52.158750 |
| H buys 200 NO | Pays 90.495000 |
| I sells 100 NO | Receives 29.790000; C additionally receives 17.5 expired-bid refund. |
| D buys 100 NO | Pays 50.247500; B additionally unlocks 100 expired NO shares. |

- B's cancellation refunds 80 USDC. C's version invalidation refunds 85.5 USDC and unlocks 100 YES plus 100 NO exactly once; new-version orders remain valid.
- Both outcomes must start from the same economic scenario; never change a terminal YES result into NO. The independent runner creates fresh deployments for each scenario rather than reverting chain snapshots.
- Leave C's 20 USDC buy deposit and 60 locked YES shares in place through settlement. `redeem` must handle them without prior cancellation.
- Test different redemption orders, losing-only holders receiving zero, repeated redemption reverting, and repeated fee collection/withdrawal transferring no additional funds.
- Literal final mainline anchors: initial deposits **9,000 USDC**; split **2,200 pairs**; merge **700 pairs**; unredeemed backing **1,500 USDC**; taker fees **3.426150**, maker rebates **1.713075**, platform net fees **1.713075 USDC**. For either outcome, users ultimately withdraw **8,998.286925 USDC**, A receives **1.713075 USDC**, and Vault's ERC20 balance becomes **0**.

## Budget-buy and cross-price-sale regressions

Run each case on YES and NO, using separate books/scenarios so its results do not change the mainline's reference balances.

1. **Budget buy:** B and C each deposit 1,000 USDC and split 200; B asks 100 shares at 40, C asks 100 at 50; D deposits 1,000. `buyUSDCAmount(90e6, side, 200e6)` must revert because the budget cannot buy 200 shares. With `minShareOut=199e6`, it must buy **199.024875** shares, spend **89.999999 USDC**, and leave **0.000001 USDC** of the budget available. C's ask retains **0.975125** shares.
2. **Unused budget/depth exhaustion:** D then buys with a 10 USDC budget and `minShareOut=975125` raw units. It receives only the remaining **0.975125** shares, spends **0.489999 USDC**, and leaves **9.510001 USDC** unspent. A subsequent empty-book budget buy requiring 1 share must revert.
3. **Cross-price sale:** B bids 100 shares at 45 and 200 at 40; C bids 150 at 45 and 100 at 42. B/C each deposit 1,000 USDC; F deposits 1,000 and splits 400. Selling 300 with a 133 USDC minimum must revert. With a 132 USDC minimum, fill B 100 at 45, C 150 at 45, and C 50 at 42: principal **133.5**, taker fee **0.740550**, net proceeds **132.759450 USDC**. C retains a 50-share bid at 42.
4. **Subsequent depth:** F sells its last 100 shares through C 50 at 42 and B 50 at 40, with a 40 USDC minimum, and receives **40.758200 USDC**.

All minimum-output failures must be followed by successful execution against the unchanged depth. Check per-fill integer rounding, not approximate floating-point totals. In the independent runner, each supplemental scenario also resolves, redeems, withdraws, and clears Vault.

## Assertions required after every operation

- Check all participants, not just the taker: wallet USDC, Vault withdrawable USDC, aggregate buy deposit, free and locked YES/NO, and order version. Validate deployment wiring and allowances where relevant.
- Check remaining orders: owner, side, price, remaining quantity, expiry, version, and FIFO order; bucket head bounds and bitmap consistency. Distinguish valid depth from historical entries awaiting cleanup.
- Validate the exact sequence and contents of each `TradeInfo` fill and reconcile maker/taker state changes, rebates, and platform fees. Reference accounting must use explicit scenario expectations, not copy the production matching algorithm or derive expected payouts from actual emitted amounts alone.
- Before resolution: total free+locked YES = total free+locked NO = cumulative split minus merge. After resolution/redemption, track remaining winning-share liabilities instead of requiring losing-share totals to stay paired.
- At every stage: Vault ERC20 assets = user available balances + buy deposits + unredeemed collateral liabilities + unwithdrawn platform fees. Count fees held in Market and Vault once; include external wallets and withdrawn fees in total-USDC conservation.
- Preserve refund dust from integer floors. Require eventual release through version invalidation or redemption rather than hiding discrepancies with a numeric tolerance.
- Unit tests may use prank/time controls and read-only `vm.load`. Check `forge inspect src/bitmap/Market.sol:Market storage-layout --json` when storage layout changes and update the test readers. Do not alter production storage or replace the Market implementation to manufacture a passing scenario.
- Separate verification costs from the operation being tested; full-ledger/order-book assertions are not business-transaction gas.

## Independent transactions and gas acceptance

- Use local Anvil with **`--network monad --hardfork monad:MonadTen`** and chain ID **31337**. Verify `anvil_nodeInfo` reports `monad`/`MonadTen`; keep compiler settings aligned with `foundry.toml`.
- Each actor signs with its own public-development-only test key and submits through `eth_sendRawTransaction`. Await the receipt before the next operation; the current runner verifies one transaction per block and strictly increasing block numbers. Do not use impersonation, `prank`, direct storage writes, or transaction-between snapshot resets in this runner.
- Fund test USDC by ordinary mock-token mint transactions, then approve and deposit. Native balances may be initialized by the local development node. Control only block time with `evm_setNextBlockTimestamp` to reproduce expiry scenarios.
- Expected failures must actually be submitted and mined, not merely rejected by `eth_estimateGas`/`eth_call`. Require receipt `status=0`, no persisted logs, the exact intended revert reason, and a consumed sender nonce; rule out out-of-gas failures.
- For failed business calls, compare Market, Vault, and USDC `eth_getProof` results before/after: `storageHash`, `codeHash`, balance, and nonce must be unchanged. User native-token balance and nonce do change because the failed transaction was paid for.
- **Monad charges `gasLimit * effectiveGasPrice`, not `gasUsed * effectiveGasPrice`.** Record both the execution `gasUsed` from the receipt and the submitted `gasLimit`; verify the sender's actual native-balance reduction. The runner sends zero native value, so the reduction equals the fee exactly. See [Monad gas pricing](https://docs.monad.xyz/developer-essentials/gas-pricing).
- Current reproducible local policy: legacy signed transactions, fixed **102 gwei** gas price, initial base fee **100 gwei**, successful limits = `floor(estimateGas * 1.2)`. For minimum-output failures, estimate the same route with minimum output zero, add the same margin, then submit the actual stricter call. Repeated redemption failures reuse the prior successful redemption's limit. Record changes to this policy; it affects actual MON charges.
- Report raw inputs/calldata, actor, output/state changes, status/revert reason, hash, block, nonce, `gasUsed`, `gasLimit`, effective gas price, actual native fee, and verification evidence for each transaction, including deployment and expected failures.
- These are receipts from a **local Monad-configured node**, not mainnet/testnet fork receipts, production USDC costs, or congestion measurements. Public-network broadcasting requires the appropriate task authorization and is not the default testing workflow.

## Reports and completion criteria

- The runner generates [the current receipt report](../../docs/bitmap-receipts/README.md), [CSV](../../docs/bitmap-receipts/receipts.csv), and [raw JSON/evidence](../../docs/bitmap-receipts/receipts.json). JSON includes receipts, account checkpoints, rollback proofs, environment metadata, and production-source hashes. Local hashes refer to that run's chain, which stops when the runner exits.
- `docs/bitmap-mainline-execution.*`, `docs/bitmap-mainline-setup.*`, and `script/bitmap/report_mainline.py` describe the earlier **Foundry call-frame gas** reports. They must not replace independent receipts or be presented as current transaction fees.
- A contract change is verified only when the applicable full suites pass, per-operation assertions and final settlement agree, and the receipt report has been regenerated from the changed source. Explain changed economic expectations or gas results; do not weaken tests just to retain a passing status.
- For future behavior changes, extend both the Foundry regressions and independent scenarios where applicable. Preserve the original reference scenario unless the requested change intentionally changes its semantics; update the plan and expected balances together in that case.
- The original **28 independent edge-case checklist** and **32 makers / 640 orders** stress plan in `docs/bitmap-realistic-market-test-plan.md` are **not fully implemented**. Coverage still needs permission failures, oracle replacement, pause-time trading rejection, terminal-transition rejection, precise expiry boundaries, self-trading, cancel/fill races, bucket reuse, multi-market isolation, randomized invariants, and large historical-bucket gas/work-budget tests. Do not claim those suites passed based on the current 14 tests or 324 transactions.
