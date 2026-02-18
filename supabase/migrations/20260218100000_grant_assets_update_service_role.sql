-- Grant UPDATE on assets to service_role only.
-- Used by sector-backfill cron and lazy sector backfill in /api/assets/prices.
-- Authenticated users retain SELECT only; sector updates are server-side only.

GRANT UPDATE ON TABLE public.assets TO service_role;
