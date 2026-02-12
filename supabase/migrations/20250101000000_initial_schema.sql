/* =============
Extensions
============= */

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

/* =============
Schema Version (test + ops sanity check)
============= */

CREATE TABLE public.app_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO public.app_metadata (key, value)
VALUES ('schema_version', '20250101000000_initial_schema@v1')
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value;

ALTER TABLE public.app_metadata ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_metadata FROM anon, authenticated;
GRANT SELECT ON TABLE public.app_metadata TO service_role;

/* =============
Validation Functions
============= */

/*
 * Checks if a text value contains any whitespace characters.
 * Returns true if the value has no whitespace, false otherwise.
 *
 * Notes:
 * - Marked IMMUTABLE so it can be used in CHECK constraints.
 * - Marked STRICT so NULL inputs return NULL (and CHECK constraints treat NULL as passing).
 */
CREATE OR REPLACE FUNCTION public.has_no_whitespace(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT value !~ '\s';
$$;

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
      COALESCE(array_length(times, 1), 0) <= 5
      AND NOT EXISTS (
        SELECT 1 FROM unnest(times) AS t(val)
        WHERE val < 0 OR val >= 1440
      )
    );
$$;

/* =============
Enums
============= */

CREATE TYPE public.delivery_method AS ENUM ('email', 'sms');

CREATE TYPE public.scheduled_notification_type AS ENUM ('market', 'daily', 'asset_events');

CREATE TYPE public.scheduled_notification_status AS ENUM ('sending', 'sent', 'failed');

CREATE TYPE public.asset_event_type AS ENUM ('earnings', 'dividend', 'split');

/* =============
Timezones
============= */

CREATE TABLE timezones (
  value TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  display_order SMALLINT NOT NULL CHECK (display_order >= 0),
  active BOOLEAN DEFAULT true NOT NULL
);

-- Populate all Postgres-known timezones (IANA + aliases) as inactive by default.
-- Curated UI options are applied below via upserts.
INSERT INTO timezones (value, label, display_order, active)
SELECT name, name, 0, false
FROM pg_timezone_names
ON CONFLICT (value) DO UPDATE SET
  label = EXCLUDED.label,
  display_order = EXCLUDED.display_order,
  active = EXCLUDED.active;

