-- Grant service_role permission to execute purge_expired_short_urls.
-- The cron job (schedule/index.ts) uses the admin client (service_role) to call this RPC;
-- without this grant, the call would fail with permission denied.
-- Only service_role can execute; anon and authenticated have no table access and no execute.
-- Revoke PUBLIC's default EXECUTE so only service_role retains it.
REVOKE EXECUTE ON FUNCTION public.purge_expired_short_urls() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_expired_short_urls() TO service_role;

-- Update schema version for test infrastructure.
UPDATE public.app_metadata
  SET value = '20260305140000_grant_purge_expired_short_urls_to_service_role'
  WHERE key = 'schema_version';
