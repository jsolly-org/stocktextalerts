-- Consolidation migration: brings existing databases in line with the updated
-- initial_schema.sql.  Fresh environments already have the final schema, so
-- every DDL statement uses IF EXISTS / IF NOT EXISTS guards.
--
-- Changes covered:
--   1. Enum:   scheduled_notification_type values renamed + weekly_calendar dropped
--   2. Funcs:  is_valid_scheduled_update_times → is_valid_market_scheduled_asset_price_times
--              claim_instant_alert_cooldown    → claim_market_asset_price_alert_cooldown
--   3. Table:  instant_alert_cooldowns         → market_asset_price_alert_cooldowns (+FK)
--   4. Cols:   13 column renames on users (scheduled/daily/instant → new names)
--   5. Cols:   asset_events per-event toggles split into per-channel columns
--   6. Checks: constraint + index renames, two new invariants
--   7. Grants: asset_events made service-role-only, identity changed to BY DEFAULT

BEGIN;

/* ================================================================
   1.  ENUM — scheduled_notification_type
   ================================================================ */

-- Drop the function that depends on the enum type so we can replace it.
DROP FUNCTION IF EXISTS public.claim_scheduled_notification(
  uuid, public.scheduled_notification_type, date, integer, public.delivery_method
);

-- Convert the column to text temporarily.
ALTER TABLE public.scheduled_notifications
  ALTER COLUMN notification_type TYPE text;

-- Migrate old enum values in existing rows.
UPDATE public.scheduled_notifications
  SET notification_type = 'market'  WHERE notification_type = 'scheduled_update';
UPDATE public.scheduled_notifications
  SET notification_type = 'daily'   WHERE notification_type = 'daily_digest';
DELETE FROM public.scheduled_notifications
  WHERE notification_type = 'weekly_calendar';

-- Replace the enum.
DROP TYPE IF EXISTS public.scheduled_notification_type;
CREATE TYPE public.scheduled_notification_type AS ENUM ('market', 'daily', 'asset_events');

-- Cast column back.
ALTER TABLE public.scheduled_notifications
  ALTER COLUMN notification_type TYPE public.scheduled_notification_type
  USING notification_type::public.scheduled_notification_type;

-- Recreate claim_scheduled_notification with the new enum.
CREATE OR REPLACE FUNCTION public.claim_scheduled_notification(
  p_user_id uuid,
  p_notification_type public.scheduled_notification_type,
  p_scheduled_date date,
  p_scheduled_minutes integer,
  p_channel public.delivery_method
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  claimed boolean;
BEGIN
  INSERT INTO scheduled_notifications (
    user_id, notification_type, scheduled_date, scheduled_minutes, channel,
    status, attempt_count, last_attempt_at, error
  )
  VALUES (
    p_user_id, p_notification_type, p_scheduled_date, p_scheduled_minutes, p_channel,
    'sending', 1, pg_catalog.now(), NULL
  )
  ON CONFLICT (user_id, notification_type, scheduled_date, scheduled_minutes, channel)
  DO UPDATE
    SET status        = 'sending',
        attempt_count = scheduled_notifications.attempt_count + 1,
        last_attempt_at = pg_catalog.now(),
        error         = NULL
    WHERE scheduled_notifications.status <> 'sent'
      AND scheduled_notifications.attempt_count < 3
      AND (
        scheduled_notifications.status = 'failed'
        OR (
          scheduled_notifications.status = 'sending'
          AND scheduled_notifications.last_attempt_at < pg_catalog.now() - interval '10 minutes'
        )
      )
  RETURNING true INTO claimed;

  RETURN COALESCE(claimed, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_scheduled_notification(
  uuid, public.scheduled_notification_type, date, integer, public.delivery_method
) TO service_role;

/* ================================================================
   2.  FUNCTIONS — validation + cooldown
   ================================================================ */

-- Drop constraints that reference old functions before dropping the functions.
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_scheduled_update_times_check;

-- Replace is_valid_scheduled_update_times → is_valid_market_scheduled_asset_price_times
DROP FUNCTION IF EXISTS public.is_valid_scheduled_update_times(integer[]);

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
        WHERE val < 0 OR val >= 1440
      )
    );
$$;

