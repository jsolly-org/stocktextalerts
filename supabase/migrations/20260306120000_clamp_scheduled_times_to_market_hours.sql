-- One-off data migration: clamp scheduled asset price notification times
-- to within market hours (10:00 AM – 3:59 PM ET, i.e. 600–959 ET minutes).
--
-- Times stored as minutes-since-midnight in the user's local timezone.
-- We convert to ET, clamp, convert back, and deduplicate.

DO $$
DECLARE
  r RECORD;
  local_min INTEGER;
  et_time TIMESTAMP;
  et_minutes INTEGER;
  new_local_time TIMESTAMP;
  new_local_minutes INTEGER;
  new_times INTEGER[];
  changed BOOLEAN;
BEGIN
  FOR r IN
    SELECT id, timezone, market_scheduled_asset_price_times
    FROM public.users
    WHERE market_scheduled_asset_price_times IS NOT NULL
      AND array_length(market_scheduled_asset_price_times, 1) > 0
  LOOP
    new_times := '{}';
    changed := FALSE;

    FOREACH local_min IN ARRAY r.market_scheduled_asset_price_times
    LOOP
      -- Convert local minutes to Eastern Time (anchored to CURRENT_DATE; DST at run-time may differ from typical usage for edge-case users).
      et_time := (
        (CURRENT_DATE + (local_min * INTERVAL '1 minute'))
        AT TIME ZONE r.timezone
        AT TIME ZONE 'America/New_York'
      );
      et_minutes := EXTRACT(HOUR FROM et_time)::INTEGER * 60
                  + EXTRACT(MINUTE FROM et_time)::INTEGER;

      IF et_minutes < 600 THEN
        -- Below 10:00 AM ET → clamp up, convert back to local
        new_local_time := (
          (CURRENT_DATE + (600 * INTERVAL '1 minute'))
          AT TIME ZONE 'America/New_York'
          AT TIME ZONE r.timezone
        );
        new_local_minutes := EXTRACT(HOUR FROM new_local_time)::INTEGER * 60
                           + EXTRACT(MINUTE FROM new_local_time)::INTEGER;
        changed := TRUE;
      ELSIF et_minutes >= 960 THEN
        -- At or after 4:00 PM ET → clamp down to 3:59 PM, convert back
        new_local_time := (
          (CURRENT_DATE + (959 * INTERVAL '1 minute'))
          AT TIME ZONE 'America/New_York'
          AT TIME ZONE r.timezone
        );
        new_local_minutes := EXTRACT(HOUR FROM new_local_time)::INTEGER * 60
                           + EXTRACT(MINUTE FROM new_local_time)::INTEGER;
        changed := TRUE;
      ELSE
        new_local_minutes := local_min;
      END IF;

      -- Deduplicate (multiple out-of-range times may clamp to the same value)
      IF NOT new_local_minutes = ANY(new_times) THEN
        new_times := array_append(new_times, new_local_minutes);
      END IF;
    END LOOP;

    IF changed OR new_times IS DISTINCT FROM r.market_scheduled_asset_price_times THEN
      UPDATE public.users
      SET market_scheduled_asset_price_times = new_times
      WHERE id = r.id;
    END IF;
  END LOOP;
END $$;

-- Bump schema version
UPDATE public.app_metadata
  SET value = '20260306120000_clamp_scheduled_times_to_market_hours'
  WHERE key = 'schema_version';
