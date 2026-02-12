-- Add volume tracking to snapshots
ALTER TABLE public.asset_snapshots ADD COLUMN IF NOT EXISTS volume NUMERIC(16,0);

-- Add user sensitivity preference (1=chill, 2=balanced, 3=aggressive)
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS instant_alert_sensitivity SMALLINT DEFAULT 1 NOT NULL;
