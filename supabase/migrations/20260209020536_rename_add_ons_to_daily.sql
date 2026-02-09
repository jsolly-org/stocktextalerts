-- Rename add_ons_* columns to daily_*
ALTER TABLE public.users RENAME COLUMN add_ons_only_notify_when_market_open TO daily_only_notify_when_market_open;
ALTER TABLE public.users RENAME COLUMN add_ons_delivery_time TO daily_delivery_time;
ALTER TABLE public.users RENAME COLUMN add_ons_next_send_at TO daily_next_send_at;
ALTER TABLE public.users RENAME COLUMN add_ons_include_news TO daily_include_news;
ALTER TABLE public.users RENAME COLUMN add_ons_include_rumors TO daily_include_rumors;
ALTER TABLE public.users RENAME COLUMN add_ons_include_analyst TO daily_include_analyst;
ALTER TABLE public.users RENAME COLUMN add_ons_include_insider TO daily_include_insider;

-- Rename the constraint
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_add_ons_delivery_time_range;
ALTER TABLE public.users ADD CONSTRAINT users_daily_delivery_time_range CHECK (
  daily_delivery_time IS NULL OR (
    daily_delivery_time >= 0 AND daily_delivery_time <= 1439
  )
);

-- Rename the index
DROP INDEX IF EXISTS idx_users_add_ons_next_send_at;
CREATE INDEX IF NOT EXISTS idx_users_daily_next_send_at
  ON users (daily_next_send_at)
  WHERE daily_delivery_time IS NOT NULL
    AND daily_next_send_at IS NOT NULL;

-- Rename the enum value: daily_add_ons -> daily_digest
ALTER TYPE public.scheduled_notification_type RENAME VALUE 'daily_add_ons' TO 'daily_digest';
