


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."asset_event_type" AS ENUM (
    'earnings',
    'dividend',
    'split'
);


ALTER TYPE "public"."asset_event_type" OWNER TO "postgres";


CREATE TYPE "public"."delivery_method" AS ENUM (
    'email',
    'sms'
);


ALTER TYPE "public"."delivery_method" OWNER TO "postgres";


CREATE TYPE "public"."scheduled_notification_status" AS ENUM (
    'sending',
    'sent',
    'failed'
);


ALTER TYPE "public"."scheduled_notification_status" OWNER TO "postgres";


CREATE TYPE "public"."scheduled_notification_type" AS ENUM (
    'market',
    'daily',
    'asset_events'
);


ALTER TYPE "public"."scheduled_notification_type" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_rate_limit"("p_user_id" "uuid", "p_endpoint" "text", "p_max_requests" integer, "p_window_minutes" integer) RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  request_count integer;
  window_start timestamp with time zone;
  lock_key bigint;
BEGIN
  IF NULLIF(current_setting('request.jwt.claims', true), '')::json->>'role' = 'authenticated'
     AND p_user_id <> (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'Cannot check rate limit for another user';
  END IF;

  IF p_max_requests IS NULL OR p_max_requests <= 0 THEN
    RAISE EXCEPTION 'invalid rate limit parameter: p_max_requests must be > 0';
  END IF;

  IF p_window_minutes IS NULL OR p_window_minutes <= 0 THEN
    RAISE EXCEPTION 'invalid rate limit parameter: p_window_minutes must be > 0';
  END IF;

  window_start := pg_catalog.now() - (p_window_minutes || ' minutes')::interval;

  lock_key := pg_catalog.hashtext(p_user_id::text || '|' || p_endpoint);

  PERFORM pg_advisory_xact_lock(lock_key);

  DELETE FROM rate_limit_log
  WHERE user_id = p_user_id
    AND endpoint = p_endpoint
    AND created_at < window_start;

  INSERT INTO rate_limit_log (user_id, endpoint)
  SELECT p_user_id, p_endpoint
  WHERE (SELECT COUNT(*) FROM rate_limit_log
         WHERE user_id = p_user_id
           AND endpoint = p_endpoint
           AND created_at >= window_start) < p_max_requests;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;


ALTER FUNCTION "public"."check_rate_limit"("p_user_id" "uuid", "p_endpoint" "text", "p_max_requests" integer, "p_window_minutes" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_flat_price_alert"("p_user_id" "uuid", "p_symbol" "text", "p_baseline_price" numeric, "p_new_price" numeric, "p_threshold_percent" numeric) RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  current_row public.price_move_alert_state%ROWTYPE;
  today_et date;
  move_pct numeric;
BEGIN
  -- Defensive input validation
  IF p_baseline_price IS NULL OR p_baseline_price <= 0 THEN
    RETURN false;
  END IF;
  IF p_new_price IS NULL OR p_new_price <= 0 THEN
    RETURN false;
  END IF;
  IF p_threshold_percent IS NULL OR p_threshold_percent <= 0 THEN
    RETURN false;
  END IF;

  today_et := (now() AT TIME ZONE 'America/New_York')::date;
  move_pct := abs((p_new_price - p_baseline_price) / p_baseline_price * 100);

  IF move_pct < p_threshold_percent THEN
    RETURN false;
  END IF;

  -- Lock the row (or no row) for the duration of the transaction
  SELECT * INTO current_row
  FROM public.price_move_alert_state
  WHERE user_id = p_user_id AND symbol = p_symbol
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Case 1: first-of-day, no row exists
    BEGIN
      INSERT INTO public.price_move_alert_state (
        user_id, symbol, last_notification_price, last_notification_at
      ) VALUES (
        p_user_id, p_symbol, p_new_price, now()
      );
      RETURN true;
    EXCEPTION WHEN unique_violation THEN
      -- Another concurrent insert beat us
      RETURN false;
    END;
  END IF;

  -- Row exists. Check if it's from a prior trading day (ET).
  IF (current_row.last_notification_at AT TIME ZONE 'America/New_York')::date < today_et THEN
    -- Case 2: stale row from yesterday or earlier, refresh unconditionally
    UPDATE public.price_move_alert_state
    SET last_notification_price = p_new_price,
        last_notification_at = now()
    WHERE user_id = p_user_id AND symbol = p_symbol;
    RETURN true;
  END IF;

  -- Case 3: row from today. Caller's baseline must match the row's current
  -- last_notification_price (optimistic lock) to prevent double-alerts from
  -- overlapping cron ticks.
  IF current_row.last_notification_price = p_baseline_price THEN
    UPDATE public.price_move_alert_state
    SET last_notification_price = p_new_price,
        last_notification_at = now()
    WHERE user_id = p_user_id AND symbol = p_symbol;
    RETURN true;
  END IF;

  -- Race lost: another tick re-triggered this symbol between caller's read
  -- and this call. Back off.
  RETURN false;
END;
$$;


ALTER FUNCTION "public"."claim_flat_price_alert"("p_user_id" "uuid", "p_symbol" "text", "p_baseline_price" numeric, "p_new_price" numeric, "p_threshold_percent" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_market_asset_price_alert_slot"("p_user_id" "uuid", "p_symbol" "text", "p_abs_move_percent" numeric DEFAULT 0, "p_abs_move_dollar" numeric DEFAULT 0) RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
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
      trading_day_key = claim_trading_day,
      alerts_sent_count = 1,
      max_abs_move_percent = v_abs_move_percent,
      max_abs_move_dollar = v_abs_move_dollar
    WHERE
      public.market_asset_price_alert_cooldowns.trading_day_key < claim_trading_day
  RETURNING true INTO claimed;

  RETURN COALESCE(claimed, false);
END;
$$;


ALTER FUNCTION "public"."claim_market_asset_price_alert_slot"("p_user_id" "uuid", "p_symbol" "text", "p_abs_move_percent" numeric, "p_abs_move_dollar" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_market_asset_price_alert_trading_day"("p_user_id" "uuid", "p_symbol" "text", "p_observed_at" timestamp with time zone DEFAULT "now"()) RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
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


ALTER FUNCTION "public"."claim_market_asset_price_alert_trading_day"("p_user_id" "uuid", "p_symbol" "text", "p_observed_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_scheduled_notification"("p_user_id" "uuid", "p_notification_type" "public"."scheduled_notification_type", "p_scheduled_date" "date", "p_scheduled_minutes" integer, "p_channel" "public"."delivery_method") RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
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


ALTER FUNCTION "public"."claim_scheduled_notification"("p_user_id" "uuid", "p_notification_type" "public"."scheduled_notification_type", "p_scheduled_date" "date", "p_scheduled_minutes" integer, "p_channel" "public"."delivery_method") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_auth_user_deleted"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  DELETE FROM public.users WHERE id = OLD.id;
  RETURN OLD;
END;
$$;


ALTER FUNCTION "public"."handle_auth_user_deleted"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_no_whitespace"("value" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE STRICT
    AS $$
  SELECT value !~ '\s';
$$;


ALTER FUNCTION "public"."has_no_whitespace"("value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_valid_market_scheduled_asset_price_times"("times" integer[]) RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
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


ALTER FUNCTION "public"."is_valid_market_scheduled_asset_price_times"("times" integer[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."purge_expired_short_urls"() RETURNS bigint
    LANGUAGE "sql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  WITH deleted AS (
    DELETE FROM public.short_urls
    WHERE expires_at < now()
    RETURNING 1
  )
  SELECT count(*) FROM deleted;
$$;


ALTER FUNCTION "public"."purge_expired_short_urls"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."purge_old_asset_snapshots"("p_retention_minutes" integer DEFAULT 60) RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE deleted_count integer;
BEGIN
  DELETE FROM asset_snapshots WHERE captured_at < NOW() - (p_retention_minutes || ' minutes')::interval;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;


ALTER FUNCTION "public"."purge_old_asset_snapshots"("p_retention_minutes" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_user_assets"("user_id" "uuid", "symbols" "text"[]) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  jwt_role text;
  sanitized_symbols text[];
  sanitized_count integer;
  symbol_with_whitespace text;
  symbol_not_uppercase text;
  duplicate_symbol text;
BEGIN
  jwt_role := COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::json->>'role';

  IF jwt_role IS NULL OR jwt_role NOT IN ('authenticated', 'service_role') THEN
    RAISE EXCEPTION 'replace_user_assets: role must be authenticated or service_role, got: %',
      COALESCE(jwt_role, '<null>')
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF jwt_role = 'authenticated' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'replace_user_assets: authenticated role requires auth.uid() to be set'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF replace_user_assets.user_id <> auth.uid() THEN
      RAISE EXCEPTION 'replace_user_assets: cannot replace assets for another user (user_id=%, auth.uid=%)',
        replace_user_assets.user_id,
        auth.uid()
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  DELETE FROM user_assets WHERE user_assets.user_id = replace_user_assets.user_id;

  -- Return without further modification when symbols is NULL/empty (DELETE already ran for clear-all case).
  IF symbols IS NULL OR array_length(symbols, 1) IS NULL THEN
    -- Clean up all price targets and flat-alert state since watchlist is now empty
    DELETE FROM price_targets WHERE price_targets.user_id = replace_user_assets.user_id;
    DELETE FROM price_move_alert_state WHERE price_move_alert_state.user_id = replace_user_assets.user_id;
    RETURN;
  END IF;

  -- Reject symbols with any whitespace
  SELECT entry INTO symbol_with_whitespace
  FROM unnest(symbols) AS raw(entry)
  WHERE NOT public.has_no_whitespace(entry)
  LIMIT 1;

  IF symbol_with_whitespace IS NOT NULL THEN
    RAISE EXCEPTION 'Asset symbol contains whitespace'
      USING ERRCODE = 'check_violation',
            DETAIL = symbol_with_whitespace;
  END IF;

  -- Reject symbols that are not uppercase
  SELECT entry INTO symbol_not_uppercase
  FROM unnest(symbols) AS raw(entry)
  WHERE entry <> '' AND entry <> UPPER(entry)
  LIMIT 1;

  IF symbol_not_uppercase IS NOT NULL THEN
    RAISE EXCEPTION 'Asset symbol is not uppercase: %', symbol_not_uppercase
      USING ERRCODE = 'check_violation';
  END IF;

  -- Reject duplicate symbols
  SELECT entry INTO duplicate_symbol
  FROM (
    SELECT entry, COUNT(*) as cnt
    FROM unnest(symbols) AS raw(entry)
    WHERE entry <> ''
    GROUP BY entry
    HAVING COUNT(*) > 1
    LIMIT 1
  ) duplicates;

  IF duplicate_symbol IS NOT NULL THEN
    RAISE EXCEPTION 'Duplicate asset symbol: %', duplicate_symbol
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT ARRAY(
    SELECT entry AS symbol
    FROM unnest(symbols) AS raw(entry)
    WHERE entry <> ''
  ) INTO sanitized_symbols;

  IF sanitized_symbols IS NULL OR array_length(sanitized_symbols, 1) IS NULL THEN
    -- Clean up all price targets and flat-alert state since no valid symbols remain
    DELETE FROM price_targets WHERE price_targets.user_id = replace_user_assets.user_id;
    DELETE FROM price_move_alert_state WHERE price_move_alert_state.user_id = replace_user_assets.user_id;
    RETURN;
  END IF;

  SELECT array_length(sanitized_symbols, 1) INTO sanitized_count;
  IF sanitized_count > 10 THEN
    RAISE EXCEPTION 'Tracked assets limit exceeded'
      USING ERRCODE = 'check_violation',
        CONSTRAINT = 'user_assets_max_limit';
  END IF;

  INSERT INTO user_assets (user_id, symbol)
  SELECT replace_user_assets.user_id, symbol
  FROM unnest(sanitized_symbols) AS symbol;

  -- Clean up price targets for symbols no longer in the watchlist
  DELETE FROM price_targets
  WHERE price_targets.user_id = replace_user_assets.user_id
    AND price_targets.symbol <> ALL(sanitized_symbols);

  -- Clean up flat-alert state for symbols no longer in the watchlist
  DELETE FROM price_move_alert_state
  WHERE price_move_alert_state.user_id = replace_user_assets.user_id
    AND price_move_alert_state.symbol <> ALL(sanitized_symbols);
END;
$$;


ALTER FUNCTION "public"."replace_user_assets"("user_id" "uuid", "symbols" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reserve_sms_verification"("p_user_id" "uuid", "p_phone_country_code" "text", "p_phone_number" "text", "p_cooldown_ms" integer) RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  reserved boolean;
  lock_key bigint;
BEGIN
  IF NULLIF(current_setting('request.jwt.claims', true), '')::json->>'role' = 'authenticated'
     AND p_user_id <> (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'Cannot reserve SMS verification for another user';
  END IF;

  IF p_cooldown_ms IS NULL OR p_cooldown_ms <= 0 THEN
    RAISE EXCEPTION 'invalid cooldown parameter: p_cooldown_ms must be > 0'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  lock_key := pg_catalog.hashtext(p_user_id::text || '|reserve_sms_verification');
  PERFORM pg_advisory_xact_lock(lock_key);

  UPDATE public.users
  SET
    phone_country_code = p_phone_country_code,
    phone_number = p_phone_number,
    phone_verified = false,
    verification_sent_at = pg_catalog.now()
  WHERE id = p_user_id
    AND (
      verification_sent_at IS NULL
      OR verification_sent_at <= pg_catalog.now() - (p_cooldown_ms || ' milliseconds')::interval
    )
  RETURNING true INTO reserved;

  RETURN COALESCE(reserved, false);
END;
$$;


ALTER FUNCTION "public"."reserve_sms_verification"("p_user_id" "uuid", "p_phone_country_code" "text", "p_phone_number" "text", "p_cooldown_ms" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rollback_sms_verification_reservation"("p_user_id" "uuid", "p_expected_verification_sent_at" timestamp with time zone, "p_restore_verification_sent_at" timestamp with time zone) RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  rolled_back boolean;
  lock_key bigint;
BEGIN
  IF NULLIF(current_setting('request.jwt.claims', true), '')::json->>'role' = 'authenticated'
     AND p_user_id <> (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'Cannot rollback SMS verification reservation for another user';
  END IF;

  IF p_expected_verification_sent_at IS NULL THEN
    RAISE EXCEPTION 'invalid rollback parameter: p_expected_verification_sent_at must not be NULL'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  lock_key := pg_catalog.hashtext(p_user_id::text || '|reserve_sms_verification');
  PERFORM pg_advisory_xact_lock(lock_key);

  UPDATE public.users
  SET verification_sent_at = p_restore_verification_sent_at
  WHERE id = p_user_id
    AND verification_sent_at = p_expected_verification_sent_at
  RETURNING true INTO rolled_back;

  RETURN COALESCE(rolled_back, false);
END;
$$;


ALTER FUNCTION "public"."rollback_sms_verification_reservation"("p_user_id" "uuid", "p_expected_verification_sent_at" timestamp with time zone, "p_restore_verification_sent_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  NEW.updated_at = pg_catalog.now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."app_metadata" (
    "key" "text" NOT NULL,
    "value" "text" NOT NULL
);


ALTER TABLE "public"."app_metadata" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."asset_events" (
    "id" bigint NOT NULL,
    "symbol" "text" NOT NULL,
    "event_type" "public"."asset_event_type" NOT NULL,
    "event_date" "date" NOT NULL,
    "week_of" "date" NOT NULL,
    "data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."asset_events" OWNER TO "postgres";


ALTER TABLE "public"."asset_events" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."asset_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."asset_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "symbol" character varying(10) NOT NULL,
    "price" numeric(12,4) NOT NULL,
    "change_percent" numeric(8,4) NOT NULL,
    "day_high" numeric(12,4),
    "day_low" numeric(12,4),
    "day_open" numeric(12,4),
    "prev_close" numeric(12,4),
    "volume" numeric(16,0),
    "captured_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."asset_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."assets" (
    "symbol" character varying(10) NOT NULL,
    "name" character varying(255) NOT NULL,
    "type" "text" DEFAULT 'stock'::"text" NOT NULL,
    "sector" "text",
    "icon_url" "text",
    "icon_base64" "text",
    "delisted_at" timestamp with time zone,
    CONSTRAINT "assets_symbol_no_whitespace" CHECK ("public"."has_no_whitespace"(("symbol")::"text")),
    CONSTRAINT "assets_type_check" CHECK (("type" = ANY (ARRAY['stock'::"text", 'etf'::"text"])))
);


ALTER TABLE "public"."assets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."daily_asset_stats" (
    "symbol" character varying(10) NOT NULL,
    "computed_at" "date" DEFAULT CURRENT_DATE NOT NULL,
    "avg_volume_20d" numeric(16,0),
    "atr_14" numeric(12,4)
);


ALTER TABLE "public"."daily_asset_stats" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."market_asset_price_alert_cooldowns" (
    "user_id" "uuid" NOT NULL,
    "symbol" character varying(10) NOT NULL,
    "last_alerted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "trading_day_key" "date" DEFAULT CURRENT_DATE NOT NULL,
    "alerts_sent_count" integer DEFAULT 1 NOT NULL,
    "max_abs_move_percent" numeric(8,4) DEFAULT 0 NOT NULL,
    "max_abs_move_dollar" numeric(12,4) DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."market_asset_price_alert_cooldowns" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."market_events" (
    "id" integer NOT NULL,
    "event_type" character varying(20) NOT NULL,
    "symbol" character varying(10) NOT NULL,
    "event_date" "date" NOT NULL,
    "week_of" "date" NOT NULL,
    "data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."market_events" OWNER TO "postgres";


ALTER TABLE "public"."market_events" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."market_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."notification_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "type" character varying(50) NOT NULL,
    "delivery_method" "public"."delivery_method" NOT NULL,
    "message_delivered" boolean DEFAULT true NOT NULL,
    "message" "text",
    "error" "text",
    "error_code" character varying(50),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."notification_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."price_move_alert_state" (
    "user_id" "uuid" NOT NULL,
    "symbol" character varying(10) NOT NULL,
    "last_notification_price" numeric(20,6) NOT NULL,
    "last_notification_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "price_move_alert_state_last_notification_price_check" CHECK (("last_notification_price" > (0)::numeric))
);


ALTER TABLE "public"."price_move_alert_state" OWNER TO "postgres";


COMMENT ON TABLE "public"."price_move_alert_state" IS 'Per-user per-symbol state for flat price alerts. Row presence + last_notification_at ET date drive baseline selection (last_notification_price vs quote.prev_close).';



CREATE TABLE IF NOT EXISTS "public"."price_targets" (
    "user_id" "uuid" NOT NULL,
    "symbol" character varying(10) NOT NULL,
    "target_price" numeric(12,4) NOT NULL,
    "direction" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "price_targets_direction_check" CHECK (("direction" = ANY (ARRAY['above'::"text", 'below'::"text"]))),
    CONSTRAINT "price_targets_target_price_check" CHECK (("target_price" > (0)::numeric))
);


ALTER TABLE "public"."price_targets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rate_limit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "endpoint" character varying(255) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."rate_limit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scheduled_notifications" (
    "user_id" "uuid" NOT NULL,
    "notification_type" "public"."scheduled_notification_type" NOT NULL,
    "scheduled_date" "date" NOT NULL,
    "scheduled_minutes" integer NOT NULL,
    "channel" "public"."delivery_method" NOT NULL,
    "status" "public"."scheduled_notification_status" NOT NULL,
    "attempt_count" integer DEFAULT 0 NOT NULL,
    "last_attempt_at" timestamp with time zone,
    "sent_at" timestamp with time zone,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "scheduled_notifications_attempt_count_check" CHECK (("attempt_count" >= 0)),
    CONSTRAINT "scheduled_notifications_scheduled_minutes_check" CHECK ((("scheduled_minutes" >= 0) AND ("scheduled_minutes" <= 1439)))
);


ALTER TABLE "public"."scheduled_notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."short_urls" (
    "id" "text" NOT NULL,
    "original_url" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '30 days'::interval) NOT NULL,
    CONSTRAINT "short_urls_id_check" CHECK (("id" ~ '^[A-Za-z0-9]{6}$'::"text"))
);


ALTER TABLE "public"."short_urls" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."staged_notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "notification_type" "text" NOT NULL,
    "scheduled_for" timestamp with time zone NOT NULL,
    "staged_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "staged_data" "jsonb" NOT NULL,
    CONSTRAINT "staged_notifications_notification_type_check" CHECK (("notification_type" = ANY (ARRAY['market'::"text", 'daily'::"text"])))
);


ALTER TABLE "public"."staged_notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."timezones" (
    "value" "text" NOT NULL,
    "label" "text" NOT NULL,
    "display_order" smallint NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    CONSTRAINT "timezones_display_order_check" CHECK (("display_order" >= 0))
);


ALTER TABLE "public"."timezones" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_assets" (
    "user_id" "uuid" NOT NULL,
    "symbol" character varying(10) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_assets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" character varying(255) NOT NULL,
    "phone_country_code" character varying(5),
    "phone_number" character varying(15),
    "full_phone" character varying(20) GENERATED ALWAYS AS (
CASE
    WHEN (("phone_country_code" IS NOT NULL) AND ("phone_number" IS NOT NULL)) THEN (("phone_country_code")::"text" || ("phone_number")::"text")
    ELSE NULL::"text"
END) STORED,
    "phone_verified" boolean DEFAULT false NOT NULL,
    "verification_sent_at" timestamp with time zone,
    "timezone" "text" DEFAULT 'America/New_York'::"text" NOT NULL,
    "market_scheduled_asset_price_times" integer[] DEFAULT '{}'::integer[],
    "market_scheduled_asset_price_next_send_at" timestamp with time zone,
    "daily_digest_time" integer,
    "daily_digest_next_send_at" timestamp with time zone,
    "last_grok_rumors_at" timestamp with time zone,
    "daily_digest_include_news_email" boolean DEFAULT false NOT NULL,
    "daily_digest_include_rumors_email" boolean DEFAULT false NOT NULL,
    "grok_window_start" timestamp with time zone,
    "grok_sends_in_window" integer DEFAULT 0 NOT NULL,
    "market_scheduled_asset_price_enabled" boolean DEFAULT false NOT NULL,
    "market_scheduled_asset_price_include_email" boolean DEFAULT false NOT NULL,
    "market_scheduled_asset_price_include_sms" boolean DEFAULT false NOT NULL,
    "email_notifications_enabled" boolean DEFAULT true NOT NULL,
    "sms_opted_out" boolean DEFAULT false NOT NULL,
    "dismiss_timezone_mismatch_prompts" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "market_asset_price_alerts_enabled" boolean DEFAULT false NOT NULL,
    "market_asset_price_alerts_include_email" boolean DEFAULT false NOT NULL,
    "market_asset_price_alerts_include_sms" boolean DEFAULT false NOT NULL,
    "asset_events_include_analyst_email" boolean DEFAULT false NOT NULL,
    "asset_events_include_analyst_sms" boolean DEFAULT false NOT NULL,
    "asset_events_include_insider_email" boolean DEFAULT false NOT NULL,
    "asset_events_include_insider_sms" boolean DEFAULT false NOT NULL,
    "asset_events_next_send_at" timestamp with time zone,
    "asset_events_last_analyst_sent_month" "text",
    "use_24_hour_time" boolean DEFAULT false NOT NULL,
    "asset_events_include_ipo_email" boolean DEFAULT false NOT NULL,
    "asset_events_include_ipo_sms" boolean DEFAULT false NOT NULL,
    "asset_events_include_calendar_email" boolean DEFAULT false NOT NULL,
    "asset_events_include_calendar_sms" boolean DEFAULT false NOT NULL,
    "market_asset_price_alert_move_size" "text" DEFAULT 'extreme'::"text" NOT NULL,
    "sms_notifications_enabled" boolean DEFAULT false NOT NULL,
    "price_targets_include_email" boolean DEFAULT false NOT NULL,
    "price_targets_include_sms" boolean DEFAULT false NOT NULL,
    "daily_digest_include_prices_email" boolean DEFAULT true NOT NULL,
    "daily_digest_include_prices_sms" boolean DEFAULT true NOT NULL,
    "daily_digest_include_top_movers_email" boolean DEFAULT false NOT NULL,
    "price_move_alerts_include_email" boolean DEFAULT false NOT NULL,
    "price_move_alerts_include_sms" boolean DEFAULT false NOT NULL,
    "daily_digest_include_top_movers_sms" boolean DEFAULT false NOT NULL,
    CONSTRAINT "phone_country_code_format" CHECK ((("phone_country_code")::"text" ~ '^\+[0-9]{1,4}$'::"text")),
    CONSTRAINT "phone_fields_together" CHECK (((("phone_country_code" IS NULL) AND ("phone_number" IS NULL)) OR (("phone_country_code" IS NOT NULL) AND ("phone_number" IS NOT NULL)))),
    CONSTRAINT "phone_number_format" CHECK ((("phone_number")::"text" ~ '^[0-9]{10,14}$'::"text")),
    CONSTRAINT "users_daily_digest_time_range" CHECK ((("daily_digest_time" IS NULL) OR (("daily_digest_time" >= 0) AND ("daily_digest_time" <= 1439)))),
    CONSTRAINT "users_email_no_whitespace" CHECK ("public"."has_no_whitespace"(("email")::"text")),
    CONSTRAINT "users_email_non_empty" CHECK ((("email")::"text" <> ''::"text")),
    CONSTRAINT "users_market_asset_price_alert_move_size_check" CHECK (("market_asset_price_alert_move_size" = ANY (ARRAY['significant'::"text", 'extreme'::"text"]))),
    CONSTRAINT "users_market_scheduled_asset_price_times_check" CHECK ("public"."is_valid_market_scheduled_asset_price_times"("market_scheduled_asset_price_times")),
    CONSTRAINT "users_phone_country_code_no_whitespace" CHECK ("public"."has_no_whitespace"(("phone_country_code")::"text")),
    CONSTRAINT "users_phone_number_no_whitespace" CHECK ("public"."has_no_whitespace"(("phone_number")::"text")),
    CONSTRAINT "users_phone_verified_requires_phone" CHECK (((NOT "phone_verified") OR (("phone_country_code" IS NOT NULL) AND ("phone_number" IS NOT NULL)))),
    CONSTRAINT "users_sms_opted_out_blocks_sms_enabled" CHECK ((NOT ("sms_opted_out" AND "sms_notifications_enabled"))),
    CONSTRAINT "users_timezone_no_whitespace" CHECK ("public"."has_no_whitespace"("timezone"))
);


ALTER TABLE "public"."users" OWNER TO "postgres";


COMMENT ON COLUMN "public"."users"."price_move_alerts_include_email" IS 'Send 5% flat price move alerts over email. Requires email_notifications_enabled.';



COMMENT ON COLUMN "public"."users"."price_move_alerts_include_sms" IS 'Send 5% flat price move alerts over SMS. Requires phone_verified + sms_notifications_enabled and not sms_opted_out.';



ALTER TABLE ONLY "public"."app_metadata"
    ADD CONSTRAINT "app_metadata_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."asset_events"
    ADD CONSTRAINT "asset_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."asset_events"
    ADD CONSTRAINT "asset_events_symbol_event_type_event_date_week_of_key" UNIQUE ("symbol", "event_type", "event_date", "week_of");



ALTER TABLE ONLY "public"."asset_snapshots"
    ADD CONSTRAINT "asset_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."assets"
    ADD CONSTRAINT "assets_pkey" PRIMARY KEY ("symbol");



ALTER TABLE ONLY "public"."daily_asset_stats"
    ADD CONSTRAINT "daily_asset_stats_pkey" PRIMARY KEY ("symbol");



ALTER TABLE ONLY "public"."market_asset_price_alert_cooldowns"
    ADD CONSTRAINT "instant_alert_cooldowns_pkey" PRIMARY KEY ("user_id", "symbol");



ALTER TABLE ONLY "public"."market_events"
    ADD CONSTRAINT "market_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_log"
    ADD CONSTRAINT "notification_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."price_move_alert_state"
    ADD CONSTRAINT "price_move_alert_state_pkey" PRIMARY KEY ("user_id", "symbol");



ALTER TABLE ONLY "public"."price_targets"
    ADD CONSTRAINT "price_targets_pkey" PRIMARY KEY ("user_id", "symbol");



ALTER TABLE ONLY "public"."rate_limit_log"
    ADD CONSTRAINT "rate_limit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scheduled_notifications"
    ADD CONSTRAINT "scheduled_notifications_pkey" PRIMARY KEY ("user_id", "notification_type", "scheduled_date", "scheduled_minutes", "channel");



ALTER TABLE ONLY "public"."short_urls"
    ADD CONSTRAINT "short_urls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."staged_notifications"
    ADD CONSTRAINT "staged_notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."staged_notifications"
    ADD CONSTRAINT "staged_notifications_user_id_notification_type_scheduled_fo_key" UNIQUE ("user_id", "notification_type", "scheduled_for");



ALTER TABLE ONLY "public"."timezones"
    ADD CONSTRAINT "timezones_pkey" PRIMARY KEY ("value");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "unique_phone" UNIQUE ("phone_country_code", "phone_number");



ALTER TABLE ONLY "public"."user_assets"
    ADD CONSTRAINT "user_assets_pkey" PRIMARY KEY ("user_id", "symbol");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "asset_events_symbol_type_date_idx" ON "public"."asset_events" USING "btree" ("symbol", "event_type", "event_date");



CREATE INDEX "idx_asset_events_week_of" ON "public"."asset_events" USING "btree" ("week_of");



CREATE INDEX "idx_asset_snapshots_captured_at" ON "public"."asset_snapshots" USING "btree" ("captured_at");



CREATE INDEX "idx_asset_snapshots_symbol_captured" ON "public"."asset_snapshots" USING "btree" ("symbol", "captured_at" DESC);



CREATE INDEX "idx_assets_delisted_at" ON "public"."assets" USING "btree" ("delisted_at") WHERE ("delisted_at" IS NOT NULL);



CREATE INDEX "idx_assets_name_trgm" ON "public"."assets" USING "gin" ("name" "public"."gin_trgm_ops");



CREATE INDEX "idx_assets_symbol_trgm" ON "public"."assets" USING "gin" ("symbol" "public"."gin_trgm_ops");



CREATE INDEX "idx_daily_asset_stats_computed" ON "public"."daily_asset_stats" USING "btree" ("computed_at");



CREATE INDEX "idx_market_events_type_date" ON "public"."market_events" USING "btree" ("event_type", "event_date");



CREATE UNIQUE INDEX "idx_market_events_type_symbol_date" ON "public"."market_events" USING "btree" ("event_type", "symbol", "event_date") NULLS NOT DISTINCT;



CREATE INDEX "idx_market_events_week_of" ON "public"."market_events" USING "btree" ("week_of");



CREATE INDEX "idx_price_move_alert_state_user" ON "public"."price_move_alert_state" USING "btree" ("user_id");



CREATE INDEX "idx_rate_limit_log_user_endpoint_created" ON "public"."rate_limit_log" USING "btree" ("user_id", "endpoint", "created_at" DESC);



CREATE INDEX "idx_short_urls_expires_at" ON "public"."short_urls" USING "btree" ("expires_at");



CREATE INDEX "idx_short_urls_original_url" ON "public"."short_urls" USING "btree" ("original_url");



CREATE INDEX "idx_staged_notifications_delivery" ON "public"."staged_notifications" USING "btree" ("scheduled_for");



CREATE INDEX "idx_user_assets_symbol" ON "public"."user_assets" USING "btree" ("symbol");



CREATE INDEX "idx_users_asset_events_next_send_at" ON "public"."users" USING "btree" ("asset_events_next_send_at") WHERE ("asset_events_next_send_at" IS NOT NULL);



CREATE INDEX "idx_users_daily_digest_next_send_at" ON "public"."users" USING "btree" ("daily_digest_next_send_at") WHERE (("daily_digest_time" IS NOT NULL) AND ("daily_digest_next_send_at" IS NOT NULL));



CREATE INDEX "idx_users_market_scheduled_asset_price_next_send_at" ON "public"."users" USING "btree" ("market_scheduled_asset_price_next_send_at") WHERE (("market_scheduled_asset_price_enabled" = true) AND ("market_scheduled_asset_price_next_send_at" IS NOT NULL));



CREATE OR REPLACE TRIGGER "update_notification_log_updated_at" BEFORE UPDATE ON "public"."notification_log" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_scheduled_notifications_updated_at" BEFORE UPDATE ON "public"."scheduled_notifications" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_users_updated_at" BEFORE UPDATE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



ALTER TABLE ONLY "public"."asset_events"
    ADD CONSTRAINT "asset_events_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "public"."assets"("symbol") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."asset_snapshots"
    ADD CONSTRAINT "asset_snapshots_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "public"."assets"("symbol") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."market_asset_price_alert_cooldowns"
    ADD CONSTRAINT "instant_alert_cooldowns_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."market_asset_price_alert_cooldowns"
    ADD CONSTRAINT "market_asset_price_alert_cooldowns_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "public"."assets"("symbol") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_log"
    ADD CONSTRAINT "notification_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."price_move_alert_state"
    ADD CONSTRAINT "price_move_alert_state_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "public"."assets"("symbol") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."price_move_alert_state"
    ADD CONSTRAINT "price_move_alert_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."price_targets"
    ADD CONSTRAINT "price_targets_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "public"."assets"("symbol") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."price_targets"
    ADD CONSTRAINT "price_targets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rate_limit_log"
    ADD CONSTRAINT "rate_limit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scheduled_notifications"
    ADD CONSTRAINT "scheduled_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."staged_notifications"
    ADD CONSTRAINT "staged_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_assets"
    ADD CONSTRAINT "user_assets_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "public"."assets"("symbol") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_assets"
    ADD CONSTRAINT "user_assets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_timezone_fkey" FOREIGN KEY ("timezone") REFERENCES "public"."timezones"("value");



CREATE POLICY "Anyone can view assets" ON "public"."assets" FOR SELECT USING (true);



CREATE POLICY "Timezones are readable by anyone" ON "public"."timezones" FOR SELECT USING (true);



CREATE POLICY "Users can delete own assets" ON "public"."user_assets" FOR DELETE USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "Users can delete own profile" ON "public"."users" FOR DELETE USING ((( SELECT "auth"."uid"() AS "uid") = "id"));



CREATE POLICY "Users can delete their own price targets" ON "public"."price_targets" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own assets" ON "public"."user_assets" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "Users can insert own profile" ON "public"."users" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "id"));



CREATE POLICY "Users can insert their own price targets" ON "public"."price_targets" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own rate limit records" ON "public"."rate_limit_log" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id")) WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "Users can update own profile" ON "public"."users" FOR UPDATE USING ((( SELECT "auth"."uid"() AS "uid") = "id")) WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "id"));



CREATE POLICY "Users can update their own price targets" ON "public"."price_targets" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own assets" ON "public"."user_assets" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "Users can view own notifications" ON "public"."notification_log" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "Users can view own profile" ON "public"."users" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "id"));



CREATE POLICY "Users can view their own price targets" ON "public"."price_targets" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users delete their own flat price alert state" ON "public"."price_move_alert_state" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users view their own flat price alert state" ON "public"."price_move_alert_state" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."app_metadata" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."asset_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."asset_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."assets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."market_asset_price_alert_cooldowns" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."market_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."price_move_alert_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."price_targets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rate_limit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scheduled_notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."short_urls" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."staged_notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."timezones" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_assets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";





GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "service_role";































































































































































GRANT ALL ON FUNCTION "public"."check_rate_limit"("p_user_id" "uuid", "p_endpoint" "text", "p_max_requests" integer, "p_window_minutes" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."check_rate_limit"("p_user_id" "uuid", "p_endpoint" "text", "p_max_requests" integer, "p_window_minutes" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_rate_limit"("p_user_id" "uuid", "p_endpoint" "text", "p_max_requests" integer, "p_window_minutes" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_flat_price_alert"("p_user_id" "uuid", "p_symbol" "text", "p_baseline_price" numeric, "p_new_price" numeric, "p_threshold_percent" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."claim_flat_price_alert"("p_user_id" "uuid", "p_symbol" "text", "p_baseline_price" numeric, "p_new_price" numeric, "p_threshold_percent" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_flat_price_alert"("p_user_id" "uuid", "p_symbol" "text", "p_baseline_price" numeric, "p_new_price" numeric, "p_threshold_percent" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_market_asset_price_alert_slot"("p_user_id" "uuid", "p_symbol" "text", "p_abs_move_percent" numeric, "p_abs_move_dollar" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."claim_market_asset_price_alert_slot"("p_user_id" "uuid", "p_symbol" "text", "p_abs_move_percent" numeric, "p_abs_move_dollar" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_market_asset_price_alert_slot"("p_user_id" "uuid", "p_symbol" "text", "p_abs_move_percent" numeric, "p_abs_move_dollar" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_market_asset_price_alert_trading_day"("p_user_id" "uuid", "p_symbol" "text", "p_observed_at" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."claim_market_asset_price_alert_trading_day"("p_user_id" "uuid", "p_symbol" "text", "p_observed_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_market_asset_price_alert_trading_day"("p_user_id" "uuid", "p_symbol" "text", "p_observed_at" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_scheduled_notification"("p_user_id" "uuid", "p_notification_type" "public"."scheduled_notification_type", "p_scheduled_date" "date", "p_scheduled_minutes" integer, "p_channel" "public"."delivery_method") TO "anon";
GRANT ALL ON FUNCTION "public"."claim_scheduled_notification"("p_user_id" "uuid", "p_notification_type" "public"."scheduled_notification_type", "p_scheduled_date" "date", "p_scheduled_minutes" integer, "p_channel" "public"."delivery_method") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_scheduled_notification"("p_user_id" "uuid", "p_notification_type" "public"."scheduled_notification_type", "p_scheduled_date" "date", "p_scheduled_minutes" integer, "p_channel" "public"."delivery_method") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_auth_user_deleted"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_auth_user_deleted"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_auth_user_deleted"() TO "service_role";



GRANT ALL ON FUNCTION "public"."has_no_whitespace"("value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."has_no_whitespace"("value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_no_whitespace"("value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_valid_market_scheduled_asset_price_times"("times" integer[]) TO "anon";
GRANT ALL ON FUNCTION "public"."is_valid_market_scheduled_asset_price_times"("times" integer[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_valid_market_scheduled_asset_price_times"("times" integer[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."purge_expired_short_urls"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."purge_expired_short_urls"() TO "anon";
GRANT ALL ON FUNCTION "public"."purge_expired_short_urls"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."purge_expired_short_urls"() TO "service_role";



GRANT ALL ON FUNCTION "public"."purge_old_asset_snapshots"("p_retention_minutes" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."purge_old_asset_snapshots"("p_retention_minutes" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."purge_old_asset_snapshots"("p_retention_minutes" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."replace_user_assets"("user_id" "uuid", "symbols" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."replace_user_assets"("user_id" "uuid", "symbols" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace_user_assets"("user_id" "uuid", "symbols" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."reserve_sms_verification"("p_user_id" "uuid", "p_phone_country_code" "text", "p_phone_number" "text", "p_cooldown_ms" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."reserve_sms_verification"("p_user_id" "uuid", "p_phone_country_code" "text", "p_phone_number" "text", "p_cooldown_ms" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."reserve_sms_verification"("p_user_id" "uuid", "p_phone_country_code" "text", "p_phone_number" "text", "p_cooldown_ms" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."rollback_sms_verification_reservation"("p_user_id" "uuid", "p_expected_verification_sent_at" timestamp with time zone, "p_restore_verification_sent_at" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."rollback_sms_verification_reservation"("p_user_id" "uuid", "p_expected_verification_sent_at" timestamp with time zone, "p_restore_verification_sent_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."rollback_sms_verification_reservation"("p_user_id" "uuid", "p_expected_verification_sent_at" timestamp with time zone, "p_restore_verification_sent_at" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "postgres";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "anon";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "service_role";



GRANT ALL ON FUNCTION "public"."show_limit"() TO "postgres";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "service_role";



GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "postgres";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "anon";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "service_role";


















GRANT ALL ON TABLE "public"."app_metadata" TO "service_role";



GRANT ALL ON TABLE "public"."asset_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."asset_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."asset_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."asset_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."asset_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."assets" TO "anon";
GRANT ALL ON TABLE "public"."assets" TO "authenticated";
GRANT ALL ON TABLE "public"."assets" TO "service_role";



GRANT ALL ON TABLE "public"."daily_asset_stats" TO "anon";
GRANT ALL ON TABLE "public"."daily_asset_stats" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_asset_stats" TO "service_role";



GRANT ALL ON TABLE "public"."market_asset_price_alert_cooldowns" TO "service_role";



GRANT ALL ON TABLE "public"."market_events" TO "anon";
GRANT ALL ON TABLE "public"."market_events" TO "authenticated";
GRANT ALL ON TABLE "public"."market_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."market_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."market_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."market_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."notification_log" TO "anon";
GRANT ALL ON TABLE "public"."notification_log" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_log" TO "service_role";



GRANT ALL ON TABLE "public"."price_move_alert_state" TO "anon";
GRANT ALL ON TABLE "public"."price_move_alert_state" TO "authenticated";
GRANT ALL ON TABLE "public"."price_move_alert_state" TO "service_role";



GRANT ALL ON TABLE "public"."price_targets" TO "anon";
GRANT ALL ON TABLE "public"."price_targets" TO "authenticated";
GRANT ALL ON TABLE "public"."price_targets" TO "service_role";



GRANT ALL ON TABLE "public"."rate_limit_log" TO "anon";
GRANT ALL ON TABLE "public"."rate_limit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."rate_limit_log" TO "service_role";



GRANT ALL ON TABLE "public"."scheduled_notifications" TO "service_role";



GRANT ALL ON TABLE "public"."short_urls" TO "service_role";



GRANT ALL ON TABLE "public"."staged_notifications" TO "service_role";



GRANT ALL ON TABLE "public"."timezones" TO "anon";
GRANT ALL ON TABLE "public"."timezones" TO "authenticated";
GRANT ALL ON TABLE "public"."timezones" TO "service_role";



GRANT ALL ON TABLE "public"."user_assets" TO "anon";
GRANT ALL ON TABLE "public"."user_assets" TO "authenticated";
GRANT ALL ON TABLE "public"."user_assets" TO "service_role";



GRANT ALL ON TABLE "public"."users" TO "anon";
GRANT ALL ON TABLE "public"."users" TO "authenticated";
GRANT ALL ON TABLE "public"."users" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";
































--
-- Dumped schema changes for auth and storage
--

CREATE OR REPLACE TRIGGER "on_auth_user_deleted" AFTER DELETE ON "auth"."users" FOR EACH ROW EXECUTE FUNCTION "public"."handle_auth_user_deleted"();




-- Baseline data (timezones, app_metadata, market_events) carried over from pre-squash migrations.

INSERT INTO public.app_metadata (key, value) VALUES ('market_times_storage', 'et_minutes');
INSERT INTO public.app_metadata (key, value) VALUES ('schema_version', '20260509161208_migrate_market_times_to_et');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (54, 'ipo', 'MRCOU', '2026-04-13', '2026-04-13', '{"issuerName": "Mercator Acquisition Corp.", "securityType": "SP"}', '2026-04-14 00:00:18.261191+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (177, 'ipo', 'COAG', '2026-05-01', '2026-04-27', '{"issuerName": "Hemab Therapeutics Holdings Inc.", "securityType": "CS"}', '2026-05-02 00:00:06.033797+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (65, 'ipo', 'MRCOU', '2026-04-16', '2026-04-13', '{"issuerName": "Mercator Acquisition Corp.", "securityType": "SP"}', '2026-04-16 00:01:27.417635+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (86, 'ipo', 'XE', '2026-04-24', '2026-04-20', '{"issuerName": "X-Energy Inc.", "securityType": "CS"}', '2026-04-18 00:00:34.261445+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (126, 'ipo', 'LABT', '2026-04-23', '2026-04-20', '{"issuerName": "Lakewood-Amedex Biotherapeutics Inc.", "securityType": "CS"}', '2026-04-24 00:00:05.867828+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (67, 'ipo', 'ELMT', '2026-04-23', '2026-04-20', '{"issuerName": "Elmet Group Co. The", "securityType": "CS"}', '2026-04-16 00:02:51.644599+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (120, 'ipo', 'NHP', '2026-04-22', '2026-04-20', '{"issuerName": "National Healthcare Properties Inc.", "securityType": "CS"}', '2026-04-23 00:00:05.619937+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (61, 'ipo', 'YSWY', '2026-04-22', '2026-04-20', '{"issuerName": "Yesway Inc", "securityType": "CS"}', '2026-04-15 00:00:31.570968+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (60, 'ipo', 'EMI', '2026-04-22', '2026-04-20', '{"issuerName": "Encore Medical Inc.", "securityType": "CS"}', '2026-04-15 00:00:31.570968+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (178, 'ipo', 'SPTX', '2026-05-01', '2026-04-27', '{"issuerName": "Seaport Therapeutics Inc.", "securityType": "CS"}', '2026-05-02 00:00:06.033797+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (179, 'ipo', 'QLEPU', '2026-05-01', '2026-04-27', '{"issuerName": "Quantum Leap Acquisition Corp", "securityType": "SP"}', '2026-05-02 00:00:06.033797+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (164, 'ipo', 'AVLN', '2026-04-30', '2026-04-27', '{"issuerName": "Avalyn Pharma Inc.", "securityType": "CS"}', '2026-05-01 00:00:06.632639+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (105, 'ipo', 'BWGC', '2026-04-28', '2026-04-27', '{"issuerName": "BW Industrial Holdings Inc.", "securityType": "CS"}', '2026-04-20 00:00:06.774055+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (167, 'ipo', 'GCGRU', '2026-04-30', '2026-04-27', '{"issuerName": "General Catalyst Global Resilience Merger Corp.", "securityType": "SP"}', '2026-05-01 00:00:06.632639+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (217, 'ipo', 'RIKU', '2026-05-15', '2026-05-11', '{"issuerName": "Riku Dining Group Ltd.", "securityType": "CS"}', '2026-05-04 00:00:07.19475+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (36, 'ipo', 'EMI', '2026-04-15', '2026-04-13', '{"issuerName": "Encore Medical Inc.", "securityType": "CS"}', '2026-04-07 00:00:23.543044+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (53, 'ipo', 'MYXXU', '2026-04-14', '2026-04-13', '{"issuerName": "Maywood Acquisition Corp. 2", "securityType": "SP"}', '2026-04-14 00:00:18.261191+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (138, 'ipo', 'SBMT', '2026-04-29', '2026-04-27', '{"issuerName": "Silver Bow Mining Corp.", "securityType": "CS"}', '2026-04-25 00:00:07.019064+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (152, 'ipo', 'MCAHU', '2026-04-30', '2026-04-27', '{"issuerName": "Mountain Crest Acquisition 6 Corp.", "securityType": "SP"}', '2026-04-29 00:00:05.412676+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (79, 'ipo', 'JATT', '2026-04-17', '2026-04-13', '{"issuerName": "Jatt II Acquisition Corp.", "securityType": "CS"}', '2026-04-18 00:00:21.910407+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (55, 'ipo', 'ALMR', '2026-04-17', '2026-04-13', '{"issuerName": "Alamar Biosciences Inc.", "securityType": "CS"}', '2026-04-15 00:00:19.810347+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (51, 'ipo', 'AVEX', '2026-04-17', '2026-04-13', '{"issuerName": "AEVEX Corp.", "securityType": "CS"}', '2026-04-14 00:00:18.261191+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (56, 'ipo', 'KLRA', '2026-04-17', '2026-04-13', '{"issuerName": "Kailera Therapeutics Inc.", "securityType": "CS"}', '2026-04-15 00:00:19.810347+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (73, 'ipo', 'MAIR', '2026-04-16', '2026-04-13', '{"issuerName": "Madison Air Solutions Corp.", "securityType": "CS"}', '2026-04-17 00:00:18.590646+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (74, 'ipo', 'ARXS', '2026-04-16', '2026-04-13', '{"issuerName": "Arxis Inc.", "securityType": "CS"}', '2026-04-17 00:00:18.590646+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (58, 'ipo', 'NHIVU', '2026-04-14', '2026-04-13', '{"issuerName": "NewHold Investment Corp IV", "securityType": "SP"}', '2026-04-15 00:00:19.810347+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (115, 'ipo', 'MRCOU', '2026-04-21', '2026-04-20', '{"issuerName": "Mercator Acquisition Corp.", "securityType": "SP"}', '2026-04-22 00:00:05.482335+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (232, 'ipo', 'BXDC', '2026-05-14', '2026-05-11', '{"issuerName": "Blackstone Digital Infrastructure Trust Inc.", "securityType": "CS"}', '2026-05-06 00:00:08.26821+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (263, 'ipo', 'BREZU', '2026-05-08', '2026-05-04', '{"issuerName": "Breeze Acquisition Corp II", "securityType": "SP"}', '2026-05-09 00:00:05.981412+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (224, 'ipo', 'ODTX', '2026-05-08', '2026-05-04', '{"issuerName": "Odyssey Therapeutics Inc", "securityType": "CS"}', '2026-05-06 00:00:06.573342+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (222, 'ipo', 'SKAIU', '2026-05-05', '2026-05-04', '{"issuerName": "Sky Acquisition Group", "securityType": "SP"}', '2026-05-05 00:01:27.606539+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (176, 'ipo', 'MTNEU', '2026-05-01', '2026-04-27', '{"issuerName": "CH4 Natural Solutions Corp", "securityType": "SP"}', '2026-05-02 00:00:06.033797+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (165, 'ipo', 'RREVU', '2026-04-30', '2026-04-27', '{"issuerName": "RRE Ventures Acquisition Corp.", "securityType": "SP"}', '2026-05-01 00:00:06.632639+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (169, 'ipo', 'WENCU', '2026-04-30', '2026-04-27', '{"issuerName": "West Enclave Merger Corp.", "securityType": "SP"}', '2026-05-01 00:00:06.632639+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (168, 'ipo', 'SBMT', '2026-04-30', '2026-04-27', '{"issuerName": "Silver Bow Mining Corp.", "securityType": "CS"}', '2026-05-01 00:00:06.632639+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (170, 'ipo', 'FTHAU', '2026-04-30', '2026-04-27', '{"issuerName": "Forefront Tech Holdings Acquisition Corp", "securityType": "SP"}', '2026-05-01 00:00:06.632639+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (159, 'ipo', 'PSUS', '2026-04-29', '2026-04-27', '{"issuerName": "Pershing Square USA Ltd.", "securityType": "CS"}', '2026-04-30 00:00:05.974076+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (160, 'ipo', 'CAIIU', '2026-04-29', '2026-04-27', '{"issuerName": "Collective Acquisition Corp II", "securityType": "SP"}', '2026-04-30 00:00:05.974076+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (156, 'ipo', 'IACQU', '2026-04-28', '2026-04-27', '{"issuerName": "Irenic Acquisition Corp.", "securityType": "SP"}', '2026-04-29 00:00:05.412676+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (155, 'ipo', 'CXIIU', '2026-04-28', '2026-04-27', '{"issuerName": "Churchill Capital Corp XII", "securityType": "SP"}', '2026-04-29 00:00:05.412676+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (154, 'ipo', 'PLUNU', '2026-04-28', '2026-04-27', '{"issuerName": "Plutonian Acquisition Corp. II", "securityType": "SP"}', '2026-04-29 00:00:05.412676+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (265, 'ipo', 'OTAIU', '2026-05-08', '2026-05-04', '{"issuerName": "Starlink AI Acquisition Corp.", "securityType": "SP"}', '2026-05-09 00:00:05.981412+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (225, 'ipo', 'MOBI', '2026-05-08', '2026-05-04', '{"issuerName": "Mobia Medical Inc.", "securityType": "CS"}', '2026-05-06 00:00:06.573342+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (193, 'ipo', 'SUJA', '2026-05-07', '2026-05-04', '{"issuerName": "Suja Life Inc.", "securityType": "CS"}', '2026-05-02 00:00:07.203417+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (192, 'ipo', 'HAWK', '2026-05-07', '2026-05-04', '{"issuerName": "HawkEye 360 Inc.", "securityType": "CS"}', '2026-05-02 00:00:07.203417+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (233, 'ipo', 'CBRS', '2026-05-14', '2026-05-11', '{"issuerName": "Cerebras Systems Inc", "securityType": "CS"}', '2026-05-06 00:00:08.26821+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (231, 'ipo', 'EROK', '2026-05-14', '2026-05-11', '{"issuerName": "EagleRock Land LLC", "securityType": "CS"}', '2026-05-06 00:00:08.26821+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (235, 'ipo', 'GMRS', '2026-05-13', '2026-05-11', '{"issuerName": "GMR Solutions Inc.", "securityType": "CS"}', '2026-05-06 00:00:08.26821+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (234, 'ipo', 'FRVO', '2026-05-13', '2026-05-11', '{"issuerName": "Fervo Energy Co.", "securityType": "CS"}', '2026-05-06 00:00:08.26821+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (262, 'ipo', 'BOT', '2026-05-11', '2026-05-11', '{"issuerName": "RoboStrategy Inc", "securityType": "CS"}', '2026-05-08 00:00:08.861834+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (238, 'ipo', 'SAGUU', '2026-05-07', '2026-05-04', '{"issuerName": "Shreya Acquisition Group", "securityType": "SP"}', '2026-05-07 00:00:07.201915+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (194, 'ipo', 'REA', '2026-05-06', '2026-05-04', '{"issuerName": "Rare Earths Americas Inc.", "securityType": "CS"}', '2026-05-02 00:00:07.203417+00');
INSERT INTO public.market_events (id, event_type, symbol, event_date, week_of, data, fetched_at) VALUES (220, 'ipo', 'VECAU', '2026-05-06', '2026-05-04', '{"issuerName": "Vernal Capital Acquisition Corp", "securityType": "SP"}', '2026-05-05 00:01:27.606539+00');
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('GB-Eire', 'GB-Eire', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('NZ', 'NZ', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Canada/Mountain', 'Canada/Mountain', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Canada/Eastern', 'Canada/Eastern', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Canada/Central', 'Canada/Central', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Canada/Newfoundland', 'Canada/Newfoundland', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Canada/Atlantic', 'Canada/Atlantic', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Canada/Saskatchewan', 'Canada/Saskatchewan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Canada/Yukon', 'Canada/Yukon', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Canada/Pacific', 'Canada/Pacific', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Indian/Mauritius', 'Indian/Mauritius', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Indian/Maldives', 'Indian/Maldives', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Indian/Kerguelen', 'Indian/Kerguelen', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Indian/Antananarivo', 'Indian/Antananarivo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Indian/Christmas', 'Indian/Christmas', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Indian/Mahe', 'Indian/Mahe', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Indian/Chagos', 'Indian/Chagos', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Indian/Reunion', 'Indian/Reunion', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Indian/Cocos', 'Indian/Cocos', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Indian/Mayotte', 'Indian/Mayotte', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Indian/Comoro', 'Indian/Comoro', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('EET', 'EET', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Iran', 'Iran', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('GMT-0', 'GMT-0', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('UTC', 'UTC', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Jamaica', 'Jamaica', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT+2', 'Etc/GMT+2', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT-0', 'Etc/GMT-0', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/UTC', 'Etc/UTC', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT-5', 'Etc/GMT-5', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT-9', 'Etc/GMT-9', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT+1', 'Etc/GMT+1', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT-2', 'Etc/GMT-2', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT+0', 'Etc/GMT+0', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT+6', 'Etc/GMT+6', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT-1', 'Etc/GMT-1', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT-14', 'Etc/GMT-14', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/Greenwich', 'Etc/Greenwich', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT+3', 'Etc/GMT+3', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT+5', 'Etc/GMT+5', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT+11', 'Etc/GMT+11', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT+12', 'Etc/GMT+12', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT-6', 'Etc/GMT-6', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT-10', 'Etc/GMT-10', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT-13', 'Etc/GMT-13', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT-7', 'Etc/GMT-7', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT-12', 'Etc/GMT-12', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/Universal', 'Etc/Universal', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/UCT', 'Etc/UCT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT', 'Etc/GMT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT+8', 'Etc/GMT+8', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT+4', 'Etc/GMT+4', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT+9', 'Etc/GMT+9', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/Zulu', 'Etc/Zulu', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT+10', 'Etc/GMT+10', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT+7', 'Etc/GMT+7', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT-3', 'Etc/GMT-3', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT-11', 'Etc/GMT-11', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT-8', 'Etc/GMT-8', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT0', 'Etc/GMT0', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Etc/GMT-4', 'Etc/GMT-4', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('US/Samoa', 'US/Samoa', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('US/Mountain', 'US/Mountain', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('US/East-Indiana', 'US/East-Indiana', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('US/Eastern', 'US/Eastern', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('US/Hawaii', 'US/Hawaii', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('US/Central', 'US/Central', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('US/Alaska', 'US/Alaska', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('US/Indiana-Starke', 'US/Indiana-Starke', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('US/Michigan', 'US/Michigan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('US/Pacific', 'US/Pacific', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('US/Arizona', 'US/Arizona', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('US/Aleutian', 'US/Aleutian', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Poland', 'Poland', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Niamey', 'Africa/Niamey', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Bamako', 'Africa/Bamako', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Freetown', 'Africa/Freetown', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Brazzaville', 'Africa/Brazzaville', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Ceuta', 'Africa/Ceuta', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Algiers', 'Africa/Algiers', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Windhoek', 'Africa/Windhoek', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Timbuktu', 'Africa/Timbuktu', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Khartoum', 'Africa/Khartoum', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Porto-Novo', 'Africa/Porto-Novo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Tripoli', 'Africa/Tripoli', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Maseru', 'Africa/Maseru', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Kigali', 'Africa/Kigali', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Kampala', 'Africa/Kampala', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Banjul', 'Africa/Banjul', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Douala', 'Africa/Douala', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Sao_Tome', 'Africa/Sao_Tome', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Gaborone', 'Africa/Gaborone', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Lome', 'Africa/Lome', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Djibouti', 'Africa/Djibouti', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Lubumbashi', 'Africa/Lubumbashi', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Juba', 'Africa/Juba', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Dakar', 'Africa/Dakar', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Mogadishu', 'Africa/Mogadishu', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Mbabane', 'Africa/Mbabane', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Dar_es_Salaam', 'Africa/Dar_es_Salaam', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Ouagadougou', 'Africa/Ouagadougou', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Conakry', 'Africa/Conakry', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Malabo', 'Africa/Malabo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Monrovia', 'Africa/Monrovia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Harare', 'Africa/Harare', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Kinshasa', 'Africa/Kinshasa', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Libreville', 'Africa/Libreville', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Tunis', 'Africa/Tunis', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Bujumbura', 'Africa/Bujumbura', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Bangui', 'Africa/Bangui', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Bissau', 'Africa/Bissau', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Maputo', 'Africa/Maputo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Lusaka', 'Africa/Lusaka', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Accra', 'Africa/Accra', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/El_Aaiun', 'Africa/El_Aaiun', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Ndjamena', 'Africa/Ndjamena', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Asmara', 'Africa/Asmara', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Blantyre', 'Africa/Blantyre', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Asmera', 'Africa/Asmera', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Abidjan', 'Africa/Abidjan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Luanda', 'Africa/Luanda', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Addis_Ababa', 'Africa/Addis_Ababa', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Nouakchott', 'Africa/Nouakchott', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Chile/EasterIsland', 'Chile/EasterIsland', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Chile/Continental', 'Chile/Continental', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Eire', 'Eire', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('GMT+0', 'GMT+0', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('WET', 'WET', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('CST6CDT', 'CST6CDT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('HST', 'HST', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Portugal', 'Portugal', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Mexico/BajaNorte', 'Mexico/BajaNorte', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Mexico/General', 'Mexico/General', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Mexico/BajaSur', 'Mexico/BajaSur', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Greenwich', 'Greenwich', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Egypt', 'Egypt', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('CET', 'CET', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Japan', 'Japan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Atlantic/Reykjavik', 'Atlantic/Reykjavik', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Atlantic/Madeira', 'Atlantic/Madeira', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Atlantic/Faroe', 'Atlantic/Faroe', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Atlantic/St_Helena', 'Atlantic/St_Helena', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Atlantic/Stanley', 'Atlantic/Stanley', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Atlantic/Faeroe', 'Atlantic/Faeroe', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Atlantic/Azores', 'Atlantic/Azores', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Atlantic/South_Georgia', 'Atlantic/South_Georgia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Atlantic/Cape_Verde', 'Atlantic/Cape_Verde', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Atlantic/Jan_Mayen', 'Atlantic/Jan_Mayen', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Atlantic/Canary', 'Atlantic/Canary', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Atlantic/Bermuda', 'Atlantic/Bermuda', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Kwajalein', 'Kwajalein', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('PST8PDT', 'PST8PDT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/Hobart', 'Australia/Hobart', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/Queensland', 'Australia/Queensland', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/Lindeman', 'Australia/Lindeman', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/Currie', 'Australia/Currie', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/Yancowinna', 'Australia/Yancowinna', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/North', 'Australia/North', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/Tasmania', 'Australia/Tasmania', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/ACT', 'Australia/ACT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/South', 'Australia/South', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/LHI', 'Australia/LHI', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/Victoria', 'Australia/Victoria', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/Canberra', 'Australia/Canberra', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/Eucla', 'Australia/Eucla', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/West', 'Australia/West', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/Lord_Howe', 'Australia/Lord_Howe', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/Broken_Hill', 'Australia/Broken_Hill', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/NSW', 'Australia/NSW', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('MET', 'MET', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('GB', 'GB', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Turkey', 'Turkey', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('MST7MDT', 'MST7MDT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Libya', 'Libya', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Hongkong', 'Hongkong', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Yekaterinburg', 'Asia/Yekaterinburg', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Choibalsan', 'Asia/Choibalsan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Pyongyang', 'Asia/Pyongyang', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Oral', 'Asia/Oral', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Jerusalem', 'Asia/Jerusalem', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Thimbu', 'Asia/Thimbu', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Irkutsk', 'Asia/Irkutsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Amman', 'Asia/Amman', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Kashgar', 'Asia/Kashgar', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Novokuznetsk', 'Asia/Novokuznetsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Gaza', 'Asia/Gaza', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Krasnoyarsk', 'Asia/Krasnoyarsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Beirut', 'Asia/Beirut', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Nicosia', 'Asia/Nicosia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Dili', 'Asia/Dili', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Saigon', 'Asia/Saigon', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Chongqing', 'Asia/Chongqing', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Makassar', 'Asia/Makassar', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Jayapura', 'Asia/Jayapura', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Ashgabat', 'Asia/Ashgabat', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Urumqi', 'Asia/Urumqi', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Anadyr', 'Asia/Anadyr', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Baku', 'Asia/Baku', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Dushanbe', 'Asia/Dushanbe', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Tomsk', 'Asia/Tomsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Chita', 'Asia/Chita', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Bahrain', 'Asia/Bahrain', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Ulaanbaatar', 'Asia/Ulaanbaatar', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Calcutta', 'Asia/Calcutta', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Yakutsk', 'Asia/Yakutsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Qostanay', 'Asia/Qostanay', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Barnaul', 'Asia/Barnaul', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Kabul', 'Asia/Kabul', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Chungking', 'Asia/Chungking', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Atyrau', 'Asia/Atyrau', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Vientiane', 'Asia/Vientiane', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Dacca', 'Asia/Dacca', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Sakhalin', 'Asia/Sakhalin', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Pontianak', 'Asia/Pontianak', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Famagusta', 'Asia/Famagusta', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Istanbul', 'Asia/Istanbul', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Aqtau', 'Asia/Aqtau', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Novosibirsk', 'Asia/Novosibirsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Ujung_Pandang', 'Asia/Ujung_Pandang', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Rangoon', 'Asia/Rangoon', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Yerevan', 'Asia/Yerevan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Ashkhabad', 'Asia/Ashkhabad', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Hebron', 'Asia/Hebron', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Katmandu', 'Asia/Katmandu', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Kuching', 'Asia/Kuching', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Magadan', 'Asia/Magadan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Macau', 'Asia/Macau', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Aden', 'Asia/Aden', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Tashkent', 'Asia/Tashkent', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Harbin', 'Asia/Harbin', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Ust-Nera', 'Asia/Ust-Nera', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Bishkek', 'Asia/Bishkek', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Samarkand', 'Asia/Samarkand', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Khandyga', 'Asia/Khandyga', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Macao', 'Asia/Macao', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Tel_Aviv', 'Asia/Tel_Aviv', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Ulan_Bator', 'Asia/Ulan_Bator', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Hovd', 'Asia/Hovd', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Brunei', 'Asia/Brunei', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Tbilisi', 'Asia/Tbilisi', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Kamchatka', 'Asia/Kamchatka', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Srednekolymsk', 'Asia/Srednekolymsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Muscat', 'Asia/Muscat', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Qyzylorda', 'Asia/Qyzylorda', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Almaty', 'Asia/Almaty', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Damascus', 'Asia/Damascus', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Qatar', 'Asia/Qatar', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Omsk', 'Asia/Omsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Aqtobe', 'Asia/Aqtobe', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Thimphu', 'Asia/Thimphu', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Vladivostok', 'Asia/Vladivostok', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Cuba', 'Cuba', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Singapore', 'Singapore', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Universal', 'Universal', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('UCT', 'UCT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('NZ-CHAT', 'NZ-CHAT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Noumea', 'Pacific/Noumea', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Tarawa', 'Pacific/Tarawa', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Samoa', 'Pacific/Samoa', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Pago_Pago', 'Pacific/Pago_Pago', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Chuuk', 'Pacific/Chuuk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Easter', 'Pacific/Easter', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Kosrae', 'Pacific/Kosrae', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Galapagos', 'Pacific/Galapagos', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Efate', 'Pacific/Efate', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Kanton', 'Pacific/Kanton', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Kiritimati', 'Pacific/Kiritimati', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Enderbury', 'Pacific/Enderbury', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Fakaofo', 'Pacific/Fakaofo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Gambier', 'Pacific/Gambier', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Apia', 'Pacific/Apia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Marquesas', 'Pacific/Marquesas', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Chatham', 'Pacific/Chatham', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Kwajalein', 'Pacific/Kwajalein', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Tongatapu', 'Pacific/Tongatapu', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Guadalcanal', 'Pacific/Guadalcanal', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Midway', 'Pacific/Midway', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Majuro', 'Pacific/Majuro', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Pohnpei', 'Pacific/Pohnpei', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Palau', 'Pacific/Palau', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Yap', 'Pacific/Yap', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Johnston', 'Pacific/Johnston', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Ponape', 'Pacific/Ponape', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Guam', 'Pacific/Guam', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Bougainville', 'Pacific/Bougainville', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Wallis', 'Pacific/Wallis', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Nauru', 'Pacific/Nauru', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Pitcairn', 'Pacific/Pitcairn', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Rarotonga', 'Pacific/Rarotonga', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Truk', 'Pacific/Truk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Wake', 'Pacific/Wake', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Saipan', 'Pacific/Saipan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Norfolk', 'Pacific/Norfolk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Port_Moresby', 'Pacific/Port_Moresby', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Niue', 'Pacific/Niue', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Funafuti', 'Pacific/Funafuti', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Tahiti', 'Pacific/Tahiti', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Navajo', 'Navajo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Antarctica/Casey', 'Antarctica/Casey', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Antarctica/Vostok', 'Antarctica/Vostok', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Antarctica/Palmer', 'Antarctica/Palmer', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Antarctica/McMurdo', 'Antarctica/McMurdo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Antarctica/Macquarie', 'Antarctica/Macquarie', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Antarctica/Troll', 'Antarctica/Troll', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Antarctica/DumontDUrville', 'Antarctica/DumontDUrville', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Antarctica/Rothera', 'Antarctica/Rothera', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Antarctica/South_Pole', 'Antarctica/South_Pole', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Antarctica/Davis', 'Antarctica/Davis', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Antarctica/Mawson', 'Antarctica/Mawson', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Antarctica/Syowa', 'Antarctica/Syowa', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Thunder_Bay', 'America/Thunder_Bay', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Resolute', 'America/Resolute', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Nassau', 'America/Nassau', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Fortaleza', 'America/Fortaleza', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Dawson_Creek', 'America/Dawson_Creek', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Coral_Harbour', 'America/Coral_Harbour', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Maceio', 'America/Maceio', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Ojinaga', 'America/Ojinaga', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Tegucigalpa', 'America/Tegucigalpa', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Bahia_Banderas', 'America/Bahia_Banderas', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Costa_Rica', 'America/Costa_Rica', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Cuiaba', 'America/Cuiaba', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Managua', 'America/Managua', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Scoresbysund', 'America/Scoresbysund', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Whitehorse', 'America/Whitehorse', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Santo_Domingo', 'America/Santo_Domingo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Jamaica', 'America/Jamaica', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Lower_Princes', 'America/Lower_Princes', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Catamarca', 'America/Catamarca', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Grand_Turk', 'America/Grand_Turk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Noronha', 'America/Noronha', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Cayman', 'America/Cayman', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Barbados', 'America/Barbados', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Kralendijk', 'America/Kralendijk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Port-au-Prince', 'America/Port-au-Prince', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Porto_Velho', 'America/Porto_Velho', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Moncton', 'America/Moncton', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Guatemala', 'America/Guatemala', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Ciudad_Juarez', 'America/Ciudad_Juarez', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Boa_Vista', 'America/Boa_Vista', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Rainy_River', 'America/Rainy_River', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Dominica', 'America/Dominica', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Virgin', 'America/Virgin', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Antigua', 'America/Antigua', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Mazatlan', 'America/Mazatlan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Rio_Branco', 'America/Rio_Branco', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Knox_IN', 'America/Knox_IN', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/St_Kitts', 'America/St_Kitts', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Panama', 'America/Panama', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Iqaluit', 'America/Iqaluit', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Grenada', 'America/Grenada', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Guadeloupe', 'America/Guadeloupe', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Goose_Bay', 'America/Goose_Bay', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Montserrat', 'America/Montserrat', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Guayaquil', 'America/Guayaquil', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Asuncion', 'America/Asuncion', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Montevideo', 'America/Montevideo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Havana', 'America/Havana', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Anguilla', 'America/Anguilla', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Mendoza', 'America/Mendoza', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Hermosillo', 'America/Hermosillo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Glace_Bay', 'America/Glace_Bay', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Santarem', 'America/Santarem', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/St_Lucia', 'America/St_Lucia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Tortola', 'America/Tortola', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Belize', 'America/Belize', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Santa_Isabel', 'America/Santa_Isabel', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Paramaribo', 'America/Paramaribo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Swift_Current', 'America/Swift_Current', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Curacao', 'America/Curacao', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Recife', 'America/Recife', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Marigot', 'America/Marigot', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Rankin_Inlet', 'America/Rankin_Inlet', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Argentina/Catamarca', 'America/Argentina/Catamarca', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Argentina/San_Juan', 'America/Argentina/San_Juan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Argentina/Salta', 'America/Argentina/Salta', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Argentina/Mendoza', 'America/Argentina/Mendoza', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Argentina/San_Luis', 'America/Argentina/San_Luis', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Argentina/Rio_Gallegos', 'America/Argentina/Rio_Gallegos', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Argentina/Ushuaia', 'America/Argentina/Ushuaia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Argentina/La_Rioja', 'America/Argentina/La_Rioja', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Argentina/Jujuy', 'America/Argentina/Jujuy', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Argentina/Buenos_Aires', 'America/Argentina/Buenos_Aires', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Argentina/Cordoba', 'America/Argentina/Cordoba', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Argentina/ComodRivadavia', 'America/Argentina/ComodRivadavia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Argentina/Tucuman', 'America/Argentina/Tucuman', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/La_Paz', 'America/La_Paz', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Punta_Arenas', 'America/Punta_Arenas', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/St_Vincent', 'America/St_Vincent', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Porto_Acre', 'America/Porto_Acre', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Cayenne', 'America/Cayenne', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Shiprock', 'America/Shiprock', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Atikokan', 'America/Atikokan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Eirunepe', 'America/Eirunepe', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Creston', 'America/Creston', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Nuuk', 'America/Nuuk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Aruba', 'America/Aruba', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Merida', 'America/Merida', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Puerto_Rico', 'America/Puerto_Rico', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Manaus', 'America/Manaus', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/El_Salvador', 'America/El_Salvador', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Matamoros', 'America/Matamoros', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Pangnirtung', 'America/Pangnirtung', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Bahia', 'America/Bahia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Indianapolis', 'America/Indianapolis', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Danmarkshavn', 'America/Danmarkshavn', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Jujuy', 'America/Jujuy', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/St_Barthelemy', 'America/St_Barthelemy', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Atka', 'America/Atka', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Miquelon', 'America/Miquelon', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Martinique', 'America/Martinique', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Blanc-Sablon', 'America/Blanc-Sablon', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Godthab', 'America/Godthab', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Fort_Nelson', 'America/Fort_Nelson', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Louisville', 'America/Louisville', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Cordoba', 'America/Cordoba', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Guyana', 'America/Guyana', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Yellowknife', 'America/Yellowknife', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Dawson', 'America/Dawson', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Nipigon', 'America/Nipigon', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Belem', 'America/Belem', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Thule', 'America/Thule', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Cambridge_Bay', 'America/Cambridge_Bay', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Rosario', 'America/Rosario', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Ensenada', 'America/Ensenada', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Chihuahua', 'America/Chihuahua', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Regina', 'America/Regina', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Port_of_Spain', 'America/Port_of_Spain', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/St_Thomas', 'America/St_Thomas', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Campo_Grande', 'America/Campo_Grande', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Montreal', 'America/Montreal', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Araguaina', 'America/Araguaina', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Inuvik', 'America/Inuvik', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Fort_Wayne', 'America/Fort_Wayne', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('GMT', 'GMT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('PRC', 'PRC', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('ROC', 'ROC', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Arctic/Longyearbyen', 'Arctic/Longyearbyen', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/GB-Eire', 'posix/GB-Eire', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/NZ', 'posix/NZ', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Canada/Mountain', 'posix/Canada/Mountain', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Canada/Eastern', 'posix/Canada/Eastern', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Canada/Central', 'posix/Canada/Central', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Canada/Newfoundland', 'posix/Canada/Newfoundland', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Canada/Atlantic', 'posix/Canada/Atlantic', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Canada/Saskatchewan', 'posix/Canada/Saskatchewan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Canada/Yukon', 'posix/Canada/Yukon', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Canada/Pacific', 'posix/Canada/Pacific', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Indian/Mauritius', 'posix/Indian/Mauritius', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Indian/Maldives', 'posix/Indian/Maldives', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Indian/Kerguelen', 'posix/Indian/Kerguelen', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Indian/Antananarivo', 'posix/Indian/Antananarivo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Indian/Christmas', 'posix/Indian/Christmas', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Indian/Mahe', 'posix/Indian/Mahe', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Indian/Chagos', 'posix/Indian/Chagos', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Indian/Reunion', 'posix/Indian/Reunion', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Indian/Cocos', 'posix/Indian/Cocos', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Indian/Mayotte', 'posix/Indian/Mayotte', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Indian/Comoro', 'posix/Indian/Comoro', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/EET', 'posix/EET', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Iran', 'posix/Iran', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/GMT-0', 'posix/GMT-0', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/UTC', 'posix/UTC', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Jamaica', 'posix/Jamaica', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT+2', 'posix/Etc/GMT+2', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT-0', 'posix/Etc/GMT-0', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/UTC', 'posix/Etc/UTC', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT-5', 'posix/Etc/GMT-5', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT-9', 'posix/Etc/GMT-9', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT+1', 'posix/Etc/GMT+1', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT-2', 'posix/Etc/GMT-2', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT+0', 'posix/Etc/GMT+0', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT+6', 'posix/Etc/GMT+6', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT-1', 'posix/Etc/GMT-1', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT-14', 'posix/Etc/GMT-14', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/Greenwich', 'posix/Etc/Greenwich', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT+3', 'posix/Etc/GMT+3', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT+5', 'posix/Etc/GMT+5', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT+11', 'posix/Etc/GMT+11', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT+12', 'posix/Etc/GMT+12', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT-6', 'posix/Etc/GMT-6', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT-10', 'posix/Etc/GMT-10', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT-13', 'posix/Etc/GMT-13', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT-7', 'posix/Etc/GMT-7', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT-12', 'posix/Etc/GMT-12', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/Universal', 'posix/Etc/Universal', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/UCT', 'posix/Etc/UCT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT', 'posix/Etc/GMT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT+8', 'posix/Etc/GMT+8', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT+4', 'posix/Etc/GMT+4', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT+9', 'posix/Etc/GMT+9', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/Zulu', 'posix/Etc/Zulu', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT+10', 'posix/Etc/GMT+10', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT+7', 'posix/Etc/GMT+7', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT-3', 'posix/Etc/GMT-3', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT-11', 'posix/Etc/GMT-11', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT-8', 'posix/Etc/GMT-8', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT0', 'posix/Etc/GMT0', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Etc/GMT-4', 'posix/Etc/GMT-4', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/US/Samoa', 'posix/US/Samoa', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/US/Mountain', 'posix/US/Mountain', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/US/East-Indiana', 'posix/US/East-Indiana', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/US/Eastern', 'posix/US/Eastern', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/US/Hawaii', 'posix/US/Hawaii', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/US/Central', 'posix/US/Central', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/US/Alaska', 'posix/US/Alaska', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/US/Indiana-Starke', 'posix/US/Indiana-Starke', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/US/Michigan', 'posix/US/Michigan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/US/Pacific', 'posix/US/Pacific', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/US/Arizona', 'posix/US/Arizona', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/US/Aleutian', 'posix/US/Aleutian', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Poland', 'posix/Poland', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Niamey', 'posix/Africa/Niamey', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Bamako', 'posix/Africa/Bamako', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Freetown', 'posix/Africa/Freetown', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Brazzaville', 'posix/Africa/Brazzaville', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Ceuta', 'posix/Africa/Ceuta', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Algiers', 'posix/Africa/Algiers', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Windhoek', 'posix/Africa/Windhoek', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Casablanca', 'posix/Africa/Casablanca', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Timbuktu', 'posix/Africa/Timbuktu', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Khartoum', 'posix/Africa/Khartoum', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Porto-Novo', 'posix/Africa/Porto-Novo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Tripoli', 'posix/Africa/Tripoli', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Maseru', 'posix/Africa/Maseru', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Kigali', 'posix/Africa/Kigali', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Kampala', 'posix/Africa/Kampala', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Banjul', 'posix/Africa/Banjul', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Douala', 'posix/Africa/Douala', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Sao_Tome', 'posix/Africa/Sao_Tome', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Gaborone', 'posix/Africa/Gaborone', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Lome', 'posix/Africa/Lome', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Djibouti', 'posix/Africa/Djibouti', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Lubumbashi', 'posix/Africa/Lubumbashi', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Cairo', 'posix/Africa/Cairo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Juba', 'posix/Africa/Juba', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Dakar', 'posix/Africa/Dakar', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Mogadishu', 'posix/Africa/Mogadishu', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Mbabane', 'posix/Africa/Mbabane', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Dar_es_Salaam', 'posix/Africa/Dar_es_Salaam', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Ouagadougou', 'posix/Africa/Ouagadougou', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Conakry', 'posix/Africa/Conakry', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Malabo', 'posix/Africa/Malabo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Monrovia', 'posix/Africa/Monrovia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Harare', 'posix/Africa/Harare', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Kinshasa', 'posix/Africa/Kinshasa', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Libreville', 'posix/Africa/Libreville', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Nairobi', 'posix/Africa/Nairobi', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Tunis', 'posix/Africa/Tunis', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Bujumbura', 'posix/Africa/Bujumbura', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Bangui', 'posix/Africa/Bangui', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Lagos', 'posix/Africa/Lagos', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Bissau', 'posix/Africa/Bissau', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Maputo', 'posix/Africa/Maputo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Lusaka', 'posix/Africa/Lusaka', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Accra', 'posix/Africa/Accra', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/El_Aaiun', 'posix/Africa/El_Aaiun', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Ndjamena', 'posix/Africa/Ndjamena', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Asmara', 'posix/Africa/Asmara', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Johannesburg', 'posix/Africa/Johannesburg', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Blantyre', 'posix/Africa/Blantyre', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Asmera', 'posix/Africa/Asmera', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Abidjan', 'posix/Africa/Abidjan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Luanda', 'posix/Africa/Luanda', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Addis_Ababa', 'posix/Africa/Addis_Ababa', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Africa/Nouakchott', 'posix/Africa/Nouakchott', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Chile/EasterIsland', 'posix/Chile/EasterIsland', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Chile/Continental', 'posix/Chile/Continental', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Eire', 'posix/Eire', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/GMT+0', 'posix/GMT+0', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/WET', 'posix/WET', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/CST6CDT', 'posix/CST6CDT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/HST', 'posix/HST', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Portugal', 'posix/Portugal', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Mexico/BajaNorte', 'posix/Mexico/BajaNorte', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Mexico/General', 'posix/Mexico/General', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Mexico/BajaSur', 'posix/Mexico/BajaSur', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Greenwich', 'posix/Greenwich', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Egypt', 'posix/Egypt', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/CET', 'posix/CET', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Japan', 'posix/Japan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Atlantic/Reykjavik', 'posix/Atlantic/Reykjavik', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Atlantic/Madeira', 'posix/Atlantic/Madeira', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Atlantic/Faroe', 'posix/Atlantic/Faroe', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Atlantic/St_Helena', 'posix/Atlantic/St_Helena', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Atlantic/Stanley', 'posix/Atlantic/Stanley', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Atlantic/Faeroe', 'posix/Atlantic/Faeroe', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Atlantic/Azores', 'posix/Atlantic/Azores', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Atlantic/South_Georgia', 'posix/Atlantic/South_Georgia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Atlantic/Cape_Verde', 'posix/Atlantic/Cape_Verde', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Atlantic/Jan_Mayen', 'posix/Atlantic/Jan_Mayen', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Atlantic/Canary', 'posix/Atlantic/Canary', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Atlantic/Bermuda', 'posix/Atlantic/Bermuda', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Kwajalein', 'posix/Kwajalein', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/PST8PDT', 'posix/PST8PDT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/Hobart', 'posix/Australia/Hobart', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/Melbourne', 'posix/Australia/Melbourne', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/Queensland', 'posix/Australia/Queensland', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/Lindeman', 'posix/Australia/Lindeman', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/Currie', 'posix/Australia/Currie', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/Yancowinna', 'posix/Australia/Yancowinna', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/North', 'posix/Australia/North', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/Tasmania', 'posix/Australia/Tasmania', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/Brisbane', 'posix/Australia/Brisbane', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/ACT', 'posix/Australia/ACT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/South', 'posix/Australia/South', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/Sydney', 'posix/Australia/Sydney', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/LHI', 'posix/Australia/LHI', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/Victoria', 'posix/Australia/Victoria', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/Canberra', 'posix/Australia/Canberra', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/Eucla', 'posix/Australia/Eucla', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/West', 'posix/Australia/West', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/Lord_Howe', 'posix/Australia/Lord_Howe', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/Adelaide', 'posix/Australia/Adelaide', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/Broken_Hill', 'posix/Australia/Broken_Hill', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/Perth', 'posix/Australia/Perth', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/Darwin', 'posix/Australia/Darwin', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Australia/NSW', 'posix/Australia/NSW', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/MET', 'posix/MET', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/GB', 'posix/GB', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Turkey', 'posix/Turkey', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/MST7MDT', 'posix/MST7MDT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Libya', 'posix/Libya', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Hongkong', 'posix/Hongkong', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Yekaterinburg', 'posix/Asia/Yekaterinburg', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Choibalsan', 'posix/Asia/Choibalsan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Pyongyang', 'posix/Asia/Pyongyang', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Oral', 'posix/Asia/Oral', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Hong_Kong', 'posix/Asia/Hong_Kong', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Jerusalem', 'posix/Asia/Jerusalem', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Thimbu', 'posix/Asia/Thimbu', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Irkutsk', 'posix/Asia/Irkutsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Amman', 'posix/Asia/Amman', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Kashgar', 'posix/Asia/Kashgar', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Novokuznetsk', 'posix/Asia/Novokuznetsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Gaza', 'posix/Asia/Gaza', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Krasnoyarsk', 'posix/Asia/Krasnoyarsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Beirut', 'posix/Asia/Beirut', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Nicosia', 'posix/Asia/Nicosia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Kuala_Lumpur', 'posix/Asia/Kuala_Lumpur', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Dili', 'posix/Asia/Dili', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Saigon', 'posix/Asia/Saigon', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Baghdad', 'posix/Asia/Baghdad', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Dubai', 'posix/Asia/Dubai', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Chongqing', 'posix/Asia/Chongqing', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Makassar', 'posix/Asia/Makassar', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Jayapura', 'posix/Asia/Jayapura', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Ashgabat', 'posix/Asia/Ashgabat', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Urumqi', 'posix/Asia/Urumqi', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Anadyr', 'posix/Asia/Anadyr', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Tokyo', 'posix/Asia/Tokyo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Baku', 'posix/Asia/Baku', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Dushanbe', 'posix/Asia/Dushanbe', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Tomsk', 'posix/Asia/Tomsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Chita', 'posix/Asia/Chita', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Bahrain', 'posix/Asia/Bahrain', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Ulaanbaatar', 'posix/Asia/Ulaanbaatar', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Calcutta', 'posix/Asia/Calcutta', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Yakutsk', 'posix/Asia/Yakutsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Qostanay', 'posix/Asia/Qostanay', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Barnaul', 'posix/Asia/Barnaul', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Phnom_Penh', 'posix/Asia/Phnom_Penh', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Kabul', 'posix/Asia/Kabul', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Chungking', 'posix/Asia/Chungking', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Atyrau', 'posix/Asia/Atyrau', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Vientiane', 'posix/Asia/Vientiane', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Dacca', 'posix/Asia/Dacca', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Sakhalin', 'posix/Asia/Sakhalin', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Kuwait', 'posix/Asia/Kuwait', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Pontianak', 'posix/Asia/Pontianak', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Famagusta', 'posix/Asia/Famagusta', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Istanbul', 'posix/Asia/Istanbul', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Aqtau', 'posix/Asia/Aqtau', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Novosibirsk', 'posix/Asia/Novosibirsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Ujung_Pandang', 'posix/Asia/Ujung_Pandang', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Rangoon', 'posix/Asia/Rangoon', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Seoul', 'posix/Asia/Seoul', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Yerevan', 'posix/Asia/Yerevan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Ashkhabad', 'posix/Asia/Ashkhabad', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Karachi', 'posix/Asia/Karachi', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Hebron', 'posix/Asia/Hebron', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Ho_Chi_Minh', 'posix/Asia/Ho_Chi_Minh', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Yangon', 'posix/Asia/Yangon', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Bangkok', 'posix/Asia/Bangkok', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Katmandu', 'posix/Asia/Katmandu', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Dhaka', 'posix/Asia/Dhaka', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Kuching', 'posix/Asia/Kuching', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Magadan', 'posix/Asia/Magadan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Macau', 'posix/Asia/Macau', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Jakarta', 'posix/Asia/Jakarta', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Aden', 'posix/Asia/Aden', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Singapore', 'posix/Asia/Singapore', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Tashkent', 'posix/Asia/Tashkent', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Harbin', 'posix/Asia/Harbin', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Ust-Nera', 'posix/Asia/Ust-Nera', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Bishkek', 'posix/Asia/Bishkek', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Samarkand', 'posix/Asia/Samarkand', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Khandyga', 'posix/Asia/Khandyga', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Macao', 'posix/Asia/Macao', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Kolkata', 'posix/Asia/Kolkata', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Tel_Aviv', 'posix/Asia/Tel_Aviv', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Ulan_Bator', 'posix/Asia/Ulan_Bator', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Kathmandu', 'posix/Asia/Kathmandu', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Hovd', 'posix/Asia/Hovd', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Brunei', 'posix/Asia/Brunei', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Tbilisi', 'posix/Asia/Tbilisi', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Manila', 'posix/Asia/Manila', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Kamchatka', 'posix/Asia/Kamchatka', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Srednekolymsk', 'posix/Asia/Srednekolymsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Muscat', 'posix/Asia/Muscat', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Riyadh', 'posix/Asia/Riyadh', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Qyzylorda', 'posix/Asia/Qyzylorda', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Taipei', 'posix/Asia/Taipei', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Almaty', 'posix/Asia/Almaty', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Damascus', 'posix/Asia/Damascus', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Tehran', 'posix/Asia/Tehran', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Qatar', 'posix/Asia/Qatar', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Colombo', 'posix/Asia/Colombo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Shanghai', 'posix/Asia/Shanghai', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Omsk', 'posix/Asia/Omsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Aqtobe', 'posix/Asia/Aqtobe', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Thimphu', 'posix/Asia/Thimphu', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Asia/Vladivostok', 'posix/Asia/Vladivostok', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Cuba', 'posix/Cuba', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Singapore', 'posix/Singapore', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Universal', 'posix/Universal', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/UCT', 'posix/UCT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/NZ-CHAT', 'posix/NZ-CHAT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Noumea', 'posix/Pacific/Noumea', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Tarawa', 'posix/Pacific/Tarawa', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Samoa', 'posix/Pacific/Samoa', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Pago_Pago', 'posix/Pacific/Pago_Pago', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Chuuk', 'posix/Pacific/Chuuk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Fiji', 'posix/Pacific/Fiji', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Easter', 'posix/Pacific/Easter', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Kosrae', 'posix/Pacific/Kosrae', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Auckland', 'posix/Pacific/Auckland', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Galapagos', 'posix/Pacific/Galapagos', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Efate', 'posix/Pacific/Efate', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Kanton', 'posix/Pacific/Kanton', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Kiritimati', 'posix/Pacific/Kiritimati', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Enderbury', 'posix/Pacific/Enderbury', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Fakaofo', 'posix/Pacific/Fakaofo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Gambier', 'posix/Pacific/Gambier', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Apia', 'posix/Pacific/Apia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Marquesas', 'posix/Pacific/Marquesas', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Chatham', 'posix/Pacific/Chatham', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Kwajalein', 'posix/Pacific/Kwajalein', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Tongatapu', 'posix/Pacific/Tongatapu', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Guadalcanal', 'posix/Pacific/Guadalcanal', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Midway', 'posix/Pacific/Midway', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Majuro', 'posix/Pacific/Majuro', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Pohnpei', 'posix/Pacific/Pohnpei', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Palau', 'posix/Pacific/Palau', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Yap', 'posix/Pacific/Yap', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Johnston', 'posix/Pacific/Johnston', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Ponape', 'posix/Pacific/Ponape', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Guam', 'posix/Pacific/Guam', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Bougainville', 'posix/Pacific/Bougainville', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Wallis', 'posix/Pacific/Wallis', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Nauru', 'posix/Pacific/Nauru', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Pitcairn', 'posix/Pacific/Pitcairn', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Rarotonga', 'posix/Pacific/Rarotonga', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Truk', 'posix/Pacific/Truk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Honolulu', 'posix/Pacific/Honolulu', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Wake', 'posix/Pacific/Wake', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Saipan', 'posix/Pacific/Saipan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Norfolk', 'posix/Pacific/Norfolk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Port_Moresby', 'posix/Pacific/Port_Moresby', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Niue', 'posix/Pacific/Niue', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Funafuti', 'posix/Pacific/Funafuti', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Pacific/Tahiti', 'posix/Pacific/Tahiti', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Navajo', 'posix/Navajo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Antarctica/Casey', 'posix/Antarctica/Casey', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Antarctica/Vostok', 'posix/Antarctica/Vostok', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Antarctica/Palmer', 'posix/Antarctica/Palmer', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Antarctica/McMurdo', 'posix/Antarctica/McMurdo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Antarctica/Macquarie', 'posix/Antarctica/Macquarie', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Antarctica/Troll', 'posix/Antarctica/Troll', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Antarctica/DumontDUrville', 'posix/Antarctica/DumontDUrville', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Antarctica/Rothera', 'posix/Antarctica/Rothera', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Antarctica/South_Pole', 'posix/Antarctica/South_Pole', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Antarctica/Davis', 'posix/Antarctica/Davis', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Antarctica/Mawson', 'posix/Antarctica/Mawson', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Antarctica/Syowa', 'posix/Antarctica/Syowa', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Thunder_Bay', 'posix/America/Thunder_Bay', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Resolute', 'posix/America/Resolute', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Nassau', 'posix/America/Nassau', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Fortaleza', 'posix/America/Fortaleza', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Dawson_Creek', 'posix/America/Dawson_Creek', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Coral_Harbour', 'posix/America/Coral_Harbour', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Phoenix', 'posix/America/Phoenix', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Maceio', 'posix/America/Maceio', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Monterrey', 'posix/America/Monterrey', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Ojinaga', 'posix/America/Ojinaga', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Indiana/Knox', 'posix/America/Indiana/Knox', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Indiana/Petersburg', 'posix/America/Indiana/Petersburg', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Indiana/Tell_City', 'posix/America/Indiana/Tell_City', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Indiana/Indianapolis', 'posix/America/Indiana/Indianapolis', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Indiana/Vincennes', 'posix/America/Indiana/Vincennes', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Indiana/Marengo', 'posix/America/Indiana/Marengo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Indiana/Vevay', 'posix/America/Indiana/Vevay', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Indiana/Winamac', 'posix/America/Indiana/Winamac', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Tegucigalpa', 'posix/America/Tegucigalpa', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Vancouver', 'posix/America/Vancouver', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Bahia_Banderas', 'posix/America/Bahia_Banderas', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Costa_Rica', 'posix/America/Costa_Rica', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Cuiaba', 'posix/America/Cuiaba', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Managua', 'posix/America/Managua', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Kentucky/Monticello', 'posix/America/Kentucky/Monticello', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Kentucky/Louisville', 'posix/America/Kentucky/Louisville', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Scoresbysund', 'posix/America/Scoresbysund', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Whitehorse', 'posix/America/Whitehorse', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Santo_Domingo', 'posix/America/Santo_Domingo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Jamaica', 'posix/America/Jamaica', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Tijuana', 'posix/America/Tijuana', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/New_York', 'posix/America/New_York', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Lower_Princes', 'posix/America/Lower_Princes', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Catamarca', 'posix/America/Catamarca', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Juneau', 'posix/America/Juneau', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Grand_Turk', 'posix/America/Grand_Turk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Noronha', 'posix/America/Noronha', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Cayman', 'posix/America/Cayman', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Barbados', 'posix/America/Barbados', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Kralendijk', 'posix/America/Kralendijk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Winnipeg', 'posix/America/Winnipeg', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Port-au-Prince', 'posix/America/Port-au-Prince', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Porto_Velho', 'posix/America/Porto_Velho', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Moncton', 'posix/America/Moncton', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Chicago', 'posix/America/Chicago', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Bogota', 'posix/America/Bogota', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Detroit', 'posix/America/Detroit', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/St_Johns', 'posix/America/St_Johns', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Guatemala', 'posix/America/Guatemala', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Ciudad_Juarez', 'posix/America/Ciudad_Juarez', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Boa_Vista', 'posix/America/Boa_Vista', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Metlakatla', 'posix/America/Metlakatla', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Rainy_River', 'posix/America/Rainy_River', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Dominica', 'posix/America/Dominica', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Virgin', 'posix/America/Virgin', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Antigua', 'posix/America/Antigua', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Yakutat', 'posix/America/Yakutat', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Mazatlan', 'posix/America/Mazatlan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Rio_Branco', 'posix/America/Rio_Branco', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Cancun', 'posix/America/Cancun', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Knox_IN', 'posix/America/Knox_IN', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/St_Kitts', 'posix/America/St_Kitts', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Panama', 'posix/America/Panama', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Iqaluit', 'posix/America/Iqaluit', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Grenada', 'posix/America/Grenada', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Guadeloupe', 'posix/America/Guadeloupe', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Goose_Bay', 'posix/America/Goose_Bay', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Montserrat', 'posix/America/Montserrat', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Guayaquil', 'posix/America/Guayaquil', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Asuncion', 'posix/America/Asuncion', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Montevideo', 'posix/America/Montevideo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Caracas', 'posix/America/Caracas', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Havana', 'posix/America/Havana', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Anguilla', 'posix/America/Anguilla', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Denver', 'posix/America/Denver', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Mendoza', 'posix/America/Mendoza', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Hermosillo', 'posix/America/Hermosillo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Glace_Bay', 'posix/America/Glace_Bay', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Nome', 'posix/America/Nome', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Santarem', 'posix/America/Santarem', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/St_Lucia', 'posix/America/St_Lucia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Tortola', 'posix/America/Tortola', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Belize', 'posix/America/Belize', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Santa_Isabel', 'posix/America/Santa_Isabel', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Paramaribo', 'posix/America/Paramaribo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Swift_Current', 'posix/America/Swift_Current', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Curacao', 'posix/America/Curacao', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Toronto', 'posix/America/Toronto', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Recife', 'posix/America/Recife', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Marigot', 'posix/America/Marigot', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Rankin_Inlet', 'posix/America/Rankin_Inlet', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Menominee', 'posix/America/Menominee', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/North_Dakota/New_Salem', 'posix/America/North_Dakota/New_Salem', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/North_Dakota/Beulah', 'posix/America/North_Dakota/Beulah', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/North_Dakota/Center', 'posix/America/North_Dakota/Center', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Edmonton', 'posix/America/Edmonton', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Argentina/Catamarca', 'posix/America/Argentina/Catamarca', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Argentina/San_Juan', 'posix/America/Argentina/San_Juan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Argentina/Salta', 'posix/America/Argentina/Salta', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Argentina/Mendoza', 'posix/America/Argentina/Mendoza', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Argentina/San_Luis', 'posix/America/Argentina/San_Luis', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Argentina/Rio_Gallegos', 'posix/America/Argentina/Rio_Gallegos', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Argentina/Ushuaia', 'posix/America/Argentina/Ushuaia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Argentina/La_Rioja', 'posix/America/Argentina/La_Rioja', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Argentina/Jujuy', 'posix/America/Argentina/Jujuy', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Argentina/Buenos_Aires', 'posix/America/Argentina/Buenos_Aires', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Argentina/Cordoba', 'posix/America/Argentina/Cordoba', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Argentina/ComodRivadavia', 'posix/America/Argentina/ComodRivadavia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Argentina/Tucuman', 'posix/America/Argentina/Tucuman', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/La_Paz', 'posix/America/La_Paz', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Punta_Arenas', 'posix/America/Punta_Arenas', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/St_Vincent', 'posix/America/St_Vincent', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Porto_Acre', 'posix/America/Porto_Acre', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Cayenne', 'posix/America/Cayenne', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Shiprock', 'posix/America/Shiprock', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Atikokan', 'posix/America/Atikokan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Eirunepe', 'posix/America/Eirunepe', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Creston', 'posix/America/Creston', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Nuuk', 'posix/America/Nuuk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Adak', 'posix/America/Adak', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Halifax', 'posix/America/Halifax', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Aruba', 'posix/America/Aruba', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Merida', 'posix/America/Merida', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Puerto_Rico', 'posix/America/Puerto_Rico', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Manaus', 'posix/America/Manaus', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Lima', 'posix/America/Lima', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/El_Salvador', 'posix/America/El_Salvador', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Matamoros', 'posix/America/Matamoros', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Pangnirtung', 'posix/America/Pangnirtung', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Sitka', 'posix/America/Sitka', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Sao_Paulo', 'posix/America/Sao_Paulo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Mexico_City', 'posix/America/Mexico_City', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Bahia', 'posix/America/Bahia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Indianapolis', 'posix/America/Indianapolis', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Danmarkshavn', 'posix/America/Danmarkshavn', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Jujuy', 'posix/America/Jujuy', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/St_Barthelemy', 'posix/America/St_Barthelemy', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Atka', 'posix/America/Atka', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Miquelon', 'posix/America/Miquelon', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Martinique', 'posix/America/Martinique', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Blanc-Sablon', 'posix/America/Blanc-Sablon', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Boise', 'posix/America/Boise', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Godthab', 'posix/America/Godthab', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Fort_Nelson', 'posix/America/Fort_Nelson', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Santiago', 'posix/America/Santiago', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Buenos_Aires', 'posix/America/Buenos_Aires', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Los_Angeles', 'posix/America/Los_Angeles', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Louisville', 'posix/America/Louisville', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Cordoba', 'posix/America/Cordoba', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Guyana', 'posix/America/Guyana', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Yellowknife', 'posix/America/Yellowknife', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Dawson', 'posix/America/Dawson', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Nipigon', 'posix/America/Nipigon', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Belem', 'posix/America/Belem', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Thule', 'posix/America/Thule', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Cambridge_Bay', 'posix/America/Cambridge_Bay', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Anchorage', 'posix/America/Anchorage', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Rosario', 'posix/America/Rosario', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Ensenada', 'posix/America/Ensenada', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Chihuahua', 'posix/America/Chihuahua', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Regina', 'posix/America/Regina', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Port_of_Spain', 'posix/America/Port_of_Spain', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/St_Thomas', 'posix/America/St_Thomas', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Campo_Grande', 'posix/America/Campo_Grande', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Montreal', 'posix/America/Montreal', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Araguaina', 'posix/America/Araguaina', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Inuvik', 'posix/America/Inuvik', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/America/Fort_Wayne', 'posix/America/Fort_Wayne', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/GMT', 'posix/GMT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/PRC', 'posix/PRC', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/ROC', 'posix/ROC', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Arctic/Longyearbyen', 'posix/Arctic/Longyearbyen', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Iceland', 'posix/Iceland', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/EST5EDT', 'posix/EST5EDT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Factory', 'posix/Factory', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Brazil/DeNoronha', 'posix/Brazil/DeNoronha', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Brazil/East', 'posix/Brazil/East', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Brazil/West', 'posix/Brazil/West', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Brazil/Acre', 'posix/Brazil/Acre', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Israel', 'posix/Israel', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Zulu', 'posix/Zulu', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Vienna', 'posix/Europe/Vienna', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Uzhgorod', 'posix/Europe/Uzhgorod', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Zagreb', 'posix/Europe/Zagreb', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Podgorica', 'posix/Europe/Podgorica', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Brussels', 'posix/Europe/Brussels', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Budapest', 'posix/Europe/Budapest', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Samara', 'posix/Europe/Samara', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Nicosia', 'posix/Europe/Nicosia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Tallinn', 'posix/Europe/Tallinn', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Berlin', 'posix/Europe/Berlin', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Kaliningrad', 'posix/Europe/Kaliningrad', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Belgrade', 'posix/Europe/Belgrade', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Jersey', 'posix/Europe/Jersey', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Copenhagen', 'posix/Europe/Copenhagen', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Oslo', 'posix/Europe/Oslo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Guernsey', 'posix/Europe/Guernsey', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Saratov', 'posix/Europe/Saratov', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Prague', 'posix/Europe/Prague', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Athens', 'posix/Europe/Athens', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Astrakhan', 'posix/Europe/Astrakhan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Stockholm', 'posix/Europe/Stockholm', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Rome', 'posix/Europe/Rome', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Sofia', 'posix/Europe/Sofia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Bucharest', 'posix/Europe/Bucharest', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Amsterdam', 'posix/Europe/Amsterdam', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Volgograd', 'posix/Europe/Volgograd', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Minsk', 'posix/Europe/Minsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Istanbul', 'posix/Europe/Istanbul', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Warsaw', 'posix/Europe/Warsaw', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Moscow', 'posix/Europe/Moscow', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Tirane', 'posix/Europe/Tirane', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Bratislava', 'posix/Europe/Bratislava', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Chisinau', 'posix/Europe/Chisinau', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Kiev', 'posix/Europe/Kiev', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Sarajevo', 'posix/Europe/Sarajevo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Helsinki', 'posix/Europe/Helsinki', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Zurich', 'posix/Europe/Zurich', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/San_Marino', 'posix/Europe/San_Marino', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Belfast', 'posix/Europe/Belfast', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Vaduz', 'posix/Europe/Vaduz', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Kyiv', 'posix/Europe/Kyiv', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Vilnius', 'posix/Europe/Vilnius', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Vatican', 'posix/Europe/Vatican', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Mariehamn', 'posix/Europe/Mariehamn', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Madrid', 'posix/Europe/Madrid', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Monaco', 'posix/Europe/Monaco', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Gibraltar', 'posix/Europe/Gibraltar', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Paris', 'posix/Europe/Paris', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Riga', 'posix/Europe/Riga', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Skopje', 'posix/Europe/Skopje', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/London', 'posix/Europe/London', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Ljubljana', 'posix/Europe/Ljubljana', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Ulyanovsk', 'posix/Europe/Ulyanovsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Tiraspol', 'posix/Europe/Tiraspol', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Isle_of_Man', 'posix/Europe/Isle_of_Man', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Dublin', 'posix/Europe/Dublin', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Zaporozhye', 'posix/Europe/Zaporozhye', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Kirov', 'posix/Europe/Kirov', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Simferopol', 'posix/Europe/Simferopol', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Lisbon', 'posix/Europe/Lisbon', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Luxembourg', 'posix/Europe/Luxembourg', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Andorra', 'posix/Europe/Andorra', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Busingen', 'posix/Europe/Busingen', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/Europe/Malta', 'posix/Europe/Malta', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/EST', 'posix/EST', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/ROK', 'posix/ROK', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/MST', 'posix/MST', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/W-SU', 'posix/W-SU', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('posix/GMT0', 'posix/GMT0', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Iceland', 'Iceland', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('EST5EDT', 'EST5EDT', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Factory', 'Factory', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Brazil/DeNoronha', 'Brazil/DeNoronha', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Brazil/East', 'Brazil/East', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Brazil/West', 'Brazil/West', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Brazil/Acre', 'Brazil/Acre', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Israel', 'Israel', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Zulu', 'Zulu', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Uzhgorod', 'Europe/Uzhgorod', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Zagreb', 'Europe/Zagreb', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Podgorica', 'Europe/Podgorica', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Samara', 'Europe/Samara', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Nicosia', 'Europe/Nicosia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Tallinn', 'Europe/Tallinn', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Kaliningrad', 'Europe/Kaliningrad', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Belgrade', 'Europe/Belgrade', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Jersey', 'Europe/Jersey', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Guernsey', 'Europe/Guernsey', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Saratov', 'Europe/Saratov', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Astrakhan', 'Europe/Astrakhan', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Sofia', 'Europe/Sofia', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Volgograd', 'Europe/Volgograd', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Minsk', 'Europe/Minsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Tirane', 'Europe/Tirane', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Bratislava', 'Europe/Bratislava', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Chisinau', 'Europe/Chisinau', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Kiev', 'Europe/Kiev', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Sarajevo', 'Europe/Sarajevo', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/San_Marino', 'Europe/San_Marino', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Belfast', 'Europe/Belfast', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Vaduz', 'Europe/Vaduz', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Vilnius', 'Europe/Vilnius', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Vatican', 'Europe/Vatican', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Mariehamn', 'Europe/Mariehamn', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Monaco', 'Europe/Monaco', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Gibraltar', 'Europe/Gibraltar', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Riga', 'Europe/Riga', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Skopje', 'Europe/Skopje', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Ljubljana', 'Europe/Ljubljana', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Ulyanovsk', 'Europe/Ulyanovsk', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Tiraspol', 'Europe/Tiraspol', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Isle_of_Man', 'Europe/Isle_of_Man', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Zaporozhye', 'Europe/Zaporozhye', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Kirov', 'Europe/Kirov', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Simferopol', 'Europe/Simferopol', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Luxembourg', 'Europe/Luxembourg', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Andorra', 'Europe/Andorra', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Busingen', 'Europe/Busingen', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Malta', 'Europe/Malta', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('EST', 'EST', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('ROK', 'ROK', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('MST', 'MST', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('W-SU', 'W-SU', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('GMT0', 'GMT0', 0, false);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/New_York', 'Eastern Time (ET)', 1, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Detroit', 'Eastern Time - Detroit (ET)', 2, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Kentucky/Louisville', 'Eastern Time - Louisville, KY (ET)', 3, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Kentucky/Monticello', 'Eastern Time - Monticello, KY (ET)', 4, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Indiana/Indianapolis', 'Eastern Time - Indianapolis (ET)', 5, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Indiana/Vincennes', 'Eastern Time - Vincennes, IN (ET)', 6, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Indiana/Winamac', 'Eastern Time - Winamac, IN (ET)', 7, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Indiana/Marengo', 'Eastern Time - Marengo, IN (ET)', 8, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Indiana/Petersburg', 'Eastern Time - Petersburg, IN (ET)', 9, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Indiana/Vevay', 'Eastern Time - Vevay, IN (ET)', 10, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Chicago', 'Central Time (CT)', 11, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Indiana/Tell_City', 'Central Time - Tell City, IN (CT)', 12, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Indiana/Knox', 'Central Time - Knox, IN (CT)', 13, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Menominee', 'Central Time - Menominee, MI (CT)', 14, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/North_Dakota/Center', 'Central Time - Center, ND (CT)', 15, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/North_Dakota/New_Salem', 'Central Time - New Salem, ND (CT)', 16, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/North_Dakota/Beulah', 'Central Time - Beulah, ND (CT)', 17, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Denver', 'Mountain Time (MT)', 18, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Boise', 'Mountain Time - Boise (MT)', 19, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Phoenix', 'Mountain Time - Arizona (MT)', 20, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Los_Angeles', 'Pacific Time (PT)', 21, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Anchorage', 'Alaska Time (AKT)', 22, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Juneau', 'Alaska Time - Juneau (AKT)', 23, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Sitka', 'Alaska Time - Sitka (AKT)', 24, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Metlakatla', 'Alaska Time - Metlakatla (AKT)', 25, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Yakutat', 'Alaska Time - Yakutat (AKT)', 26, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Nome', 'Alaska Time - Nome (AKT)', 27, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Adak', 'Hawaii-Aleutian Time (HST)', 28, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Honolulu', 'Hawaii Time (HST)', 29, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Toronto', 'Eastern Time - Toronto (ET)', 30, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Vancouver', 'Pacific Time - Vancouver (PT)', 31, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Winnipeg', 'Central Time - Winnipeg (CT)', 32, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Edmonton', 'Mountain Time - Edmonton (MT)', 33, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Halifax', 'Atlantic Time - Halifax (AT)', 34, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/St_Johns', 'Newfoundland Time (NT)', 35, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Mexico_City', 'Central Time - Mexico City (CT)', 36, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Monterrey', 'Central Time - Monterrey (CT)', 37, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Cancun', 'Eastern Time - Cancún (ET)', 38, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Tijuana', 'Pacific Time - Tijuana (PT)', 39, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Sao_Paulo', 'Brasília Time (BRT)', 40, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Buenos_Aires', 'Argentina Time (ART)', 41, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Lima', 'Peru Time (PET)', 42, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Santiago', 'Chile Time (CLT)', 43, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Bogota', 'Colombia Time (COT)', 44, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('America/Caracas', 'Venezuela Time (VET)', 45, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/London', 'Greenwich Mean Time (GMT)', 50, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Dublin', 'Greenwich Mean Time - Dublin (GMT)', 51, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Lisbon', 'Western European Time (WET)', 52, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Paris', 'Central European Time (CET)', 53, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Berlin', 'Central European Time - Berlin (CET)', 54, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Rome', 'Central European Time - Rome (CET)', 55, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Madrid', 'Central European Time - Madrid (CET)', 56, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Amsterdam', 'Central European Time - Amsterdam (CET)', 57, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Brussels', 'Central European Time - Brussels (CET)', 58, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Vienna', 'Central European Time - Vienna (CET)', 59, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Zurich', 'Central European Time - Zurich (CET)', 60, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Stockholm', 'Central European Time - Stockholm (CET)', 61, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Oslo', 'Central European Time - Oslo (CET)', 62, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Copenhagen', 'Central European Time - Copenhagen (CET)', 63, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Helsinki', 'Eastern European Time - Helsinki (EET)', 64, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Athens', 'Eastern European Time - Athens (EET)', 65, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Prague', 'Central European Time - Prague (CET)', 66, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Warsaw', 'Central European Time - Warsaw (CET)', 67, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Budapest', 'Central European Time - Budapest (CET)', 68, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Bucharest', 'Eastern European Time - Bucharest (EET)', 69, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Istanbul', 'Turkey Time (TRT)', 70, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Moscow', 'Moscow Time (MSK)', 71, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Europe/Kyiv', 'Eastern European Time - Kyiv (EET)', 72, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Dubai', 'Gulf Standard Time (GST)', 80, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Riyadh', 'Arabia Standard Time (AST)', 81, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Kuwait', 'Arabia Standard Time - Kuwait (AST)', 82, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Baghdad', 'Arabia Standard Time - Baghdad (AST)', 83, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Tehran', 'Iran Standard Time (IRST)', 84, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Karachi', 'Pakistan Standard Time (PKT)', 85, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Dhaka', 'Bangladesh Standard Time (BST)', 86, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Kolkata', 'India Standard Time (IST)', 87, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Colombo', 'India Standard Time - Colombo (IST)', 88, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Kathmandu', 'Nepal Time (NPT)', 89, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Yangon', 'Myanmar Time (MMT)', 90, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Bangkok', 'Indochina Time (ICT)', 91, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Ho_Chi_Minh', 'Indochina Time - Ho Chi Minh City (ICT)', 92, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Phnom_Penh', 'Indochina Time - Phnom Penh (ICT)', 93, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Jakarta', 'Western Indonesia Time (WIB)', 94, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Singapore', 'Singapore Time (SGT)', 95, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Kuala_Lumpur', 'Malaysia Time (MYT)', 96, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Manila', 'Philippine Time (PHT)', 97, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Hong_Kong', 'Hong Kong Time (HKT)', 98, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Shanghai', 'China Standard Time (CST)', 99, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Taipei', 'Taipei Time (TST)', 100, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Seoul', 'Korea Standard Time (KST)', 101, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Asia/Tokyo', 'Japan Standard Time (JST)', 102, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/Sydney', 'Australian Eastern Time (AET)', 110, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/Melbourne', 'Australian Eastern Time - Melbourne (AET)', 111, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/Brisbane', 'Australian Eastern Time - Brisbane (AET)', 112, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/Adelaide', 'Australian Central Time (ACT)', 113, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/Perth', 'Australian Western Time (AWT)', 114, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Australia/Darwin', 'Australian Central Time - Darwin (ACT)', 115, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Auckland', 'New Zealand Time (NZST)', 116, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Pacific/Fiji', 'Fiji Time (FJT)', 117, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Cairo', 'Eastern European Time - Cairo (EET)', 120, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Johannesburg', 'South Africa Standard Time (SAST)', 121, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Lagos', 'West Africa Time (WAT)', 122, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Nairobi', 'East Africa Time (EAT)', 123, true);
INSERT INTO public.timezones (value, label, display_order, active) VALUES ('Africa/Casablanca', 'Western European Time - Casablanca (WET)', 124, true);


-- Advance IDENTITY sequence past seeded market_events ids; without this, fresh
-- environments (db:reset) hit a primary-key collision the first time the cron
-- upserts an IPO event, since the sequence still starts at 1 while seeded ids
-- already occupy 36-265.
SELECT pg_catalog.setval(
  'public.market_events_id_seq',
  (SELECT COALESCE(MAX(id), 0) FROM public.market_events),
  true
);
