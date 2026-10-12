CREATE TABLE IF NOT EXISTS market_realtime.market_metadata (
  "marketAddress" text PRIMARY KEY, product text NOT NULL, "productLabel" text NOT NULL,
  "targetUsd" numeric NOT NULL, "settleAt" timestamptz NOT NULL, oracle text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN', "createTxHash" text NOT NULL, "settleTxHash" text,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
