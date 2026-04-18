-- Opt-in SMS toggle for including market-wide top movers in the daily digest (default OFF).
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS daily_digest_include_top_movers_sms boolean NOT NULL DEFAULT false;

UPDATE public.app_metadata
  SET value = '20260418130000_add_daily_digest_include_top_movers_sms'
  WHERE key = 'schema_version';
