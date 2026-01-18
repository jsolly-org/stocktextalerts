/* =============
Domains and Extensions
============= */

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS pgcrypto;

/* =============
Enums for Stronger DB Types
============= */

CREATE TYPE public.delivery_method AS ENUM ('email', 'sms');

CREATE TYPE public.scheduled_notification_type AS ENUM ('daily_digest');

CREATE TYPE public.scheduled_notification_status AS ENUM ('sending', 'sent', 'failed');

/* =============
Timezones
============= */

CREATE TABLE IF NOT EXISTS timezones (
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

/* =============
Users
============= */

CREATE TABLE IF NOT EXISTS users (
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
  sms_opted_out BOOLEAN DEFAULT false NOT NULL,
  timezone TEXT DEFAULT 'America/New_York' REFERENCES timezones(value) NOT NULL,
  daily_digest_enabled BOOLEAN DEFAULT true NOT NULL,
  daily_digest_notification_time INTEGER DEFAULT 540 NOT NULL CHECK (daily_digest_notification_time >= 0 AND daily_digest_notification_time <= 1439 AND daily_digest_notification_time % 15 = 0),
  next_send_at TIMESTAMP WITH TIME ZONE,
  email_notifications_enabled BOOLEAN DEFAULT false NOT NULL,
  sms_notifications_enabled BOOLEAN DEFAULT false NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
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
  CONSTRAINT users_email_no_whitespace CHECK (email = btrim(email) AND email !~ E'\\s'),
  CONSTRAINT users_email_non_empty CHECK (email <> ''),
  CONSTRAINT users_timezone_no_whitespace CHECK (timezone = btrim(timezone)),
  CONSTRAINT users_phone_country_code_no_whitespace CHECK (phone_country_code IS NULL OR phone_country_code = btrim(phone_country_code)),
  CONSTRAINT users_phone_number_no_whitespace CHECK (phone_number IS NULL OR phone_number = btrim(phone_number))
);

/* =============
Stocks
============= */

CREATE TABLE IF NOT EXISTS stocks (
  symbol VARCHAR(10) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  exchange VARCHAR(50) NOT NULL,
  CONSTRAINT stocks_symbol_no_whitespace CHECK (symbol = btrim(symbol))
);

/* =============
User Stocks Junction
============= */

CREATE TABLE IF NOT EXISTS user_stocks (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol VARCHAR(10) NOT NULL REFERENCES stocks(symbol) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  PRIMARY KEY (user_id, symbol)
);

/* =============
Stock Functions
============= */

CREATE OR REPLACE FUNCTION public.replace_user_stocks(
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
BEGIN
  DELETE FROM user_stocks WHERE user_stocks.user_id = replace_user_stocks.user_id;

  IF symbols IS NULL OR array_length(symbols, 1) IS NULL THEN
    RETURN;
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT UPPER(TRIM(BOTH FROM entry)) AS symbol
    FROM unnest(symbols) AS raw(entry)
    WHERE TRIM(BOTH FROM entry) <> ''
  ) INTO sanitized_symbols;

  IF sanitized_symbols IS NULL OR array_length(sanitized_symbols, 1) IS NULL THEN
    RETURN;
  END IF;

  SELECT array_length(sanitized_symbols, 1) INTO sanitized_count;
  IF sanitized_count > 50 THEN
    RAISE EXCEPTION 'Tracked stocks limit exceeded'
      USING ERRCODE = 'check_violation',
        CONSTRAINT = 'user_stocks_max_limit';
  END IF;

  INSERT INTO user_stocks (user_id, symbol)
  SELECT replace_user_stocks.user_id, symbol
  FROM unnest(sanitized_symbols) AS symbol;
END;
$$;

GRANT EXECUTE ON FUNCTION public.replace_user_stocks(uuid, text[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.update_user_preferences_and_stocks(
  p_user_id uuid,
  p_symbols text[],
  p_email_notifications_enabled boolean,
  p_sms_notifications_enabled boolean,
  p_timezone text,
  p_daily_digest_enabled boolean,
  p_daily_digest_notification_time integer,
  p_next_send_at timestamp with time zone
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_symbols IS NULL THEN
    RAISE EXCEPTION 'Tracked stocks required'
      USING ERRCODE = 'check_violation',
        CONSTRAINT = 'user_stocks_required';
  END IF;

  IF NULLIF(current_setting('request.jwt.claims', true), '')::json->>'role' = 'authenticated'
     AND p_user_id <> (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'Cannot update preferences for another user';
  END IF;

  PERFORM public.replace_user_stocks(p_user_id, p_symbols);

  UPDATE public.users
  SET
    email_notifications_enabled = p_email_notifications_enabled,
    sms_notifications_enabled = p_sms_notifications_enabled,
    timezone = p_timezone,
    daily_digest_enabled = p_daily_digest_enabled,
    daily_digest_notification_time = p_daily_digest_notification_time,
    next_send_at = p_next_send_at
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_user_preferences_and_stocks(
  uuid,
  text[],
  boolean,
  boolean,
  text,
  boolean,
  integer,
  timestamp with time zone
) TO authenticated, service_role;

/* =============
Notification Log
============= */

CREATE TABLE IF NOT EXISTS notification_log (
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

CREATE TABLE IF NOT EXISTS scheduled_notifications (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type public.scheduled_notification_type NOT NULL,
  scheduled_date DATE NOT NULL,
  channel public.delivery_method NOT NULL,
  status public.scheduled_notification_status NOT NULL,
  attempt_count INTEGER DEFAULT 0 NOT NULL CHECK (attempt_count >= 0),
  last_attempt_at TIMESTAMP WITH TIME ZONE,
  sent_at TIMESTAMP WITH TIME ZONE,
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  PRIMARY KEY (user_id, notification_type, scheduled_date, channel)
);

CREATE INDEX IF NOT EXISTS idx_users_next_send_at
  ON users (next_send_at)
  WHERE daily_digest_enabled = true
    AND next_send_at IS NOT NULL;

/* =============
Scheduled Notifications Claim
============= */

CREATE OR REPLACE FUNCTION public.claim_scheduled_notification(
  p_user_id uuid,
  p_notification_type public.scheduled_notification_type,
  p_scheduled_date date,
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
    p_channel,
    'sending',
    1,
    pg_catalog.now(),
    NULL
  )
  ON CONFLICT (user_id, notification_type, scheduled_date, channel) DO UPDATE
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
  public.delivery_method
) TO service_role;

/* =============
Rate Limiting
============= */

CREATE TABLE IF NOT EXISTS rate_limit_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_log_user_endpoint_created
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

ALTER TABLE rate_limit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own rate limit records" ON rate_limit_log
  FOR ALL
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

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

/* =============
Row Level Security - User Stocks
============= */

ALTER TABLE user_stocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own stocks" ON user_stocks
  FOR SELECT USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can insert own stocks" ON user_stocks
  FOR INSERT WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own stocks" ON user_stocks
  FOR DELETE USING ((SELECT auth.uid()) = user_id);

/* =============
Row Level Security - Stocks (Public Read)
============= */

ALTER TABLE stocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view stocks" ON stocks
  FOR SELECT USING (true);

/* =============
Row Level Security - Notification Log
============= */

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own notifications" ON notification_log
  FOR SELECT USING ((SELECT auth.uid()) = user_id);

/* =============
Row Level Security - Scheduled Notifications
============= */

/* Service-role only: notification scheduler tasks, no user-level access needed */
ALTER TABLE scheduled_notifications ENABLE ROW LEVEL SECURITY;

/* =============
Timestamp Functions
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
