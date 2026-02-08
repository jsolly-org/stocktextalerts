ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS last_market_closed_skip_scheduled_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS last_market_closed_skip_recorded_at timestamp with time zone;

