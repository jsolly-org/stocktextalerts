-- squawk-ignore-file ban-drop-table,ban-drop-column
-- Remove the "Smart Price Alerts" feature (notification type
-- `market_asset_price_alerts`) end to end: the AI/anomaly notification-option
-- rows + preferences, the two anomaly-only `users` columns and their enum, the
-- anomaly support tables (asset_snapshots, daily_asset_stats,
-- market_asset_price_alert_cooldowns), and every anomaly-only RPC. The flat
-- price-move alert feature (`price_move_alerts`) is KEPT and redesigned in the
-- next migration.

set lock_timeout = '5s';
set statement_timeout = '120s';

-- 1. Drop the notification-preference rows for the removed type FIRST — the
-- notification_preferences → notification_options FK would block the catalog
-- delete otherwise.
DELETE FROM public.notification_preferences
WHERE notification_type = 'market_asset_price_alerts';

-- 2. Remove the option-catalog rows. The FK (not a CHECK) is the sole guard on
-- valid notification types, so nothing else needs tightening.
DELETE FROM public.notification_options
WHERE notification_type = 'market_asset_price_alerts';

-- 3. Drop the anomaly-only RPCs (each references a table dropped below).
DROP FUNCTION IF EXISTS public.reserve_market_asset_price_alert_slot(uuid, text, numeric, numeric);
DROP FUNCTION IF EXISTS public.finalize_market_asset_price_alert_slot(uuid, text);
DROP FUNCTION IF EXISTS public.release_market_asset_price_alert_slot(uuid, text);
DROP FUNCTION IF EXISTS public.claim_market_asset_price_alert_slot(uuid, text, numeric, numeric);
DROP FUNCTION IF EXISTS public.claim_market_asset_price_alert_trading_day(uuid, text, timestamp with time zone);
DROP FUNCTION IF EXISTS public.purge_old_asset_snapshots(integer);

-- 4. Drop the anomaly support tables. `asset_daily_closes` is deliberately NOT
-- dropped — it still backs the dashboard watchlist sparklines.
DROP TABLE IF EXISTS public.market_asset_price_alert_cooldowns;
DROP TABLE IF EXISTS public.asset_snapshots;
DROP TABLE IF EXISTS public.daily_asset_stats;

-- 5. Drop the two anomaly-only `users` columns, then the enum they used.
ALTER TABLE public.users
  DROP COLUMN IF EXISTS market_asset_price_alerts_enabled,
  DROP COLUMN IF EXISTS market_asset_price_alert_move_size;

DROP TYPE IF EXISTS public.alert_move_size;

-- 6. Drop the delivery-status enum left dangling by the cooldowns-table drop
-- (dropping a table does not cascade-drop its column's enum type).
DROP TYPE IF EXISTS public.price_alert_delivery_status;

-- 7. Drop assets.sector. It existed only so anomaly detection could pick each
-- asset's sector-ETF benchmark (and the removed move-size selector's example
-- endpoint); nothing kept reads it. The SIC→sector enrichment code goes with it.
ALTER TABLE public.assets DROP COLUMN IF EXISTS sector;
