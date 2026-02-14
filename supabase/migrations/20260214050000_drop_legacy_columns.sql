-- Drop legacy columns that were renamed/replaced in production.
-- Uses IF EXISTS so this is safe to run on both local and prod.

ALTER TABLE users DROP COLUMN IF EXISTS daily_include_analyst_email;
ALTER TABLE users DROP COLUMN IF EXISTS daily_include_analyst_sms;
ALTER TABLE users DROP COLUMN IF EXISTS daily_include_insider_email;
ALTER TABLE users DROP COLUMN IF EXISTS daily_include_insider_sms;
ALTER TABLE users DROP COLUMN IF EXISTS weekly_include_earnings_email;
ALTER TABLE users DROP COLUMN IF EXISTS weekly_include_earnings_sms;
ALTER TABLE users DROP COLUMN IF EXISTS weekly_next_send_at;

DROP INDEX IF EXISTS idx_users_weekly_next_send_at;
