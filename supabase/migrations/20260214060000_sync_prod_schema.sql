-- Sync prod schema to match local.

-- 1. asset_events.id: integer → bigint (idempotent — no-op if already bigint)
ALTER TABLE asset_events ALTER COLUMN id SET DATA TYPE bigint;

-- 2. asset_events.symbol: varchar → text (idempotent — no-op if already text)
ALTER TABLE asset_events ALTER COLUMN symbol SET DATA TYPE text;

-- 3. Add unique constraint on asset_events (skip if already exists)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'asset_events_symbol_event_type_event_date_week_of_key'
  ) THEN
    ALTER TABLE asset_events
      ADD CONSTRAINT asset_events_symbol_event_type_event_date_week_of_key
      UNIQUE (symbol, event_type, event_date, week_of);
  END IF;
END $$;

-- 4. Rename FK on market_asset_price_alert_cooldowns
ALTER TABLE market_asset_price_alert_cooldowns
  DROP CONSTRAINT IF EXISTS instant_alert_cooldowns_symbol_fkey;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'market_asset_price_alert_cooldowns_symbol_fkey'
  ) THEN
    ALTER TABLE market_asset_price_alert_cooldowns
      ADD CONSTRAINT market_asset_price_alert_cooldowns_symbol_fkey
      FOREIGN KEY (symbol) REFERENCES assets(symbol) ON DELETE CASCADE;
  END IF;
END $$;

-- 5. Harden check_rate_limit search_path
CREATE OR REPLACE FUNCTION public.check_rate_limit(p_user_id uuid, p_endpoint text, p_max_requests integer, p_window_minutes integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  request_count integer;
  window_start timestamp with time zone;
  lock_key bigint;
BEGIN
  IF NULLIF(current_setting('request.jwt.claims', true), '')::json->>'role' = 'authenticated'
     AND p_user_id <> (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'Cannot check rate limit for another user';
  END IF;

  IF p_max_requests IS NULL OR p_max_requests <= 0 THEN
    RAISE EXCEPTION 'invalid rate limit parameter: p_max_requests must be > 0';
  END IF;

  IF p_window_minutes IS NULL OR p_window_minutes <= 0 THEN
    RAISE EXCEPTION 'invalid rate limit parameter: p_window_minutes must be > 0';
  END IF;

  window_start := pg_catalog.now() - (p_window_minutes || ' minutes')::interval;

  lock_key := pg_catalog.hashtext(p_user_id::text || '|' || p_endpoint);

  PERFORM pg_advisory_xact_lock(lock_key);

  DELETE FROM rate_limit_log
  WHERE user_id = p_user_id
    AND endpoint = p_endpoint
    AND created_at < window_start;

  INSERT INTO rate_limit_log (user_id, endpoint)
  SELECT p_user_id, p_endpoint
  WHERE (SELECT COUNT(*) FROM rate_limit_log
         WHERE user_id = p_user_id
           AND endpoint = p_endpoint
           AND created_at >= window_start) < p_max_requests;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$function$;
