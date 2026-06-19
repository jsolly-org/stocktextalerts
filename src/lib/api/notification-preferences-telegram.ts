import type { AppSupabaseClient } from "../db/supabase";
import type { Logger } from "../logging";

/* =============
Telegram notification-preference persistence.

Telegram has NO legacy `*_telegram` columns on `users` — its per-option prefs live
ONLY in the `notification_preferences` table (channel = 'telegram'), one row per
(user_id, notification_type, content, channel). The dashboard submits a Telegram
selection as a `*_telegram` boolean form field mirroring the existing
`*_email`/`*_sms` field naming; each submitted field upserts (enable=true/false)
the matching row.

Scope (v1): persist Telegram prefs only. Email/SMS still read from the legacy
`*_include_{email,sms}` columns, so we do NOT also mirror email/sms selections into
this table here — that table-sync is a documented Phase-2 follow-up (see
docs/plans/2026-06-19-telegram-native-channel.md §6). Only Telegram rows are written.
============= */

/** A submitted Telegram form field mapped to its (notification_type, content) row key. */
interface TelegramPreferenceTarget {
	notification_type: string;
	/** Content facet; "" for facet-less notification types. */
	content: string;
}

/**
 * Form-field name → (notification_type, content) for every Telegram-capable option.
 *
 * Mirrors the `*_email`/`*_sms` field naming with a `_telegram` suffix. Facet-less
 * types use the no-content key (content = ""). Per product decision, Telegram is
 * offered on EVERY option — including daily_digest news/rumors, which are email-only
 * on the legacy columns but allowed as Telegram rows here.
 */
const TELEGRAM_PREFERENCE_FIELD_MAP = {
	daily_digest_include_prices_telegram: {
		notification_type: "daily_digest",
		content: "prices",
	},
	daily_digest_include_news_telegram: {
		notification_type: "daily_digest",
		content: "news",
	},
	daily_digest_include_rumors_telegram: {
		notification_type: "daily_digest",
		content: "rumors",
	},
	daily_digest_include_top_movers_telegram: {
		notification_type: "daily_digest",
		content: "top_movers",
	},
	asset_events_include_analyst_telegram: {
		notification_type: "asset_events",
		content: "analyst",
	},
	asset_events_include_calendar_telegram: {
		notification_type: "asset_events",
		content: "calendar",
	},
	asset_events_include_insider_telegram: {
		notification_type: "asset_events",
		content: "insider",
	},
	asset_events_include_ipo_telegram: {
		notification_type: "asset_events",
		content: "ipo",
	},
	market_asset_price_alerts_include_telegram: {
		notification_type: "market_asset_price_alerts",
		content: "",
	},
	market_scheduled_asset_price_include_telegram: {
		notification_type: "market_scheduled_asset_price",
		content: "",
	},
	price_move_alerts_include_telegram: {
		notification_type: "price_move_alerts",
		content: "",
	},
	price_targets_include_telegram: {
		notification_type: "price_targets",
		content: "",
	},
} as const satisfies Record<string, TelegramPreferenceTarget>;

/** Every `*_telegram` form-field name handled by the update endpoint. */
type TelegramPreferenceFieldName = keyof typeof TELEGRAM_PREFERENCE_FIELD_MAP;

const TELEGRAM_PREFERENCE_FIELD_NAMES = Object.keys(
	TELEGRAM_PREFERENCE_FIELD_MAP,
) as TelegramPreferenceFieldName[];

/**
 * Upsert `notification_preferences` rows for the Telegram selections in this submission.
 *
 * Only fields actually present in the form are written (no-drift: an unsubmitted option
 * leaves its existing row untouched), matching the legacy column endpoint's behavior.
 * Each submitted field upserts a row with channel='telegram' and enabled set to the
 * submitted boolean, so both enabling and disabling persist.
 *
 * `supabase` must be the request's session-scoped client (authed via getCurrentUser);
 * RLS allows the user to write only their own rows (user_id = auth.uid()).
 *
 * Throws if the upsert fails so the caller can surface a 500 — there is no recovery path.
 */
export async function persistTelegramPreferences(options: {
	supabase: AppSupabaseClient;
	userId: string;
	parsedData: Partial<Record<TelegramPreferenceFieldName, boolean>>;
	formData: FormData;
	logger?: Logger;
}): Promise<void> {
	const { supabase, userId, parsedData, formData, logger } = options;

	const rows = TELEGRAM_PREFERENCE_FIELD_NAMES.flatMap((field) => {
		const value = parsedData[field];
		// Only persist fields the form actually submitted (no-drift parity with the
		// legacy `*_email`/`*_sms` column writes).
		if (!formData.has(field) || value === undefined) {
			return [];
		}
		const target = TELEGRAM_PREFERENCE_FIELD_MAP[field];
		return [
			{
				user_id: userId,
				notification_type: target.notification_type,
				content: target.content,
				channel: "telegram" as const,
				enabled: value,
				updated_at: new Date().toISOString(),
			},
		];
	});

	if (rows.length === 0) {
		return;
	}

	const { error } = await supabase
		.from("notification_preferences")
		.upsert(rows, { onConflict: "user_id,notification_type,content,channel" });

	if (error) {
		logger?.error(
			"Failed to upsert Telegram notification preferences",
			{ userId, fieldCount: rows.length },
			error,
		);
		throw error;
	}
}
