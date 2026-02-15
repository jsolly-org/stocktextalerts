ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS market_asset_price_alert_follow_up_mode TEXT NOT NULL DEFAULT 'first_only';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_market_asset_price_alert_follow_up_mode_check'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_market_asset_price_alert_follow_up_mode_check
      CHECK (market_asset_price_alert_follow_up_mode IN ('first_only', 'allow_acceleration_follow_up'));
  END IF;
END $$;

ALTER TABLE public.market_asset_price_alert_cooldowns
  ADD COLUMN IF NOT EXISTS trading_day_key DATE,
  ADD COLUMN IF NOT EXISTS alerts_sent_count INTEGER,
  ADD COLUMN IF NOT EXISTS max_abs_move_percent NUMERIC(8,4),
  ADD COLUMN IF NOT EXISTS max_abs_move_dollar NUMERIC(12,4);

UPDATE public.market_asset_price_alert_cooldowns
SET
  trading_day_key = (last_alerted_at AT TIME ZONE 'America/New_York')::date,
  alerts_sent_count = COALESCE(alerts_sent_count, 1),
  max_abs_move_percent = COALESCE(max_abs_move_percent, 0),
  max_abs_move_dollar = COALESCE(max_abs_move_dollar, 0)
WHERE
  trading_day_key IS NULL
  OR alerts_sent_count IS NULL
  OR max_abs_move_percent IS NULL
  OR max_abs_move_dollar IS NULL;

ALTER TABLE public.market_asset_price_alert_cooldowns
  ALTER COLUMN trading_day_key SET NOT NULL,
  ALTER COLUMN trading_day_key SET DEFAULT CURRENT_DATE,
  ALTER COLUMN alerts_sent_count SET NOT NULL,
  ALTER COLUMN alerts_sent_count SET DEFAULT 1,
  ALTER COLUMN max_abs_move_percent SET NOT NULL,
  ALTER COLUMN max_abs_move_percent SET DEFAULT 0,
  ALTER COLUMN max_abs_move_dollar SET NOT NULL,
  ALTER COLUMN max_abs_move_dollar SET DEFAULT 0;

CREATE OR REPLACE FUNCTION public.claim_market_asset_price_alert_slot(
  p_user_id uuid,
  p_symbol text,
  p_observed_at timestamptz DEFAULT pg_catalog.now(),
  p_abs_move_percent numeric DEFAULT 0,
  p_abs_move_dollar numeric DEFAULT 0,
  p_allow_acceleration_follow_up boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  claimed boolean;
  claim_local_ts timestamp;
  claim_trading_day date;
BEGIN
  claim_local_ts := p_observed_at AT TIME ZONE 'America/New_York';
  claim_trading_day := claim_local_ts::date;
  IF claim_local_ts::time >= time '16:00:00' THEN
    claim_trading_day := claim_trading_day + 1;
  END IF;

  INSERT INTO public.market_asset_price_alert_cooldowns (
    user_id,
    symbol,
    last_alerted_at,
    trading_day_key,
    alerts_sent_count,
    max_abs_move_percent,
    max_abs_move_dollar
  )
  VALUES (
    p_user_id,
    p_symbol,
    p_observed_at,
    claim_trading_day,
    1,
    GREATEST(p_abs_move_percent, 0),
    GREATEST(p_abs_move_dollar, 0)
  )
  ON CONFLICT (user_id, symbol) DO UPDATE
    SET
      last_alerted_at = p_observed_at,
      trading_day_key = CASE
        WHEN public.market_asset_price_alert_cooldowns.trading_day_key < claim_trading_day THEN claim_trading_day
        ELSE public.market_asset_price_alert_cooldowns.trading_day_key
      END,
      alerts_sent_count = CASE
        WHEN public.market_asset_price_alert_cooldowns.trading_day_key < claim_trading_day THEN 1
        ELSE public.market_asset_price_alert_cooldowns.alerts_sent_count + 1
      END,
      max_abs_move_percent = CASE
        WHEN public.market_asset_price_alert_cooldowns.trading_day_key < claim_trading_day THEN GREATEST(p_abs_move_percent, 0)
        ELSE GREATEST(
          public.market_asset_price_alert_cooldowns.max_abs_move_percent,
          GREATEST(p_abs_move_percent, 0)
        )
      END,
      max_abs_move_dollar = CASE
        WHEN public.market_asset_price_alert_cooldowns.trading_day_key < claim_trading_day THEN GREATEST(p_abs_move_dollar, 0)
        ELSE GREATEST(
          public.market_asset_price_alert_cooldowns.max_abs_move_dollar,
          GREATEST(p_abs_move_dollar, 0)
        )
      END
    WHERE
      public.market_asset_price_alert_cooldowns.trading_day_key < claim_trading_day
      OR (
        p_allow_acceleration_follow_up
        AND public.market_asset_price_alert_cooldowns.trading_day_key = claim_trading_day
        AND public.market_asset_price_alert_cooldowns.alerts_sent_count < 2
        AND (
          GREATEST(p_abs_move_percent, 0) >= public.market_asset_price_alert_cooldowns.max_abs_move_percent + 1
          OR GREATEST(p_abs_move_dollar, 0) >= public.market_asset_price_alert_cooldowns.max_abs_move_dollar + 2
        )
      )
  RETURNING true INTO claimed;

  RETURN COALESCE(claimed, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_market_asset_price_alert_slot(
  uuid,
  text,
  timestamptz,
  numeric,
  numeric,
  boolean
) TO service_role;
