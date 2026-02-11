/* =============
Instant Alerts: Asset Snapshots (rolling window)
============= */

CREATE TABLE IF NOT EXISTS public.asset_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol VARCHAR(10) NOT NULL REFERENCES assets(symbol) ON DELETE CASCADE,
  price NUMERIC(12,4) NOT NULL,
  change_percent NUMERIC(8,4) NOT NULL,
  day_high NUMERIC(12,4),
  day_low NUMERIC(12,4),
  day_open NUMERIC(12,4),
  prev_close NUMERIC(12,4),
  volume NUMERIC(16,0),
  captured_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_asset_snapshots_symbol_captured ON public.asset_snapshots (symbol, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_asset_snapshots_captured_at ON public.asset_snapshots (captured_at);

ALTER TABLE public.asset_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.asset_snapshots FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.asset_snapshots TO service_role;

/* =============
Instant Alerts: Cooldowns
============= */

CREATE TABLE IF NOT EXISTS public.instant_alert_cooldowns (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol VARCHAR(10) NOT NULL REFERENCES assets(symbol) ON DELETE CASCADE,
  last_alerted_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  PRIMARY KEY (user_id, symbol)
);

ALTER TABLE public.instant_alert_cooldowns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.instant_alert_cooldowns FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.instant_alert_cooldowns TO service_role;

/* =============
Instant Alerts: User Preference Columns
============= */

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS instant_notifications_enabled BOOLEAN DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS instant_include_email BOOLEAN DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS instant_include_sms BOOLEAN DEFAULT false NOT NULL;

/* =============
Instant Alerts: Purge Old Snapshots
============= */

CREATE OR REPLACE FUNCTION public.purge_old_asset_snapshots(p_retention_minutes integer DEFAULT 60)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE deleted_count integer;
BEGIN
  DELETE FROM asset_snapshots WHERE captured_at < NOW() - (p_retention_minutes || ' minutes')::interval;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_old_asset_snapshots(integer) TO service_role;
