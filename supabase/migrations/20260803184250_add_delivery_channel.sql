-- squawk-ignore-file constraint-missing-not-valid
-- Expand phase: add users.delivery_channel alongside legacy flags.
-- Keep email_notifications_enabled / telegram_opted_out and channel-keyed prefs.
-- A BEFORE trigger keeps delivery_channel warm from legacy writes so old web
-- (pre dual-write) stays correct after this migration lands via Deploy.
-- Contract phase (later PR) flattens prefs and drops the legacy columns.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TYPE public.delivery_channel_mode AS ENUM ('email', 'telegram', 'disabled');
ALTER TYPE public.delivery_channel_mode OWNER TO postgres;

ALTER TABLE public.users
	ADD COLUMN delivery_channel public.delivery_channel_mode NOT NULL DEFAULT 'email';

ALTER TABLE public.users
	ADD CONSTRAINT users_delivery_channel_telegram_requires_chat
	CHECK (
		delivery_channel <> 'telegram'::public.delivery_channel_mode
		OR telegram_chat_id IS NOT NULL
	);

UPDATE public.users
SET delivery_channel = CASE
	WHEN telegram_chat_id IS NOT NULL AND telegram_opted_out = false
		THEN 'telegram'::public.delivery_channel_mode
	WHEN email_notifications_enabled
		THEN 'email'::public.delivery_channel_mode
	ELSE 'disabled'::public.delivery_channel_mode
END;

CREATE OR REPLACE FUNCTION public.sync_users_delivery_channel_from_legacy()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
	NEW.delivery_channel := CASE
		WHEN NEW.telegram_chat_id IS NOT NULL AND NEW.telegram_opted_out = false
			THEN 'telegram'::public.delivery_channel_mode
		WHEN NEW.email_notifications_enabled
			THEN 'email'::public.delivery_channel_mode
		ELSE 'disabled'::public.delivery_channel_mode
	END;
	RETURN NEW;
END;
$$;

ALTER FUNCTION public.sync_users_delivery_channel_from_legacy() OWNER TO postgres;

CREATE TRIGGER users_sync_delivery_channel_from_legacy
	BEFORE INSERT OR UPDATE OF email_notifications_enabled, telegram_opted_out, telegram_chat_id
	ON public.users
	FOR EACH ROW
	EXECUTE FUNCTION public.sync_users_delivery_channel_from_legacy();

UPDATE public.app_metadata
SET value = '20260803184250_add_delivery_channel'
WHERE key = 'schema_version';
