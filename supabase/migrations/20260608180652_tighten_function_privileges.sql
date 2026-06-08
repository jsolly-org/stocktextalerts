-- Tighten public function privileges to match hosted production and prevent a
-- repeat of the duplicate-SMS incident (a server-only RPC shipped without a
-- service_role EXECUTE grant; local broad defaults hid it).
--
-- Two changes:
--   1. Stop FUTURE functions (created by `postgres`) from auto-granting EXECUTE
--      to client roles. Hosted prod has empty `public` default privileges; the
--      squashed baseline re-granted ALL locally, so new RPCs were callable by
--      everyone in tests but required explicit grants in prod.
--   2. Normalize EXECUTE on every app-called RPC to its intended roles only,
--      mirroring scripts/db/privilege-contract.ts:
--        - server-only RPCs        -> service_role
--        - authenticated-client    -> authenticated, service_role
--        - legacy claim_* RPCs     -> service_role (no client access)
--
-- App functions are owned by `postgres`, so only `postgres` default privileges
-- govern them. `supabase_admin` defaults (extensions) are Supabase-managed and
-- left untouched. Tables/sequences are intentionally out of scope here.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- 1. Future functions require explicit grants (prod parity).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;

-- 2. Normalize current app-called RPC grants.

-- 2a. Server-only delivery-state RPCs (Schedule Lambda).
REVOKE ALL ON FUNCTION public.reserve_flat_price_alert(uuid, text, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_flat_price_alert(uuid, text, numeric, numeric, numeric) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_flat_price_alert(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_flat_price_alert(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.release_flat_price_alert(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_flat_price_alert(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.reserve_market_asset_price_alert_slot(uuid, text, numeric, numeric) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_market_asset_price_alert_slot(uuid, text, numeric, numeric) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_market_asset_price_alert_slot(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_market_asset_price_alert_slot(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.release_market_asset_price_alert_slot(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_market_asset_price_alert_slot(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.claim_scheduled_notification(uuid, public.scheduled_notification_type, date, integer, public.delivery_method) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_scheduled_notification(uuid, public.scheduled_notification_type, date, integer, public.delivery_method) TO service_role;

-- 2b. Server-only maintenance / purge RPCs.
REVOKE ALL ON FUNCTION public.purge_expired_short_urls() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_expired_short_urls() TO service_role;

REVOKE ALL ON FUNCTION public.purge_old_asset_price_history(integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_old_asset_price_history(integer) TO service_role;

REVOKE ALL ON FUNCTION public.purge_old_asset_daily_closes(integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_old_asset_daily_closes(integer) TO service_role;

REVOKE ALL ON FUNCTION public.purge_old_asset_snapshots(integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_old_asset_snapshots(integer) TO service_role;

-- 2c. Server-only auth rate limiting (secret-key admin client).
REVOKE ALL ON FUNCTION public.check_rate_limit(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(uuid, text, integer, integer) TO service_role;

-- 2d. Authenticated-client RPCs (session-scoped; enforce auth.uid() internally).
REVOKE ALL ON FUNCTION public.replace_user_assets(uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.replace_user_assets(uuid, text[]) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.reserve_sms_verification(uuid, text, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_sms_verification(uuid, text, text, integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.rollback_sms_verification_reservation(uuid, timestamp with time zone, timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rollback_sms_verification_reservation(uuid, timestamp with time zone, timestamp with time zone) TO authenticated, service_role;

-- 2e. Legacy claim_* RPCs (superseded by reserve/finalize; no client access).
REVOKE ALL ON FUNCTION public.claim_flat_price_alert(uuid, text, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_flat_price_alert(uuid, text, numeric, numeric, numeric) TO service_role;

REVOKE ALL ON FUNCTION public.claim_market_asset_price_alert_slot(uuid, text, numeric, numeric) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_market_asset_price_alert_slot(uuid, text, numeric, numeric) TO service_role;

REVOKE ALL ON FUNCTION public.claim_market_asset_price_alert_trading_day(uuid, text, timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_market_asset_price_alert_trading_day(uuid, text, timestamp with time zone) TO service_role;

UPDATE public.app_metadata
SET value = '20260608180652_tighten_function_privileges'
WHERE key = 'schema_version';
