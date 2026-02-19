-- Align DB with UI: market context now only offers "Any big move" (any_major) and "Only standouts" (standout).
-- Migrate existing extreme_only to standout, then restrict allowed values and set default.

UPDATE public.users
SET market_asset_price_alert_market_context = 'standout'
WHERE market_asset_price_alert_market_context = 'extreme_only';

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_market_asset_price_alert_market_context_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_market_asset_price_alert_market_context_check
  CHECK (market_asset_price_alert_market_context IN ('standout', 'any_major'));

ALTER TABLE public.users
  ALTER COLUMN market_asset_price_alert_market_context SET DEFAULT 'standout';
