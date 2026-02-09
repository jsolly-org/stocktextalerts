-- Add weekly calendar notification columns to users table
ALTER TABLE users
  ADD COLUMN weekly_include_earnings boolean NOT NULL DEFAULT false,
  ADD COLUMN weekly_include_dividends boolean NOT NULL DEFAULT false,
  ADD COLUMN weekly_next_send_at timestamptz DEFAULT null;

-- Add new enum value for deduplication tracking
ALTER TYPE scheduled_notification_type ADD VALUE 'weekly_calendar';

-- Index for efficient cron queries (same pattern as daily_next_send_at index)
CREATE INDEX idx_users_weekly_next_send_at
  ON users (weekly_next_send_at)
  WHERE weekly_next_send_at IS NOT NULL;