-- Replace claim_instant_alert_cooldown → claim_market_asset_price_alert_cooldown
DROP FUNCTION IF EXISTS public.claim_instant_alert_cooldown(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.claim_market_asset_price_alert_cooldown(
  p_user_id uuid,
  p_symbol text,
  p_cooldown_minutes integer
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  claimed boolean;
BEGIN
  INSERT INTO public.market_asset_price_alert_cooldowns (user_id, symbol, last_alerted_at)
  VALUES (p_user_id, p_symbol, pg_catalog.now())
  ON CONFLICT (user_id, symbol) DO UPDATE
    SET last_alerted_at = pg_catalog.now()
    WHERE public.market_asset_price_alert_cooldowns.last_alerted_at
      <= pg_catalog.now() - make_interval(mins => p_cooldown_minutes)
  RETURNING true INTO claimed;

  RETURN COALESCE(claimed, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_market_asset_price_alert_cooldown(uuid, text, integer) TO service_role;

/* ================================================================
   3.  TABLE RENAME — instant_alert_cooldowns → market_asset_price_alert_cooldowns
   ================================================================ */

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'instant_alert_cooldowns') THEN
    ALTER TABLE public.instant_alert_cooldowns RENAME TO market_asset_price_alert_cooldowns;
  END IF;
END $$;

-- Add missing FK on symbol → assets(symbol).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.market_asset_price_alert_cooldowns'::regclass
      AND conname LIKE '%symbol_fkey%'
  ) THEN
    ALTER TABLE public.market_asset_price_alert_cooldowns
      ADD CONSTRAINT market_asset_price_alert_cooldowns_symbol_fkey
      FOREIGN KEY (symbol) REFERENCES public.assets(symbol) ON DELETE CASCADE;
  END IF;
END $$;

REVOKE ALL ON TABLE public.market_asset_price_alert_cooldowns FROM anon, authenticated;

/* ================================================================
   4.  COLUMN RENAMES on users
   ================================================================ */

-- Drop constraints that reference old column names.
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_daily_delivery_time_range;

-- Drop old indexes (will be recreated with new names).
DROP INDEX IF EXISTS public.idx_users_next_send_at;
DROP INDEX IF EXISTS public.idx_users_daily_next_send_at;

-- Market scheduled asset price notifications
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'scheduled_update_times'
  ) THEN
    ALTER TABLE public.users RENAME COLUMN scheduled_update_times          TO market_scheduled_asset_price_times;
    ALTER TABLE public.users RENAME COLUMN next_send_at                    TO market_scheduled_asset_price_next_send_at;
    ALTER TABLE public.users RENAME COLUMN price_notifications_enabled     TO market_scheduled_asset_price_enabled;
    ALTER TABLE public.users RENAME COLUMN price_include_email             TO market_scheduled_asset_price_include_email;
    ALTER TABLE public.users RENAME COLUMN price_include_sms               TO market_scheduled_asset_price_include_sms;
  END IF;
END $$;

-- Market asset price alerts (formerly "instant alerts")
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'instant_notifications_enabled'
  ) THEN
    ALTER TABLE public.users RENAME COLUMN instant_notifications_enabled   TO market_asset_price_alerts_enabled;
    ALTER TABLE public.users RENAME COLUMN instant_include_email           TO market_asset_price_alerts_include_email;
    ALTER TABLE public.users RENAME COLUMN instant_include_sms             TO market_asset_price_alerts_include_sms;
    ALTER TABLE public.users RENAME COLUMN instant_alert_sensitivity       TO market_asset_price_alert_sensitivity;
  END IF;
END $$;

-- Daily digest
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'daily_delivery_time'
  ) THEN
    ALTER TABLE public.users RENAME COLUMN daily_delivery_time             TO daily_digest_time;
    ALTER TABLE public.users RENAME COLUMN daily_next_send_at              TO daily_digest_next_send_at;
    ALTER TABLE public.users RENAME COLUMN daily_include_news_email        TO daily_digest_include_news_email;
    ALTER TABLE public.users RENAME COLUMN daily_include_rumors_email      TO daily_digest_include_rumors_email;
  END IF;
END $$;

-- Recreate constraints with new names.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_market_scheduled_asset_price_times_check'
  ) THEN
    ALTER TABLE public.users ADD CONSTRAINT users_market_scheduled_asset_price_times_check
      CHECK (public.is_valid_market_scheduled_asset_price_times(market_scheduled_asset_price_times));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_daily_digest_time_range'
  ) THEN
    ALTER TABLE public.users ADD CONSTRAINT users_daily_digest_time_range
      CHECK (daily_digest_time IS NULL OR (daily_digest_time >= 0 AND daily_digest_time <= 1439));
  END IF;
