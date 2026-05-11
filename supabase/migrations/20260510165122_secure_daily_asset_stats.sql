-- daily_asset_stats was the only public-schema table without RLS, and it
-- carried the default Supabase grants of ALL privileges to anon and
-- authenticated. The cron Lambdas write it via service_role (which bypasses
-- RLS) and server-side code reads it; client roles have no business touching
-- it directly. Enable RLS so anon/authenticated are denied by default.
--
-- service_role bypasses RLS, so existing handler writes/reads continue to
-- work without any policy.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.daily_asset_stats ENABLE ROW LEVEL SECURITY;

UPDATE public.app_metadata
   SET value = '20260510165122_secure_daily_asset_stats'
 WHERE key = 'schema_version';
