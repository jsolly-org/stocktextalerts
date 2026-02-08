ALTER TABLE public.users
  RENAME COLUMN skip_if_market_closed TO only_notify_when_market_open;

ALTER TABLE public.users
  ALTER COLUMN only_notify_when_market_open SET DEFAULT true,
  ALTER COLUMN only_notify_when_market_open SET NOT NULL;

