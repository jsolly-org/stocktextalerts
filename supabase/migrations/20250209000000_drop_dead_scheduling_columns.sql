-- Drop dead columns: scheduled_updates_enabled and add_ons_notifications_enabled.
-- These columns are never read or written by the application.
-- The indexes that filtered on them were effectively empty/unused.

-- 1. Drop constraints that reference the dead columns
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_scheduled_updates_requires_time;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_add_ons_schedule_requires_time;

-- 2. Drop the dead columns
ALTER TABLE public.users DROP COLUMN IF EXISTS scheduled_updates_enabled;
ALTER TABLE public.users DROP COLUMN IF EXISTS add_ons_notifications_enabled;

-- 3. Recreate indexes with WHERE clauses matching actual cron queries

DROP INDEX IF EXISTS idx_users_next_send_at;
CREATE INDEX idx_users_next_send_at
  ON users (next_send_at)
  WHERE price_notifications_enabled = true
    AND next_send_at IS NOT NULL;

DROP INDEX IF EXISTS idx_users_add_ons_next_send_at;
CREATE INDEX idx_users_add_ons_next_send_at
  ON users (add_ons_next_send_at)
  WHERE add_ons_delivery_time IS NOT NULL
    AND add_ons_next_send_at IS NOT NULL;
