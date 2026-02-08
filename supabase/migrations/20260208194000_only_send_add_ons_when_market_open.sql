ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS only_send_add_ons_when_market_open boolean NOT NULL DEFAULT false;

