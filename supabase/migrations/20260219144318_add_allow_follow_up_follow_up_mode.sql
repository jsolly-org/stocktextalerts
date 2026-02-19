-- Add 'allow_follow_up' (combined acceleration or recovery) to follow-up mode constraint.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_market_asset_price_alert_follow_up_mode_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_market_asset_price_alert_follow_up_mode_check
  CHECK (market_asset_price_alert_follow_up_mode IN (
    'first_only',
    'allow_follow_up',
    'allow_acceleration_follow_up',
    'allow_recovery_follow_up'
  ));
