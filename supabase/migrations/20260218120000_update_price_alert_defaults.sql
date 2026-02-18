-- Update default values for realtime price alert onboarding columns
ALTER TABLE public.users
  ALTER COLUMN market_asset_price_alert_market_context SET DEFAULT 'extreme_only',
  ALTER COLUMN market_asset_price_alert_move_size SET DEFAULT 'very_large';
