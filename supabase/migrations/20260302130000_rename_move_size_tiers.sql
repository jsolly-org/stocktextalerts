-- Rename move-size tiers: moderate → significant, large → extreme
-- Raises thresholds to reduce notification volume.

-- 1. Drop old CHECK constraint
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_market_asset_price_alert_move_size_check;

-- 2. Rename existing values
UPDATE public.users
SET market_asset_price_alert_move_size = 'significant'
WHERE market_asset_price_alert_move_size = 'moderate';

UPDATE public.users
SET market_asset_price_alert_move_size = 'extreme'
WHERE market_asset_price_alert_move_size = 'large';

-- 3. Add new CHECK constraint
ALTER TABLE public.users
  ADD CONSTRAINT users_market_asset_price_alert_move_size_check
  CHECK (market_asset_price_alert_move_size IN ('significant', 'extreme'));

-- 4. Update default
ALTER TABLE public.users
  ALTER COLUMN market_asset_price_alert_move_size SET DEFAULT 'extreme';

-- 5. Bump schema version
UPDATE public.app_metadata
  SET value = '20260302130000_rename_move_size_tiers'
  WHERE key = 'schema_version';
