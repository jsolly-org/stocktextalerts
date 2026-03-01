-- Fix missing permissions on short_urls table.
-- The original migration enabled RLS but did not grant access to service_role,
-- causing "permission denied" (42501) on all inserts.

REVOKE ALL ON TABLE public.short_urls FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.short_urls TO service_role;

-- Update schema version for test infrastructure.
UPDATE public.app_metadata
  SET value = '20260301050000_fix_short_urls_permissions'
  WHERE key = 'schema_version';
