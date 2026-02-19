-- Align production user options with current UI (fewer choices; map old values to new).
-- Market context (extreme_only → standout) already done in 20260219143843.

-- 1. Risk priority: UI no longer asks; everyone gets "both equally".
UPDATE public.users
SET market_asset_price_alert_risk_priority = 'both_equally'
WHERE market_asset_price_alert_risk_priority IN ('big_drops', 'big_gains');

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_market_asset_price_alert_risk_priority_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_market_asset_price_alert_risk_priority_check
  CHECK (market_asset_price_alert_risk_priority = 'both_equally');

-- 2. Move size: UI only offers Moderate and Large; map very_large → large.
UPDATE public.users
SET market_asset_price_alert_move_size = 'large'
WHERE market_asset_price_alert_move_size = 'very_large';

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_market_asset_price_alert_move_size_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_market_asset_price_alert_move_size_check
  CHECK (market_asset_price_alert_move_size IN ('moderate', 'large'));

ALTER TABLE public.users
  ALTER COLUMN market_asset_price_alert_move_size SET DEFAULT 'large';

-- 3. Follow-up: UI only offers "First alert only" and "Allow one follow-up"; map legacy to combined.
UPDATE public.users
SET market_asset_price_alert_follow_up_mode = 'allow_follow_up'
WHERE market_asset_price_alert_follow_up_mode IN ('allow_acceleration_follow_up', 'allow_recovery_follow_up');

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_market_asset_price_alert_follow_up_mode_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_market_asset_price_alert_follow_up_mode_check
  CHECK (market_asset_price_alert_follow_up_mode IN ('first_only', 'allow_follow_up'));
