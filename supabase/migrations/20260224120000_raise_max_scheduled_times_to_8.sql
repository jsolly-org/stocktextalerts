-- Raise the maximum number of scheduled price notification times from 5 to 8.

CREATE OR REPLACE FUNCTION public.is_valid_market_scheduled_asset_price_times(
  times integer[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    times IS NULL OR (
      COALESCE(array_length(times, 1), 0) <= 8
      AND NOT EXISTS (
        SELECT 1 FROM unnest(times) AS t(val)
        WHERE val IS NULL OR val < 0 OR val >= 1440
      )
    );
$$;
