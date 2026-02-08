ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS add_ons_only_notify_when_market_open BOOLEAN DEFAULT false NOT NULL;
