-- Add sector column to assets table for sector-aware onboarding examples.
-- Populated lazily via the Massive Ticker Overview API (/v3/reference/tickers/{ticker}).

ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS sector TEXT;
