-- Drop dividend-related columns from users table
-- (already removed from initial_schema.sql during consolidation)
ALTER TABLE public.users DROP COLUMN IF EXISTS weekly_include_dividends_email;
ALTER TABLE public.users DROP COLUMN IF EXISTS weekly_include_dividends_sms;
