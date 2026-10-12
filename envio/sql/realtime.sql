-- Run after Envio initializes its entity tables, and again after --restart.
BEGIN;
CREATE SCHEMA IF NOT EXISTS market_realtime;
CREATE TABLE IF NOT EXISTS market_realtime.changes (
  transaction_id text NOT NULL,
  market text NOT NULL DEFAULT '',
  trader text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (transaction_id, market, trader)
);
CREATE INDEX IF NOT EXISTS changes_created_at ON market_realtime.changes (created_at);

CREATE OR REPLACE FUNCTION market_realtime.record_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_data jsonb;
  tx text := pg_current_xact_id()::text;
  market_key text;
  trader_key text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
  -- Record both old and new scopes if an address changes, including deletes.
  FOR row_data IN
    SELECT value FROM jsonb_array_elements(
      CASE TG_OP
        WHEN 'INSERT' THEN jsonb_build_array(to_jsonb(NEW))
        WHEN 'DELETE' THEN jsonb_build_array(to_jsonb(OLD))
        ELSE jsonb_build_array(to_jsonb(OLD), to_jsonb(NEW))
      END)
  LOOP
    market_key := CASE WHEN TG_TABLE_NAME = 'VaultBalance' THEN '' ELSE lower(row_data->>'marketAddress') END;
    trader_key := CASE WHEN TG_TABLE_NAME IN ('MarketOrders', 'MarketState') THEN '' ELSE lower(row_data->>'traderAddress') END;
    INSERT INTO market_realtime.changes(transaction_id, market, trader)
      VALUES (tx, coalesce(market_key, ''), coalesce(trader_key, ''))
      ON CONFLICT DO NOTHING;
  END LOOP;
  -- Identical channel + payload is folded into ONE notification per transaction.
  -- PostgreSQL delivers it only once the entire transaction commits.
  PERFORM pg_notify('market_realtime', tx);
  RETURN NULL;
END;
$$;

DO $$
DECLARE entity text;
BEGIN
  FOREACH entity IN ARRAY ARRAY['MarketOrders', 'MarketState', 'MarketPosition', 'VaultBalance'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS market_realtime_change ON public.%I', entity);
    EXECUTE format('CREATE TRIGGER market_realtime_change AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION market_realtime.record_change()', entity);
  END LOOP;
END;
$$;
COMMIT;
