-- Split daily include toggles into per-channel (email / sms) columns.
-- News and Rumors are email-only, so just rename.
-- Analyst and Insider get both email (renamed) and sms (new column).
ALTER TABLE public.users RENAME COLUMN daily_include_news    TO daily_include_news_email;
ALTER TABLE public.users RENAME COLUMN daily_include_rumors  TO daily_include_rumors_email;
ALTER TABLE public.users RENAME COLUMN daily_include_analyst TO daily_include_analyst_email;
ALTER TABLE public.users RENAME COLUMN daily_include_insider TO daily_include_insider_email;

ALTER TABLE public.users
  ADD COLUMN daily_include_analyst_sms boolean NOT NULL DEFAULT false,
  ADD COLUMN daily_include_insider_sms boolean NOT NULL DEFAULT false;