INSERT INTO timezones (value, label, display_order, active) VALUES
  ('America/New_York', 'Eastern Time (ET)', 1, true),
  ('America/Detroit', 'Eastern Time - Detroit (ET)', 2, true),
  ('America/Kentucky/Louisville', 'Eastern Time - Louisville, KY (ET)', 3, true),
  ('America/Kentucky/Monticello', 'Eastern Time - Monticello, KY (ET)', 4, true),
  ('America/Indiana/Indianapolis', 'Eastern Time - Indianapolis (ET)', 5, true),
  ('America/Indiana/Vincennes', 'Eastern Time - Vincennes, IN (ET)', 6, true),
  ('America/Indiana/Winamac', 'Eastern Time - Winamac, IN (ET)', 7, true),
  ('America/Indiana/Marengo', 'Eastern Time - Marengo, IN (ET)', 8, true),
  ('America/Indiana/Petersburg', 'Eastern Time - Petersburg, IN (ET)', 9, true),
  ('America/Indiana/Vevay', 'Eastern Time - Vevay, IN (ET)', 10, true),
  ('America/Chicago', 'Central Time (CT)', 11, true),
  ('America/Indiana/Tell_City', 'Central Time - Tell City, IN (CT)', 12, true),
  ('America/Indiana/Knox', 'Central Time - Knox, IN (CT)', 13, true),
  ('America/Menominee', 'Central Time - Menominee, MI (CT)', 14, true),
  ('America/North_Dakota/Center', 'Central Time - Center, ND (CT)', 15, true),
  ('America/North_Dakota/New_Salem', 'Central Time - New Salem, ND (CT)', 16, true),
  ('America/North_Dakota/Beulah', 'Central Time - Beulah, ND (CT)', 17, true),
  ('America/Denver', 'Mountain Time (MT)', 18, true),
  ('America/Boise', 'Mountain Time - Boise (MT)', 19, true),
  ('America/Phoenix', 'Mountain Time - Arizona (MT)', 20, true),
  ('America/Los_Angeles', 'Pacific Time (PT)', 21, true),
  ('America/Anchorage', 'Alaska Time (AKT)', 22, true),
  ('America/Juneau', 'Alaska Time - Juneau (AKT)', 23, true),
  ('America/Sitka', 'Alaska Time - Sitka (AKT)', 24, true),
  ('America/Metlakatla', 'Alaska Time - Metlakatla (AKT)', 25, true),
  ('America/Yakutat', 'Alaska Time - Yakutat (AKT)', 26, true),
  ('America/Nome', 'Alaska Time - Nome (AKT)', 27, true),
  ('America/Adak', 'Hawaii-Aleutian Time (HST)', 28, true),
  ('Pacific/Honolulu', 'Hawaii Time (HST)', 29, true),
  ('America/Toronto', 'Eastern Time - Toronto (ET)', 30, true),
  ('America/Vancouver', 'Pacific Time - Vancouver (PT)', 31, true),
  ('America/Winnipeg', 'Central Time - Winnipeg (CT)', 32, true),
  ('America/Edmonton', 'Mountain Time - Edmonton (MT)', 33, true),
  ('America/Halifax', 'Atlantic Time - Halifax (AT)', 34, true),
  ('America/St_Johns', 'Newfoundland Time (NT)', 35, true),
  ('America/Mexico_City', 'Central Time - Mexico City (CT)', 36, true),
  ('America/Monterrey', 'Central Time - Monterrey (CT)', 37, true),
  ('America/Cancun', 'Eastern Time - Cancún (ET)', 38, true),
  ('America/Tijuana', 'Pacific Time - Tijuana (PT)', 39, true),
  ('America/Sao_Paulo', 'Brasília Time (BRT)', 40, true),
  ('America/Buenos_Aires', 'Argentina Time (ART)', 41, true),
  ('America/Lima', 'Peru Time (PET)', 42, true),
  ('America/Santiago', 'Chile Time (CLT)', 43, true),
  ('America/Bogota', 'Colombia Time (COT)', 44, true),
  ('America/Caracas', 'Venezuela Time (VET)', 45, true),
  ('Europe/London', 'Greenwich Mean Time (GMT)', 50, true),
  ('Europe/Dublin', 'Greenwich Mean Time - Dublin (GMT)', 51, true),
  ('Europe/Lisbon', 'Western European Time (WET)', 52, true),
  ('Europe/Paris', 'Central European Time (CET)', 53, true),
  ('Europe/Berlin', 'Central European Time - Berlin (CET)', 54, true),
  ('Europe/Rome', 'Central European Time - Rome (CET)', 55, true),
  ('Europe/Madrid', 'Central European Time - Madrid (CET)', 56, true),
  ('Europe/Amsterdam', 'Central European Time - Amsterdam (CET)', 57, true),
  ('Europe/Brussels', 'Central European Time - Brussels (CET)', 58, true),
  ('Europe/Vienna', 'Central European Time - Vienna (CET)', 59, true),
  ('Europe/Zurich', 'Central European Time - Zurich (CET)', 60, true),
  ('Europe/Stockholm', 'Central European Time - Stockholm (CET)', 61, true),
  ('Europe/Oslo', 'Central European Time - Oslo (CET)', 62, true),
  ('Europe/Copenhagen', 'Central European Time - Copenhagen (CET)', 63, true),
  ('Europe/Helsinki', 'Eastern European Time - Helsinki (EET)', 64, true),
  ('Europe/Athens', 'Eastern European Time - Athens (EET)', 65, true),
  ('Europe/Prague', 'Central European Time - Prague (CET)', 66, true),
  ('Europe/Warsaw', 'Central European Time - Warsaw (CET)', 67, true),
  ('Europe/Budapest', 'Central European Time - Budapest (CET)', 68, true),
  ('Europe/Bucharest', 'Eastern European Time - Bucharest (EET)', 69, true),
  ('Europe/Istanbul', 'Turkey Time (TRT)', 70, true),
  ('Europe/Moscow', 'Moscow Time (MSK)', 71, true),
  ('Europe/Kyiv', 'Eastern European Time - Kyiv (EET)', 72, true),
  ('Asia/Dubai', 'Gulf Standard Time (GST)', 80, true),
  ('Asia/Riyadh', 'Arabia Standard Time (AST)', 81, true),
  ('Asia/Kuwait', 'Arabia Standard Time - Kuwait (AST)', 82, true),
  ('Asia/Baghdad', 'Arabia Standard Time - Baghdad (AST)', 83, true),
  ('Asia/Tehran', 'Iran Standard Time (IRST)', 84, true),
  ('Asia/Karachi', 'Pakistan Standard Time (PKT)', 85, true),
  ('Asia/Dhaka', 'Bangladesh Standard Time (BST)', 86, true),
  ('Asia/Kolkata', 'India Standard Time (IST)', 87, true),
  ('Asia/Colombo', 'India Standard Time - Colombo (IST)', 88, true),
  ('Asia/Kathmandu', 'Nepal Time (NPT)', 89, true),
  ('Asia/Yangon', 'Myanmar Time (MMT)', 90, true),
  ('Asia/Bangkok', 'Indochina Time (ICT)', 91, true),
  ('Asia/Ho_Chi_Minh', 'Indochina Time - Ho Chi Minh City (ICT)', 92, true),
  ('Asia/Phnom_Penh', 'Indochina Time - Phnom Penh (ICT)', 93, true),
  ('Asia/Jakarta', 'Western Indonesia Time (WIB)', 94, true),
  ('Asia/Singapore', 'Singapore Time (SGT)', 95, true),
  ('Asia/Kuala_Lumpur', 'Malaysia Time (MYT)', 96, true),
  ('Asia/Manila', 'Philippine Time (PHT)', 97, true),
  ('Asia/Hong_Kong', 'Hong Kong Time (HKT)', 98, true),
  ('Asia/Shanghai', 'China Standard Time (CST)', 99, true),
  ('Asia/Taipei', 'Taipei Time (TST)', 100, true),
  ('Asia/Seoul', 'Korea Standard Time (KST)', 101, true),
  ('Asia/Tokyo', 'Japan Standard Time (JST)', 102, true),
  ('Australia/Sydney', 'Australian Eastern Time (AET)', 110, true),
  ('Australia/Melbourne', 'Australian Eastern Time - Melbourne (AET)', 111, true),
  ('Australia/Brisbane', 'Australian Eastern Time - Brisbane (AET)', 112, true),
  ('Australia/Adelaide', 'Australian Central Time (ACT)', 113, true),
  ('Australia/Perth', 'Australian Western Time (AWT)', 114, true),
  ('Australia/Darwin', 'Australian Central Time - Darwin (ACT)', 115, true),
  ('Pacific/Auckland', 'New Zealand Time (NZST)', 116, true),
  ('Pacific/Fiji', 'Fiji Time (FJT)', 117, true),
  ('Africa/Cairo', 'Eastern European Time - Cairo (EET)', 120, true),
  ('Africa/Johannesburg', 'South Africa Standard Time (SAST)', 121, true),
  ('Africa/Lagos', 'West Africa Time (WAT)', 122, true),
  ('Africa/Nairobi', 'East Africa Time (EAT)', 123, true),
  ('Africa/Casablanca', 'Western European Time - Casablanca (WET)', 124, true)
