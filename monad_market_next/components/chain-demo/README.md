# Chain data demo

This folder contains the temporary direct RPC reader. It is intentionally isolated so it can be removed when the indexed production data layer is ready. The configured `bitmapLink` market is `monad:2026-09-15:1` at `0xDc60bB47dF26fB4D2e08eb7D1c9708E251305F8d`.

The reader obtains best prices from the packed storage words at slots 207 and 410, as defined by `foundry/src/bitmapLink/Market.sol`. For each YES/NO book, it queries five prices starting at the best bid and five starting at the best ask through `getActiveOrderShareAmount(uint8,bool)` in a viem multicall. These calls return active share totals and exclude expired or invalidated orders. The best price determines the side because the getter itself has no buy/sell argument. Empty books have sentinel prices 0/100 and display no levels. Connected wallets also load `Vault.balances` and `Market.traderInfos`; successful transactions trigger a refresh.

The price precision menu groups only the fetched levels; it does not request more than five raw prices per side. No indexer or historical order list is included.
