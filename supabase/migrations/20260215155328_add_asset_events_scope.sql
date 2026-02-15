-- Add explicit scope to asset_events so global events (IPO) are not
-- implicitly coupled to watchlist-scoped event queries.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'asset_event_scope') THEN
    CREATE TYPE public.asset_event_scope AS ENUM ('watchlist', 'global');
  END IF;
END $$;

ALTER TABLE public.asset_events
  ADD COLUMN IF NOT EXISTS scope public.asset_event_scope NOT NULL DEFAULT 'watchlist';

-- Existing IPO rows are global feed items.
UPDATE public.asset_events
SET scope = 'global'
WHERE event_type = 'ipo';

CREATE INDEX IF NOT EXISTS idx_asset_events_scope_event_date
  ON public.asset_events (scope, event_date);
