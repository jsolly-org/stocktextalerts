-- Add 'allow_recovery_follow_up' to the follow-up mode constraint.
-- Add last_alerted_move_direction to cooldowns for reversal detection.

-- Drop and recreate the constraint to include the new value.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_market_asset_price_alert_follow_up_mode_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_market_asset_price_alert_follow_up_mode_check
  CHECK (market_asset_price_alert_follow_up_mode IN ('first_only', 'allow_acceleration_follow_up', 'allow_recovery_follow_up'));

-- Track whether the initial alert was for a drop or gain (needed for reversal detection).
ALTER TABLE public.market_asset_price_alert_cooldowns
  ADD COLUMN IF NOT EXISTS last_alerted_move_direction TEXT;

-- Drop the old 6-param overload so the new 8-param version is the only one.
DROP FUNCTION IF EXISTS public.claim_market_asset_price_alert_slot(
  uuid, text, timestamptz, numeric, numeric, boolean
);

-- Create the claim RPC with recovery follow-up support.
CREATE OR REPLACE FUNCTION public.claim_market_asset_price_alert_slot(
  p_user_id uuid,
  p_symbol text,
  p_observed_at timestamptz DEFAULT pg_catalog.now(),
  p_abs_move_percent numeric DEFAULT 0,
  p_abs_move_dollar numeric DEFAULT 0,
  p_allow_acceleration_follow_up boolean DEFAULT false,
  p_allow_recovery_follow_up boolean DEFAULT false,
  p_move_direction text DEFAULT NULL
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
    max_abs_move_dollar,
    last_alerted_move_direction
  )
  VALUES (
    p_user_id,
    p_symbol,
    p_observed_at,
    claim_trading_day,
    1,
    GREATEST(p_abs_move_percent, 0),
    GREATEST(p_abs_move_dollar, 0),
    p_move_direction
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
      END,
      last_alerted_move_direction = CASE
        WHEN public.market_asset_price_alert_cooldowns.trading_day_key < claim_trading_day THEN p_move_direction
        ELSE public.market_asset_price_alert_cooldowns.last_alerted_move_direction
      END
    WHERE
      -- New trading day: always allow
      public.market_asset_price_alert_cooldowns.trading_day_key < claim_trading_day
      -- Acceleration follow-up: move has intensified
      OR (
        p_allow_acceleration_follow_up
        AND public.market_asset_price_alert_cooldowns.trading_day_key = claim_trading_day
        AND public.market_asset_price_alert_cooldowns.alerts_sent_count < 2
        AND (
          GREATEST(p_abs_move_percent, 0) >= public.market_asset_price_alert_cooldowns.max_abs_move_percent + 1
          OR GREATEST(p_abs_move_dollar, 0) >= public.market_asset_price_alert_cooldowns.max_abs_move_dollar + 2
        )
      )
      -- Recovery follow-up: move has reversed (returned to within 50% of threshold)
      OR (
        p_allow_recovery_follow_up
        AND public.market_asset_price_alert_cooldowns.trading_day_key = claim_trading_day
        AND public.market_asset_price_alert_cooldowns.alerts_sent_count < 2
        AND p_move_direction IS NOT NULL
        AND public.market_asset_price_alert_cooldowns.last_alerted_move_direction IS NOT NULL
        AND p_move_direction != public.market_asset_price_alert_cooldowns.last_alerted_move_direction
        AND GREATEST(p_abs_move_percent, 0) <= public.market_asset_price_alert_cooldowns.max_abs_move_percent * 0.5
      )
  RETURNING true INTO claimed;

  RETURN COALESCE(claimed, false);
END;
$$;

-- Grant must match the new signature (8 params).
GRANT EXECUTE ON FUNCTION public.claim_market_asset_price_alert_slot(
  uuid,
  text,
  timestamptz,
  numeric,
  numeric,
  boolean,
  boolean,
  text
) TO service_role;
