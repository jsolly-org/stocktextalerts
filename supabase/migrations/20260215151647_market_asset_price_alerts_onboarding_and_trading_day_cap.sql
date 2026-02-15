/* =============
Realtime Asset Price Alerts v1
- Replace sensitivity with onboarding answers
- Cap realtime alerts to 1 per symbol per US trading day
============= */

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS market_asset_price_alert_risk_priority TEXT NOT NULL DEFAULT 'both_equally',
  ADD COLUMN IF NOT EXISTS market_asset_price_alert_market_context TEXT NOT NULL DEFAULT 'standout',
  ADD COLUMN IF NOT EXISTS market_asset_price_alert_move_size TEXT NOT NULL DEFAULT 'large';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_market_asset_price_alert_risk_priority_check'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_market_asset_price_alert_risk_priority_check
      CHECK (market_asset_price_alert_risk_priority IN ('big_drops', 'big_gains', 'both_equally'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_market_asset_price_alert_market_context_check'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_market_asset_price_alert_market_context_check
      CHECK (market_asset_price_alert_market_context IN ('standout', 'any_major', 'extreme_only'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_market_asset_price_alert_move_size_check'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_market_asset_price_alert_move_size_check
      CHECK (market_asset_price_alert_move_size IN ('moderate', 'large', 'very_large'));
  END IF;
END $$;

-- Backfill onboarding move-size from legacy sensitivity when present.
UPDATE public.users
SET market_asset_price_alert_move_size = CASE
  WHEN market_asset_price_alert_sensitivity = 1 THEN 'very_large'
  WHEN market_asset_price_alert_sensitivity = 3 THEN 'moderate'
  ELSE 'large'
END
WHERE market_asset_price_alert_sensitivity IS NOT NULL;

ALTER TABLE public.users
  DROP COLUMN IF EXISTS market_asset_price_alert_sensitivity;

CREATE OR REPLACE FUNCTION public.claim_market_asset_price_alert_trading_day(
  p_user_id uuid,
  p_symbol text,
  p_observed_at timestamptz DEFAULT pg_catalog.now()
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

  INSERT INTO public.market_asset_price_alert_cooldowns (user_id, symbol, last_alerted_at)
  VALUES (p_user_id, p_symbol, p_observed_at)
  ON CONFLICT (user_id, symbol) DO UPDATE
    SET last_alerted_at = p_observed_at
    WHERE (
      (
        (public.market_asset_price_alert_cooldowns.last_alerted_at AT TIME ZONE 'America/New_York')::date +
        CASE
          WHEN (public.market_asset_price_alert_cooldowns.last_alerted_at AT TIME ZONE 'America/New_York')::time >= time '16:00:00'
            THEN 1
          ELSE 0
        END
      )
    ) < claim_trading_day
  RETURNING true INTO claimed;

  RETURN COALESCE(claimed, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_market_asset_price_alert_trading_day(
  uuid,
  text,
  timestamptz
) TO service_role;

DROP FUNCTION IF EXISTS public.claim_market_asset_price_alert_cooldown(uuid, text, integer);