ON CONFLICT (value) DO UPDATE SET
  label = EXCLUDED.label,
  display_order = EXCLUDED.display_order,
  active = EXCLUDED.active;

ALTER TABLE timezones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Timezones are readable by anyone" ON timezones
  FOR SELECT USING (true);

GRANT SELECT ON TABLE public.timezones TO anon, authenticated;

/* =============
Users
============= */

CREATE TABLE users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone_country_code VARCHAR(5),
  phone_number VARCHAR(15),
  full_phone VARCHAR(20) GENERATED ALWAYS AS (
    CASE
      WHEN phone_country_code IS NOT NULL AND phone_number IS NOT NULL
      THEN phone_country_code || phone_number
      ELSE NULL
    END
  ) STORED,
  phone_verified BOOLEAN DEFAULT false NOT NULL,
  verification_sent_at TIMESTAMP WITH TIME ZONE,
  timezone TEXT DEFAULT 'America/New_York' REFERENCES timezones(value) NOT NULL,
  -- Market scheduled asset price notifications
  market_scheduled_asset_price_times INTEGER[] DEFAULT '{}',
  market_scheduled_asset_price_next_send_at TIMESTAMP WITH TIME ZONE,
  market_scheduled_asset_price_enabled BOOLEAN DEFAULT false NOT NULL,
  market_scheduled_asset_price_include_email BOOLEAN DEFAULT false NOT NULL,
  market_scheduled_asset_price_include_sms BOOLEAN DEFAULT false NOT NULL,
  -- Asset price alerts
  market_asset_price_alerts_enabled BOOLEAN DEFAULT false NOT NULL,
  market_asset_price_alerts_include_email BOOLEAN DEFAULT false NOT NULL,
  market_asset_price_alerts_include_sms BOOLEAN DEFAULT false NOT NULL,
  market_asset_price_alert_sensitivity SMALLINT DEFAULT 1 NOT NULL,
  -- Daily digest
  daily_digest_time INTEGER,
  daily_digest_next_send_at TIMESTAMP WITH TIME ZONE,
  last_grok_rumors_at TIMESTAMP WITH TIME ZONE,
  daily_digest_include_news_email BOOLEAN DEFAULT false NOT NULL,
  daily_digest_include_rumors_email BOOLEAN DEFAULT false NOT NULL,
  grok_window_start TIMESTAMP WITH TIME ZONE,
  grok_sends_in_window INTEGER DEFAULT 0 NOT NULL,
  -- Asset events
  asset_events_include_earnings_email BOOLEAN DEFAULT false NOT NULL,
  asset_events_include_earnings_sms BOOLEAN DEFAULT false NOT NULL,
  asset_events_include_dividends_email BOOLEAN DEFAULT false NOT NULL,
  asset_events_include_dividends_sms BOOLEAN DEFAULT false NOT NULL,
  asset_events_include_splits_email BOOLEAN DEFAULT false NOT NULL,
  asset_events_include_splits_sms BOOLEAN DEFAULT false NOT NULL,
  asset_events_include_analyst_email BOOLEAN DEFAULT false NOT NULL,
  asset_events_include_analyst_sms BOOLEAN DEFAULT false NOT NULL,
  asset_events_include_insider_email BOOLEAN DEFAULT false NOT NULL,
  asset_events_include_insider_sms BOOLEAN DEFAULT false NOT NULL,
  asset_events_next_send_at TIMESTAMP WITH TIME ZONE,
  asset_events_last_analyst_sent_month TEXT,
  -- Channel enablement
  email_notifications_enabled BOOLEAN DEFAULT false NOT NULL,
  sms_notifications_enabled BOOLEAN DEFAULT false NOT NULL,
  sms_opted_out BOOLEAN DEFAULT false NOT NULL,
  -- Display preferences
  dismiss_timezone_mismatch_prompts BOOLEAN DEFAULT false NOT NULL,
  show_change_percent BOOLEAN DEFAULT false NOT NULL,
  show_company_name BOOLEAN DEFAULT true NOT NULL,
  detailed_format BOOLEAN DEFAULT true NOT NULL,
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  -- Constraints
  CONSTRAINT phone_country_code_format CHECK (phone_country_code ~ '^\+[0-9]{1,4}$'),
  CONSTRAINT phone_number_format CHECK (phone_number ~ '^[0-9]{10,14}$'),
  CONSTRAINT unique_phone UNIQUE (phone_country_code, phone_number),
  CONSTRAINT phone_fields_together CHECK (
    (phone_country_code IS NULL AND phone_number IS NULL) OR
    (phone_country_code IS NOT NULL AND phone_number IS NOT NULL)
  ),
  CONSTRAINT users_sms_requires_phone CHECK (
    sms_notifications_enabled = false OR
    (phone_country_code IS NOT NULL AND phone_number IS NOT NULL)
  ),
  CONSTRAINT users_sms_opted_out_blocks_sms_enabled CHECK (
    NOT (sms_opted_out AND sms_notifications_enabled)
  ),
  CONSTRAINT users_phone_verified_requires_phone CHECK (
    NOT phone_verified OR
    (phone_country_code IS NOT NULL AND phone_number IS NOT NULL)
  ),
  CONSTRAINT users_email_no_whitespace CHECK (public.has_no_whitespace(email)),
  CONSTRAINT users_email_non_empty CHECK (email <> ''),
  CONSTRAINT users_timezone_no_whitespace CHECK (public.has_no_whitespace(timezone)),
  CONSTRAINT users_phone_country_code_no_whitespace CHECK (public.has_no_whitespace(phone_country_code)),
  CONSTRAINT users_phone_number_no_whitespace CHECK (public.has_no_whitespace(phone_number)),
  CONSTRAINT users_daily_digest_time_range CHECK (
    daily_digest_time IS NULL OR (
      daily_digest_time >= 0 AND daily_digest_time <= 1439
    )
  ),
  CONSTRAINT users_market_scheduled_asset_price_times_check CHECK (
    public.is_valid_market_scheduled_asset_price_times(market_scheduled_asset_price_times)
  )
);

