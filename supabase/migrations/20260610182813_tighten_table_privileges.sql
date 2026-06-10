-- Tighten public table/sequence/schema privileges to match hosted production,
-- completing what 20260608180652_tighten_function_privileges did for functions.
--
-- Background: the 2026-05 squash baseline was generated from LOCAL (already
-- widened by broad `ALTER DEFAULT PRIVILEGES`) and was only bookkeeping-repaired
-- into prod, so its `GRANT ALL ... TO anon, authenticated, service_role` lines
-- never executed there. A 2026-06-10 read-only catalog audit of prod (verified
-- twice: pg dump over DATABASE_URL_PROD + Supabase MCP) found prod has ZERO
-- default ACLs on `public` and a narrow curated grant set per table, while
-- local grants ALL on every table to all three client roles. That asymmetry is
-- the duplicate-SMS incident class: code passes locally, permission-denied in
-- prod. This migration is a near-no-op in prod (REVOKE then re-GRANT prod's
-- exact current grants, in one transaction) and converges local to prod.
--
-- Out of scope (cannot be fixed by a postgres-run migration; documented in
-- docs/local-supabase.md): supabase_admin-owned default ACLs and pg_trgm
-- extension-function grants that exist only in the local image. Both are
-- semantically inert for app objects.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- 1. Kill the drift engine: empty out postgres-role default privileges in
-- `public` so FUTURE tables/sequences require explicit grants (prod parity).
-- Functions were already revoked for client roles in 20260608180652; the
-- remaining postgres self-grant row is cleared here for an exactly-empty set.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM postgres, PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM postgres, PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM postgres;

-- 2. Normalize every existing table to prod's exact grant set.

-- 2a. Server-only tables: service_role full DML.
REVOKE ALL ON TABLE public.asset_events FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.asset_events TO service_role;

REVOKE ALL ON TABLE public.daily_asset_stats FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.daily_asset_stats TO service_role;

REVOKE ALL ON TABLE public.market_asset_price_alert_cooldowns FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.market_asset_price_alert_cooldowns TO service_role;

REVOKE ALL ON TABLE public.market_events FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.market_events TO service_role;

REVOKE ALL ON TABLE public.scheduled_notifications FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.scheduled_notifications TO service_role;

REVOKE ALL ON TABLE public.staged_notifications FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.staged_notifications TO service_role;

-- 2b. Server-only tables: service_role full privileges (prod grants ALL).
REVOKE ALL ON TABLE public.asset_analyst_consensus FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.asset_analyst_consensus TO service_role;

REVOKE ALL ON TABLE public.asset_daily_closes FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.asset_daily_closes TO service_role;

REVOKE ALL ON TABLE public.asset_insider_transactions FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.asset_insider_transactions TO service_role;

REVOKE ALL ON TABLE public.asset_price_history FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.asset_price_history TO service_role;

-- 2c. Server-only tables: deliberately partial service_role DML.
REVOKE ALL ON TABLE public.app_metadata FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.app_metadata TO service_role;

REVOKE ALL ON TABLE public.asset_snapshots FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, SELECT ON TABLE public.asset_snapshots TO service_role;

REVOKE ALL ON TABLE public.short_urls FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, SELECT ON TABLE public.short_urls TO service_role;

-- 2d. Client-visible tables.
REVOKE ALL ON TABLE public.assets FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.assets TO anon, authenticated;
GRANT SELECT, UPDATE ON TABLE public.assets TO service_role;

REVOKE ALL ON TABLE public.timezones FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.timezones TO anon, authenticated;

REVOKE ALL ON TABLE public.notification_log FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.notification_log TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.notification_log TO service_role;

REVOKE ALL ON TABLE public.price_move_alert_state FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, SELECT ON TABLE public.price_move_alert_state TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.price_move_alert_state TO service_role;

REVOKE ALL ON TABLE public.price_targets FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.price_targets TO authenticated, service_role;

REVOKE ALL ON TABLE public.rate_limit_log FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.rate_limit_log TO authenticated, service_role;

REVOKE ALL ON TABLE public.user_assets FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, SELECT ON TABLE public.user_assets TO authenticated, service_role;

REVOKE ALL ON TABLE public.users FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.users TO authenticated, service_role;

-- 3. Sequences. asset_events/market_events ids are identity columns (no grant
-- needed to insert); the consensus/insider sequences keep service_role access
-- as granted by their creating migration (20260601191106).
REVOKE ALL ON SEQUENCE public.asset_analyst_consensus_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, UPDATE, USAGE ON SEQUENCE public.asset_analyst_consensus_id_seq TO service_role;

REVOKE ALL ON SEQUENCE public.asset_insider_transactions_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, UPDATE, USAGE ON SEQUENCE public.asset_insider_transactions_id_seq TO service_role;

REVOKE ALL ON SEQUENCE public.asset_events_id_seq FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.market_events_id_seq FROM PUBLIC, anon, authenticated, service_role;

-- 4. Drop redundant explicit grants on trigger/check functions that local
-- default ACLs stamped at creation (prod has only the implicit PUBLIC EXECUTE,
-- which stays). is_approved keeps its explicit authenticated/service_role
-- grants — prod has them.
REVOKE EXECUTE ON FUNCTION public.handle_auth_user_deleted() FROM anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.has_no_whitespace(text) FROM anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_valid_market_scheduled_asset_price_times(integer[]) FROM anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.prevent_user_approval_self_change() FROM anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_approved() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_approved() TO authenticated, service_role;

-- 5. Prod's `public` schema has no PUBLIC USAGE; client roles keep their
-- explicit USAGE grants.
REVOKE USAGE ON SCHEMA public FROM PUBLIC;

UPDATE public.app_metadata
SET value = '20260610182813_tighten_table_privileges'
WHERE key = 'schema_version';
