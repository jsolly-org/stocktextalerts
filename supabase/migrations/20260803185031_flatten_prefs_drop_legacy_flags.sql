-- squawk-ignore-file constraint-missing-not-valid,adding-foreign-key-constraint,ban-drop-column,ban-drop-table,renaming-table
-- Contract phase (after expand `20260803184250_add_delivery_channel`):
-- flatten notification_options/preferences (drop channel grain), drop legacy
-- email_notifications_enabled / telegram_opted_out, and remove the expand
-- legacy→delivery_channel sync trigger.
--
-- Requires users.delivery_channel already present (expand PR). Pref enabled
-- bits come from the winning account pipe, not bool_or across channels.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

DROP TRIGGER IF EXISTS users_sync_delivery_channel_from_legacy ON public.users;
DROP FUNCTION IF EXISTS public.sync_users_delivery_channel_from_legacy();

ALTER TABLE public.notification_preferences
	DROP CONSTRAINT notification_preferences_option_fkey;

CREATE TABLE public.notification_options_new (
	notification_type text NOT NULL,
	content text NOT NULL,
	PRIMARY KEY (notification_type, content)
);
ALTER TABLE public.notification_options_new OWNER TO postgres;
ALTER TABLE public.notification_options_new ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE public.notification_options_new TO service_role;

INSERT INTO public.notification_options_new (notification_type, content)
SELECT DISTINCT notification_type, content
FROM public.notification_options;

CREATE TABLE public.notification_preferences_new (
	user_id uuid NOT NULL,
	notification_type text NOT NULL,
	content text NOT NULL,
	enabled boolean NOT NULL DEFAULT false,
	created_at timestamp with time zone NOT NULL DEFAULT now(),
	updated_at timestamp with time zone NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, notification_type, content),
	CONSTRAINT notification_preferences_new_user_id_fkey
		FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE,
	CONSTRAINT notification_preferences_new_option_fkey
		FOREIGN KEY (notification_type, content)
		REFERENCES public.notification_options_new (notification_type, content)
		ON UPDATE CASCADE
);
ALTER TABLE public.notification_preferences_new OWNER TO postgres;
ALTER TABLE public.notification_preferences_new ENABLE ROW LEVEL SECURITY;

INSERT INTO public.notification_preferences_new (
	user_id, notification_type, content, enabled, created_at, updated_at
)
SELECT
	np.user_id,
	np.notification_type,
	np.content,
	CASE
		-- Preserve content toggles for disabled accounts (routing is separate).
		-- Prefer email grain, else telegram, else any enabled bit.
		WHEN u.delivery_channel = 'disabled'::public.delivery_channel_mode THEN coalesce(
			bool_or(np.enabled) FILTER (WHERE np.channel::text = 'email'),
			bool_or(np.enabled) FILTER (WHERE np.channel::text = 'telegram'),
			bool_or(np.enabled),
			false
		)
		-- Active pipe: prefer that grain, but fall back when expand-era accounts
		-- only have the other channel's rows (runtime collapsePreferenceRows does
		-- the same). coalesce skips NULL only — explicit all-false preferred grain stays false.
		ELSE coalesce(
			bool_or(np.enabled) FILTER (
				WHERE np.channel::text = u.delivery_channel::text
			),
			bool_or(np.enabled) FILTER (WHERE np.channel::text = 'email'),
			bool_or(np.enabled) FILTER (WHERE np.channel::text = 'telegram'),
			bool_or(np.enabled),
			false
		)
	END AS enabled,
	min(np.created_at) AS created_at,
	max(np.updated_at) AS updated_at
FROM public.notification_preferences np
JOIN public.users u ON u.id = np.user_id
GROUP BY np.user_id, np.notification_type, np.content, u.delivery_channel;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notification_preferences_new
	TO authenticated, service_role;

CREATE POLICY notification_preferences_select_own ON public.notification_preferences_new
	FOR SELECT USING (user_id = auth.uid());
CREATE POLICY notification_preferences_insert_own ON public.notification_preferences_new
	FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY notification_preferences_update_own ON public.notification_preferences_new
	FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY notification_preferences_delete_own ON public.notification_preferences_new
	FOR DELETE USING (user_id = auth.uid());

DROP TABLE public.notification_preferences;
DROP TABLE public.notification_options;

ALTER TABLE public.notification_options_new RENAME TO notification_options;
ALTER TABLE public.notification_preferences_new RENAME TO notification_preferences;

ALTER TABLE public.notification_preferences
	RENAME CONSTRAINT notification_preferences_new_user_id_fkey
	TO notification_preferences_user_id_fkey;
ALTER TABLE public.notification_preferences
	RENAME CONSTRAINT notification_preferences_new_option_fkey
	TO notification_preferences_option_fkey;

ALTER TABLE public.users DROP COLUMN email_notifications_enabled;
ALTER TABLE public.users DROP COLUMN telegram_opted_out;

UPDATE public.app_metadata
SET value = '20260803185031_flatten_prefs_drop_legacy_flags'
WHERE key = 'schema_version';