/* =============
Assets
============= */

CREATE TABLE assets (
  symbol VARCHAR(10) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  type TEXT NOT NULL DEFAULT 'stock' CHECK (type IN ('stock', 'etf')),
  CONSTRAINT assets_symbol_no_whitespace CHECK (public.has_no_whitespace(symbol))
);

/* =============
User Assets Junction
============= */

CREATE TABLE user_assets (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol VARCHAR(10) NOT NULL REFERENCES assets(symbol) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  PRIMARY KEY (user_id, symbol)
);

/* =============
Replace User Assets
============= */

CREATE OR REPLACE FUNCTION public.replace_user_assets(
  user_id uuid,
  symbols text[]
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  sanitized_symbols text[];
  sanitized_count integer;
  symbol_with_whitespace text;
  symbol_not_uppercase text;
  duplicate_symbol text;
BEGIN
  DELETE FROM user_assets WHERE user_assets.user_id = replace_user_assets.user_id;

  IF symbols IS NULL OR array_length(symbols, 1) IS NULL THEN
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
END;
$$;

GRANT EXECUTE ON FUNCTION public.replace_user_assets(uuid, text[]) TO authenticated, service_role;

/* =============
Notification Log
============= */

CREATE TABLE notification_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  delivery_method public.delivery_method NOT NULL,
  message_delivered BOOLEAN DEFAULT true NOT NULL,
  message TEXT,
  error TEXT,
  error_code VARCHAR(50),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

/* =============
Scheduled Notifications
============= */

CREATE TABLE scheduled_notifications (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type public.scheduled_notification_type NOT NULL,
  scheduled_date DATE NOT NULL,
  scheduled_minutes INTEGER NOT NULL CHECK (
    scheduled_minutes >= 0
    AND scheduled_minutes <= 1439
  ),
  channel public.delivery_method NOT NULL,
  status public.scheduled_notification_status NOT NULL,
  attempt_count INTEGER DEFAULT 0 NOT NULL CHECK (attempt_count >= 0),
  last_attempt_at TIMESTAMP WITH TIME ZONE,
  sent_at TIMESTAMP WITH TIME ZONE,
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  PRIMARY KEY (user_id, notification_type, scheduled_date, scheduled_minutes, channel)
);

/* =============
Indexes
============= */

CREATE INDEX idx_users_market_scheduled_asset_price_next_send_at
  ON users (market_scheduled_asset_price_next_send_at)
  WHERE market_scheduled_asset_price_enabled = true
    AND market_scheduled_asset_price_next_send_at IS NOT NULL;

CREATE INDEX idx_users_daily_digest_next_send_at
  ON users (daily_digest_next_send_at)
  WHERE daily_digest_time IS NOT NULL
    AND daily_digest_next_send_at IS NOT NULL;

CREATE INDEX idx_assets_symbol_trgm
  ON public.assets USING gin (symbol gin_trgm_ops);

CREATE INDEX idx_assets_name_trgm
  ON public.assets USING gin (name gin_trgm_ops);

/* =============
Scheduled Notifications Claim
============= */

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
    user_id,
    notification_type,
    scheduled_date,
    scheduled_minutes,
    channel,
    status,
    attempt_count,
    last_attempt_at,
    error
  )
  VALUES (
    p_user_id,
    p_notification_type,
    p_scheduled_date,
    p_scheduled_minutes,
    p_channel,
    'sending',
    1,
    pg_catalog.now(),
    NULL
  )
  ON CONFLICT (user_id, notification_type, scheduled_date, scheduled_minutes, channel) DO UPDATE
    SET status = 'sending',
        attempt_count = scheduled_notifications.attempt_count + 1,
        last_attempt_at = pg_catalog.now(),
        error = NULL
    WHERE scheduled_notifications.status <> 'sent'
      AND scheduled_notifications.attempt_count < 3
      AND (
        scheduled_notifications.status = 'failed'
        OR (
          -- Re-claim stale 'sending' records (likely from crashed workers)
          -- 10 minutes provides a reasonable balance: long enough to avoid premature
          -- re-claiming during normal processing, short enough to recover quickly
          scheduled_notifications.status = 'sending'
          AND scheduled_notifications.last_attempt_at < pg_catalog.now() - interval '10 minutes'
        )
      )
  RETURNING true INTO claimed;

  RETURN COALESCE(claimed, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_scheduled_notification(
  uuid,
  public.scheduled_notification_type,
  date,
  integer,
  public.delivery_method
) TO service_role;

/* =============
Rate Limiting
============= */

CREATE TABLE rate_limit_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_rate_limit_log_user_endpoint_created
  ON rate_limit_log (user_id, endpoint, created_at DESC);

CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_user_id uuid,
  p_endpoint text,
  p_max_requests integer,
  p_window_minutes integer
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
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

GRANT EXECUTE ON FUNCTION public.check_rate_limit(uuid, text, integer, integer) TO authenticated, service_role;

/* =============
SMS Verification Cooldown Reservation
============= */

CREATE OR REPLACE FUNCTION public.reserve_sms_verification(
  p_user_id uuid,
  p_phone_country_code text,
  p_phone_number text,
  p_cooldown_ms integer
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
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
    sms_notifications_enabled = true,
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

GRANT EXECUTE ON FUNCTION public.reserve_sms_verification(uuid, text, text, integer) TO authenticated, service_role;

/* =============
SMS Verification Cooldown Reservation Rollback
============= */

CREATE OR REPLACE FUNCTION public.rollback_sms_verification_reservation(
  p_user_id uuid,
  p_expected_verification_sent_at timestamptz,
  p_restore_verification_sent_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
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

GRANT EXECUTE ON FUNCTION public.rollback_sms_verification_reservation(uuid, timestamptz, timestamptz) TO authenticated, service_role;

/* =============
Asset Snapshots (rolling window for asset price alerts)
============= */

CREATE TABLE asset_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol VARCHAR(10) NOT NULL REFERENCES assets(symbol) ON DELETE CASCADE,
  price NUMERIC(12,4) NOT NULL,
  change_percent NUMERIC(8,4) NOT NULL,
  day_high NUMERIC(12,4),
  day_low NUMERIC(12,4),
  day_open NUMERIC(12,4),
  prev_close NUMERIC(12,4),
  volume NUMERIC(16,0),
  captured_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_asset_snapshots_symbol_captured ON public.asset_snapshots (symbol, captured_at DESC);
CREATE INDEX idx_asset_snapshots_captured_at ON public.asset_snapshots (captured_at);

ALTER TABLE public.asset_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.asset_snapshots FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.asset_snapshots TO service_role;

CREATE OR REPLACE FUNCTION public.purge_old_asset_snapshots(p_retention_minutes integer DEFAULT 60)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE deleted_count integer;
BEGIN
  DELETE FROM asset_snapshots WHERE captured_at < NOW() - (p_retention_minutes || ' minutes')::interval;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_old_asset_snapshots(integer) TO service_role;

/* =============
Asset Price Alert Cooldowns
============= */

CREATE TABLE market_asset_price_alert_cooldowns (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol VARCHAR(10) NOT NULL REFERENCES assets(symbol) ON DELETE CASCADE,
  last_alerted_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  PRIMARY KEY (user_id, symbol)
);

ALTER TABLE public.market_asset_price_alert_cooldowns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.market_asset_price_alert_cooldowns FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.market_asset_price_alert_cooldowns TO service_role;

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
  IF p_cooldown_minutes IS NULL OR p_cooldown_minutes <= 0 THEN
    RAISE EXCEPTION 'invalid cooldown parameter: p_cooldown_minutes must be > 0'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

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

/* =============
Asset Events
============= */

CREATE TABLE asset_events (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  symbol text NOT NULL REFERENCES assets(symbol),
  event_type asset_event_type NOT NULL,
  event_date date NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  week_of date NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, event_type, event_date, week_of)
);

CREATE INDEX idx_asset_events_week_of ON asset_events (week_of);

ALTER TABLE asset_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.asset_events TO service_role;

/* =============
Row Level Security - Rate Limit Log
============= */

ALTER TABLE rate_limit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own rate limit records" ON rate_limit_log
  FOR ALL
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- Allows RPCs (e.g. check_rate_limit) to write, while RLS enforces per-user access.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rate_limit_log TO authenticated, service_role;

/* =============
Row Level Security - Users
============= */

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile" ON users
  FOR SELECT USING ((SELECT auth.uid()) = id);

CREATE POLICY "Users can insert own profile" ON users
  FOR INSERT WITH CHECK ((SELECT auth.uid()) = id);

CREATE POLICY "Users can update own profile" ON users
  FOR UPDATE
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

CREATE POLICY "Users can delete own profile" ON users
  FOR DELETE USING ((SELECT auth.uid()) = id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.users TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.users TO service_role;

/* =============
Row Level Security - User Assets
============= */

ALTER TABLE user_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own assets" ON user_assets
  FOR SELECT USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can insert own assets" ON user_assets
  FOR INSERT WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own assets" ON user_assets
  FOR DELETE USING ((SELECT auth.uid()) = user_id);

GRANT SELECT, INSERT, DELETE ON TABLE public.user_assets TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.user_assets TO service_role;

/* =============
Row Level Security - Assets (Public Read)
============= */

ALTER TABLE assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view assets" ON assets
  FOR SELECT USING (true);

GRANT SELECT ON TABLE public.assets TO anon, authenticated;
GRANT SELECT ON TABLE public.assets TO service_role;

/* =============
Row Level Security - Notification Log
============= */

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own notifications" ON notification_log
  FOR SELECT USING ((SELECT auth.uid()) = user_id);

GRANT SELECT ON TABLE public.notification_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notification_log TO service_role;

/* =============
Row Level Security - Scheduled Notifications
============= */

/* Service-role only: notification scheduler tasks, no user-level access needed */
ALTER TABLE scheduled_notifications ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.scheduled_notifications TO service_role;

/* =============
Triggers
============= */

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = pg_catalog.now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_notification_log_updated_at
  BEFORE UPDATE ON notification_log
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_scheduled_notifications_updated_at
  BEFORE UPDATE ON scheduled_notifications
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

/* =============
Auth User Cascade Delete
============= */

-- When an auth user is deleted, automatically delete the corresponding
-- public.users row (which cascades to all child tables).
CREATE OR REPLACE FUNCTION public.handle_auth_user_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.users WHERE id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER on_auth_user_deleted
  AFTER DELETE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_auth_user_deleted();
