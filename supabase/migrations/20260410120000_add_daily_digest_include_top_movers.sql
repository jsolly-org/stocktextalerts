-- Add email-only toggle for including market-wide top movers in the daily digest (opt-in, default OFF).
-- Top movers is an email-only section: the market-wide gainers/losers list can be long and
-- is shown alongside logos/formatting that only render well in HTML email.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS daily_digest_include_top_movers_email boolean NOT NULL DEFAULT false;

UPDATE public.app_metadata
  SET value = '20260410120000_add_daily_digest_include_top_movers'
  WHERE key = 'schema_version';
