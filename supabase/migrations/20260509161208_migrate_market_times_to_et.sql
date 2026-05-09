-- One-off migration: convert users.market_scheduled_asset_price_times
-- from user-local-minutes to ET-canonical minutes, and widen the valid
-- window from RTH (10:00–3:59 PM ET = [600, 959]) to extended-hours
-- (4:30 AM – 7:30 PM ET = [270, 1170]).

DO $$
DECLARE
	r RECORD;
	local_min INTEGER;
	et_minutes INTEGER;
	new_times INTEGER[];
BEGIN
	-- Idempotency guard: a sentinel in app_metadata blocks re-running the
	-- conversion. Required because db:reset replays all migrations and
	-- naive re-conversion would treat already-ET values as local-minutes.
	IF EXISTS (
		SELECT 1 FROM public.app_metadata
		WHERE key = 'market_times_storage' AND value = 'et_minutes'
	) THEN
		RAISE NOTICE 'market_times_storage is already et_minutes; skipping conversion';
		RETURN;
	END IF;

	FOR r IN
		SELECT id, timezone, market_scheduled_asset_price_times
		FROM public.users
		WHERE market_scheduled_asset_price_times IS NOT NULL
			AND array_length(market_scheduled_asset_price_times, 1) > 0
	LOOP
		new_times := '{}';
		FOREACH local_min IN ARRAY r.market_scheduled_asset_price_times
		LOOP
			et_minutes := EXTRACT(HOUR FROM (
				(CURRENT_DATE + (local_min * INTERVAL '1 minute'))
				AT TIME ZONE r.timezone
				AT TIME ZONE 'America/New_York'
			))::INTEGER * 60
			+ EXTRACT(MINUTE FROM (
				(CURRENT_DATE + (local_min * INTERVAL '1 minute'))
				AT TIME ZONE r.timezone
				AT TIME ZONE 'America/New_York'
			))::INTEGER;

			-- Defensively clamp to the new valid range. Pre-migration values
			-- were validated against the 10:00–3:59 ET window, so post-conversion
			-- values *should* fall in [600, 959]. Edge cases near DST transitions
			-- could drift; clamp into [270, 1170] so the new CHECK can't fail.
			IF et_minutes < 270 THEN et_minutes := 270; END IF;
			IF et_minutes > 1170 THEN et_minutes := 1170; END IF;

			IF NOT et_minutes = ANY(new_times) THEN
				new_times := array_append(new_times, et_minutes);
			END IF;
		END LOOP;

		SELECT COALESCE(array_agg(v ORDER BY v), '{}')
		INTO new_times FROM unnest(new_times) AS v;

		UPDATE public.users
		SET market_scheduled_asset_price_times = new_times
		WHERE id = r.id;
	END LOOP;

	-- Mark migration done so a re-run is a no-op.
	INSERT INTO public.app_metadata (key, value)
	VALUES ('market_times_storage', 'et_minutes')
	ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
END $$;

-- Replace the validator function with the new bounds [270, 1170].
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
				WHERE val IS NULL OR val < 270 OR val > 1170
			)
		);
$$;

-- Bump schema version.
UPDATE public.app_metadata
	SET value = '20260509161208_migrate_market_times_to_et'
	WHERE key = 'schema_version';