END $$;

-- Recreate indexes with new names.
CREATE INDEX IF NOT EXISTS idx_users_market_scheduled_asset_price_next_send_at
  ON public.users (market_scheduled_asset_price_next_send_at)
  WHERE market_scheduled_asset_price_enabled = true
    AND market_scheduled_asset_price_next_send_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_daily_digest_next_send_at
  ON public.users (daily_digest_next_send_at)
  WHERE daily_digest_time IS NOT NULL
    AND daily_digest_next_send_at IS NOT NULL;

/* ================================================================
   5.  ASSET-EVENTS — split per-event toggles into per-channel columns
   ================================================================ */

-- Add new per-channel columns.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS asset_events_include_earnings_email   BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS asset_events_include_earnings_sms     BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS asset_events_include_dividends_email  BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS asset_events_include_dividends_sms    BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS asset_events_include_splits_email     BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS asset_events_include_splits_sms       BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS asset_events_include_analyst_email    BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS asset_events_include_analyst_sms      BOOLEAN DEFAULT false NOT NULL;

-- Migrate data: old per-event toggle × old channel flag → new per-channel column.
-- Only runs when the old columns still exist; harmless on fresh databases.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'asset_events_include_email'
  ) THEN
    UPDATE public.users SET
      asset_events_include_earnings_email  = asset_events_include_earnings  AND asset_events_include_email,
      asset_events_include_earnings_sms    = asset_events_include_earnings  AND asset_events_include_sms,
      asset_events_include_dividends_email = asset_events_include_dividends AND asset_events_include_email,
      asset_events_include_dividends_sms   = asset_events_include_dividends AND asset_events_include_sms,
      asset_events_include_splits_email    = asset_events_include_splits    AND asset_events_include_email,
      asset_events_include_splits_sms      = asset_events_include_splits    AND asset_events_include_sms,
      asset_events_include_analyst_email   = asset_events_include_analyst   AND asset_events_include_email,
      asset_events_include_analyst_sms     = asset_events_include_analyst   AND asset_events_include_sms;
  END IF;
END $$;

-- Drop old columns.
ALTER TABLE public.users DROP COLUMN IF EXISTS asset_events_include_email;
ALTER TABLE public.users DROP COLUMN IF EXISTS asset_events_include_sms;
ALTER TABLE public.users DROP COLUMN IF EXISTS asset_events_include_earnings;
ALTER TABLE public.users DROP COLUMN IF EXISTS asset_events_include_dividends;
ALTER TABLE public.users DROP COLUMN IF EXISTS asset_events_include_splits;
ALTER TABLE public.users DROP COLUMN IF EXISTS asset_events_include_analyst;

/* ================================================================
   6.  NEW CONSTRAINTS — sms opt-out + phone-verified invariants
   ================================================================ */

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_sms_opted_out_blocks_sms_enabled'
  ) THEN
    ALTER TABLE public.users ADD CONSTRAINT users_sms_opted_out_blocks_sms_enabled
      CHECK (NOT (sms_opted_out AND sms_notifications_enabled));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_phone_verified_requires_phone'
  ) THEN
    ALTER TABLE public.users ADD CONSTRAINT users_phone_verified_requires_phone
      CHECK (NOT phone_verified OR (phone_country_code IS NOT NULL AND phone_number IS NOT NULL));
  END IF;
END $$;

/* ================================================================
   7.  GRANTS — asset_events service-role-only
   8.  IDENTITY — asset_events.id  ALWAYS → BY DEFAULT
   ================================================================ */

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'asset_events') THEN
    EXECUTE 'DROP POLICY IF EXISTS "Anyone can view asset events" ON public.asset_events';
    EXECUTE 'REVOKE SELECT ON TABLE public.asset_events FROM anon, authenticated';
    EXECUTE 'ALTER TABLE public.asset_events ALTER COLUMN id SET GENERATED BY DEFAULT';
  END IF;
END $$;

/* ================================================================
   9.  SCHEMA VERSION — bump to @v1 for the consolidated schema
   ================================================================ */

UPDATE public.app_metadata
  SET value = '20250101000000_initial_schema@v1'
  WHERE key = 'schema_version';

COMMIT;
