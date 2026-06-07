-- Price history cache for sparkline fallback + purge helpers.
-- Benchmark-safe: no FK to assets (SPY/sector ETFs may not be user-tracked).

SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.asset_price_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    symbol varchar(10) NOT NULL,
    price numeric(12,4) NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asset_price_history_pkey PRIMARY KEY (id),
    CONSTRAINT asset_price_history_symbol_no_whitespace CHECK (public.has_no_whitespace((symbol)::text))
);

ALTER TABLE public.asset_price_history OWNER TO postgres;

CREATE INDEX IF NOT EXISTS idx_asset_price_history_captured_at
    ON public.asset_price_history USING btree (captured_at);

CREATE INDEX IF NOT EXISTS idx_asset_price_history_symbol_captured
    ON public.asset_price_history USING btree (symbol, captured_at DESC);

CREATE TABLE IF NOT EXISTS public.asset_daily_closes (
    symbol varchar(10) NOT NULL,
    trading_date date NOT NULL,
    close numeric(12,4) NOT NULL,
    CONSTRAINT asset_daily_closes_pkey PRIMARY KEY (symbol, trading_date),
    CONSTRAINT asset_daily_closes_symbol_no_whitespace CHECK (public.has_no_whitespace((symbol)::text))
);

ALTER TABLE public.asset_daily_closes OWNER TO postgres;

CREATE INDEX IF NOT EXISTS idx_asset_daily_closes_trading_date
    ON public.asset_daily_closes USING btree (trading_date);

CREATE OR REPLACE FUNCTION public.purge_old_asset_price_history(p_retention_hours integer DEFAULT 36)
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
AS $$
DECLARE
    deleted_count integer;
BEGIN
    DELETE FROM asset_price_history
    WHERE captured_at < NOW() - (p_retention_hours || ' hours')::interval;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

ALTER FUNCTION public.purge_old_asset_price_history(p_retention_hours integer) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.purge_old_asset_daily_closes(p_retention_days integer DEFAULT 30)
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
AS $$
DECLARE
    deleted_count integer;
BEGIN
    DELETE FROM asset_daily_closes
    WHERE trading_date < CURRENT_DATE - p_retention_days;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

ALTER FUNCTION public.purge_old_asset_daily_closes(p_retention_days integer) OWNER TO postgres;

ALTER TABLE public.asset_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_daily_closes ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.asset_price_history TO service_role;
GRANT ALL ON TABLE public.asset_daily_closes TO service_role;

GRANT ALL ON FUNCTION public.purge_old_asset_price_history(integer) TO service_role;
GRANT ALL ON FUNCTION public.purge_old_asset_daily_closes(integer) TO service_role;

REVOKE ALL ON FUNCTION public.purge_old_asset_price_history(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_old_asset_daily_closes(integer) FROM PUBLIC;

UPDATE public.app_metadata
SET value = '20260607143355_vendor_backfill_price_history_cache'
WHERE key = 'schema_version';
