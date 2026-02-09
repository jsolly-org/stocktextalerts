-- Split weekly include toggles into per-channel (email / sms) columns.
-- Rename existing columns to _email variants, add new _sms columns.
ALTER TABLE public.users RENAME COLUMN weekly_include_earnings  TO weekly_include_earnings_email;
ALTER TABLE public.users RENAME COLUMN weekly_include_dividends TO weekly_include_dividends_email;

ALTER TABLE public.users
  ADD COLUMN weekly_include_earnings_sms  boolean NOT NULL DEFAULT false,
  ADD COLUMN weekly_include_dividends_sms boolean NOT NULL DEFAULT false;
