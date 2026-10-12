# Monad Market indexer

This local HyperIndex project indexes the deployed `bitmapLink` contracts on
Monad testnet (chain 10143). Factory and Vault proxy addresses and the start
block are pinned in `config.yaml`; markets are discovered from `CreateMarket`.

## Run locally

Requirements: Node.js 22+, Docker with WSL integration, and an Envio API token.
Create `.env` from `.env.example`, set `ENVIO_API_TOKEN`, then run:

```bash
npm ci
npm run codegen
npm run typecheck
npm run dev
```

`envio dev` starts PostgreSQL and Hasura in Docker. The GraphQL console is at
`http://localhost:8080`. `MONAD_RPC_URL` must support historical `eth_call`:
the position handler reads `traderInfos` at each event's block to capture
changes that the emitted events do not describe completely.

## Data rules

- Addresses are lowercased by Envio. Amounts and share counts are raw integers
  with 6 decimals; fees and rates retain their on-chain units.
- `MarketOrders` uses `market:isYes:price:orderIndex` as the active slot ID.
  The slot can be reused; `insertEventId` identifies a particular insertion.
- A fully filled, explicitly deleted, or version-invalidated order is removed.
  Expired orders remain until their slot is reused or another event removes them.
  Frontend queries must filter `endTimestamp = 0` or `endTimestamp >= now`.
- `MarketOrderHistory` contains only `OrderInsert`, `UpdateVersion`, and explicit
  `DeleteOrder` events. Fills are in `MarketTransaction` only.
- `VaultBalance` excludes accumulated market fees. `GetMarketFee` and
  `WithDrawFee` have their own `VaultTransaction` rows.
- `MarketPosition` is a block-end snapshot, not an intrablock event snapshot.

The future market creation worker can use the same PostgreSQL instance, but
should own a separate `app` schema and its own migrations for `MarketInfo`.
Do not add worker-owned tables to `schema.graphql`.
# Database commit notifications for the frontend

After Envio initializes the entity tables, install the realtime triggers from the repository root:

```bash
docker exec -i envio-postgres psql -v ON_ERROR_STOP=1 -U postgres -d envio-dev < envio/sql/realtime.sql
```

Normal service restarts preserve these triggers. After `envio dev --restart` or recreating
the entity tables, run this command again. It is safe to run repeatedly.
The `market_realtime` schema is separate from Envio entities and is not exposed through Hasura.
Changed market/wallet scopes are deduplicated by database transaction. PostgreSQL emits one
notification after commit; rolled back batches emit none. Updates and deletes, including
reorg rollback writes, use the same triggers. The frontend listener retains scopes for one day
and prunes older records hourly; disconnected clients recover by fetching a fresh snapshot.


-------------------------------------------------------------------
# 终端一
cd /home/xxx/monad_market/envio
npm run dev

# 终端二
cd /home/xxx/monad_market/monad_market_next
npm run dev