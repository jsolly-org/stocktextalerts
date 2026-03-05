-- Drop unused price-alert columns from users table and simplify the
-- claim_market_asset_price_alert_slot RPC (follow-up logic is dead code;
-- app always passes false/null for follow-up params).

-- 1. Drop constraints on columns being removed
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_market_asset_price_alert_risk_priority_check;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_market_asset_price_alert_follow_up_mode_check;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_market_asset_price_alert_market_context_check;

-- 2. Drop the unused columns from users
ALTER TABLE public.users
  DROP COLUMN IF EXISTS market_asset_price_alert_risk_priority,
  DROP COLUMN IF EXISTS market_asset_price_alert_follow_up_mode,
  DROP COLUMN IF EXISTS market_asset_price_alert_onboarding_completed,
  DROP COLUMN IF EXISTS market_asset_price_alert_market_context;

-- 3. Drop the last_alerted_move_direction column from cooldowns (only used
--    by follow-up logic which is now removed)
ALTER TABLE public.market_asset_price_alert_cooldowns
  DROP COLUMN IF EXISTS last_alerted_move_direction;

-- 4. Replace the 8-param claim RPC with a simplified 4-param version
--    that only supports one-per-trading-day (no follow-up).
DROP FUNCTION IF EXISTS public.claim_market_asset_price_alert_slot(
  uuid, text, timestamptz, numeric, numeric, boolean, boolean, text
);

CREATE OR REPLACE FUNCTION public.claim_market_asset_price_alert_slot(
  p_user_id uuid,
  p_symbol text,
  p_abs_move_percent numeric DEFAULT 0,
  p_abs_move_dollar numeric DEFAULT 0
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  claimed boolean;
  claim_local_ts timestamp;
  claim_trading_day date;
  v_abs_move_percent numeric;
  v_abs_move_dollar numeric;
BEGIN
  v_abs_move_percent := GREATEST(COALESCE(p_abs_move_percent, 0), 0);
  v_abs_move_dollar := GREATEST(COALESCE(p_abs_move_dollar, 0), 0);

  claim_local_ts := now() AT TIME ZONE 'America/New_York';
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
    now(),
    claim_trading_day,
    1,
    v_abs_move_percent,
    v_abs_move_dollar
  )
  ON CONFLICT (user_id, symbol) DO UPDATE
    SET
      last_alerted_at = now(),
      trading_day_key = CASE
        WHEN public.market_asset_price_alert_cooldowns.trading_day_key < claim_trading_day THEN claim_trading_day
        ELSE public.market_asset_price_alert_cooldowns.trading_day_key
      END,
      alerts_sent_count = CASE
        WHEN public.market_asset_price_alert_cooldowns.trading_day_key < claim_trading_day THEN 1
        ELSE public.market_asset_price_alert_cooldowns.alerts_sent_count + 1
      END,
      max_abs_move_percent = CASE
        WHEN public.market_asset_price_alert_cooldowns.trading_day_key < claim_trading_day THEN v_abs_move_percent
        ELSE GREATEST(
          public.market_asset_price_alert_cooldowns.max_abs_move_percent,
          v_abs_move_percent
        )
      END,
      max_abs_move_dollar = CASE
        WHEN public.market_asset_price_alert_cooldowns.trading_day_key < claim_trading_day THEN v_abs_move_dollar
        ELSE GREATEST(
          public.market_asset_price_alert_cooldowns.max_abs_move_dollar,
          v_abs_move_dollar
        )
      END
    WHERE
      public.market_asset_price_alert_cooldowns.trading_day_key < claim_trading_day
  RETURNING true INTO claimed;

  RETURN COALESCE(claimed, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_market_asset_price_alert_slot(
  uuid, text, numeric, numeric
) TO service_role;

