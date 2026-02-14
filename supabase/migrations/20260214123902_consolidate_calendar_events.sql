-- Consolidate earnings/dividends/splits per-channel toggles into a single "calendar" toggle.
-- The 6 old columns are replaced by 2 new ones; existing TRUE values are preserved via OR backfill.

-- 1. Add new columns
ALTER TABLE public.users
  ADD COLUMN asset_events_include_calendar_email BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN asset_events_include_calendar_sms   BOOLEAN NOT NULL DEFAULT false;

-- 2. Backfill from old columns (OR logic)
UPDATE public.users
SET asset_events_include_calendar_email = (
      asset_events_include_earnings_email
      OR asset_events_include_dividends_email
      OR asset_events_include_splits_email
    ),
    asset_events_include_calendar_sms = (
      asset_events_include_earnings_sms
      OR asset_events_include_dividends_sms
      OR asset_events_include_splits_sms
    );

-- 3. Drop the 6 old columns
ALTER TABLE public.users
  DROP COLUMN asset_events_include_earnings_email,
  DROP COLUMN asset_events_include_earnings_sms,
  DROP COLUMN asset_events_include_dividends_email,
  DROP COLUMN asset_events_include_dividends_sms,
  DROP COLUMN asset_events_include_splits_email,
  DROP COLUMN asset_events_include_splits_sms;
