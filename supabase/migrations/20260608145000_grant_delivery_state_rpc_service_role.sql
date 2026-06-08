-- Grant service_role execute on delivery-state RPCs introduced in
-- 20260607151019_delivery_state_reliability. That migration revoked PUBLIC
-- but omitted explicit service_role grants; hosted Supabase does not inherit
-- default privileges the way local db:reset does.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

GRANT ALL ON FUNCTION public.reserve_market_asset_price_alert_slot(uuid, text, numeric, numeric) TO service_role;
GRANT ALL ON FUNCTION public.finalize_market_asset_price_alert_slot(uuid, text) TO service_role;
GRANT ALL ON FUNCTION public.release_market_asset_price_alert_slot(uuid, text) TO service_role;
GRANT ALL ON FUNCTION public.reserve_flat_price_alert(uuid, text, numeric, numeric, numeric) TO service_role;
GRANT ALL ON FUNCTION public.finalize_flat_price_alert(uuid, text) TO service_role;
GRANT ALL ON FUNCTION public.release_flat_price_alert(uuid, text) TO service_role;

UPDATE public.app_metadata
SET value = '20260608145000_grant_delivery_state_rpc_service_role'
WHERE key = 'schema_version';
