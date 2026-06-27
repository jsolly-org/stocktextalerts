-- squawk-ignore-file changing-column-type
-- Convert CHECK-constrained text columns to Postgres enums so generated types narrow at the source.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TYPE public.asset_type AS ENUM ('stock', 'etf');
CREATE TYPE public.price_target_direction AS ENUM ('above', 'below');
CREATE TYPE public.alert_move_size AS ENUM ('significant', 'extreme');
CREATE TYPE public.price_alert_delivery_status AS ENUM ('reserved', 'finalized');
CREATE TYPE public.staged_notification_type AS ENUM ('daily');

ALTER TYPE public.asset_type OWNER TO postgres;
ALTER TYPE public.price_target_direction OWNER TO postgres;
ALTER TYPE public.alert_move_size OWNER TO postgres;
ALTER TYPE public.price_alert_delivery_status OWNER TO postgres;
ALTER TYPE public.staged_notification_type OWNER TO postgres;

-- Drop legacy staged rows (market alerts no longer use staged_notifications).
DELETE FROM public.staged_notifications
WHERE notification_type = 'market';

ALTER TABLE public.assets DROP CONSTRAINT assets_type_check;
ALTER TABLE public.assets
  ALTER COLUMN type DROP DEFAULT,
  ALTER COLUMN type TYPE public.asset_type USING type::public.asset_type;
ALTER TABLE public.assets
  ALTER COLUMN type SET DEFAULT 'stock'::public.asset_type;

ALTER TABLE public.price_targets DROP CONSTRAINT price_targets_direction_check;
ALTER TABLE public.price_targets
  ALTER COLUMN direction TYPE public.price_target_direction
    USING direction::public.price_target_direction;

ALTER TABLE public.users DROP CONSTRAINT users_market_asset_price_alert_move_size_check;
ALTER TABLE public.users
  ALTER COLUMN market_asset_price_alert_move_size DROP DEFAULT,
  ALTER COLUMN market_asset_price_alert_move_size TYPE public.alert_move_size
    USING market_asset_price_alert_move_size::public.alert_move_size;
ALTER TABLE public.users
  ALTER COLUMN market_asset_price_alert_move_size SET DEFAULT 'extreme'::public.alert_move_size;

ALTER TABLE public.market_asset_price_alert_cooldowns
  ALTER COLUMN delivery_status DROP DEFAULT,
  ALTER COLUMN delivery_status TYPE public.price_alert_delivery_status
    USING delivery_status::public.price_alert_delivery_status;
ALTER TABLE public.market_asset_price_alert_cooldowns
  ALTER COLUMN delivery_status SET DEFAULT 'finalized'::public.price_alert_delivery_status;

ALTER TABLE public.staged_notifications DROP CONSTRAINT staged_notifications_notification_type_check;
ALTER TABLE public.staged_notifications
  ALTER COLUMN notification_type TYPE public.staged_notification_type
    USING notification_type::public.staged_notification_type;

UPDATE public.app_metadata
SET value = '20260626173000_domain_check_columns_to_enums'
WHERE key = 'schema_version';
