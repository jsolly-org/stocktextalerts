-- Remove the "only notify when market is open" feature entirely.
-- Notifications are now always sent regardless of market hours.
-- Deploy order note: ship app code that no longer reads these columns before
-- applying this migration to avoid transient errors during mixed deployments.
ALTER TABLE public.users
  DROP COLUMN IF EXISTS only_notify_when_market_open,
  DROP COLUMN IF EXISTS daily_only_notify_when_market_open,
  DROP COLUMN IF EXISTS last_market_closed_skip_scheduled_at,
  DROP COLUMN IF EXISTS last_market_closed_skip_recorded_at;
