CREATE OR REPLACE FUNCTION public.is_valid_scheduled_update_times(
  times integer[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    times IS NULL OR (
      COALESCE(array_length(times, 1), 0) >= 1
      AND COALESCE(array_length(times, 1), 0) <= 5
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(times) AS entry
        WHERE entry IS NULL OR entry < 0 OR entry > 1439
      )
    );
$$;
