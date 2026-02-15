ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS market_asset_price_alert_onboarding_completed BOOLEAN NOT NULL DEFAULT false;

UPDATE public.users
SET market_asset_price_alert_onboarding_completed = true
WHERE market_asset_price_alerts_enabled = true
   OR market_asset_price_alerts_include_email = true
   OR market_asset_price_alerts_include_sms = true;
