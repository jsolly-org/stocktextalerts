ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS skip_if_market_closed boolean NOT NULL DEFAULT true;

