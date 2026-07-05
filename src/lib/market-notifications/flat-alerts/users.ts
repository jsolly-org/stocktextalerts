import type { SupabaseAdminClient } from "../../db/supabase";
import { rootLogger } from "../../logging";
import { attachPrefsToUsers } from "../../messaging/load-prefs";
import type { PrefRow } from "../../types";

/** Minimal user shape for flat price alert delivery across email + Telegram. */
export interface FlatPriceAlertUser {
	id: string;
	email: string;
	email_notifications_enabled: boolean;
	use_24_hour_time: boolean;
	/** Linked Telegram chat (null when never linked); gates the Telegram delivery branch. */
	telegram_chat_id: number | null;
	/** True after a verified outbound 403 ("bot blocked"); suppresses Telegram delivery. */
	telegram_opted_out: boolean;
	/** Per-option channel preferences (single source of truth for all channels). */
	prefs: PrefRow[];
}

/**
 * Fetch users who have at least one flat-price-alert channel enabled.
 * Per-channel gates (global email unsub, Telegram opt-out) and the
 * per-option `price_move_alerts` facet are enforced in `deliverFlatPriceAlert`.
 *
 * The per-option prefs now live in `notification_preferences`, which PostgREST
 * can't filter against the `users` table in one query, so the candidate set is
 * gated by channel-level columns only (email global enable / Telegram linked);
 * prefs are loaded in a batch and the delivery loop filters.
 */
export async function fetchFlatPriceAlertUsers(
	supabase: SupabaseAdminClient,
): Promise<FlatPriceAlertUser[]> {
	const { data, error } = await supabase
		.from("users")
		.select(
			"id, email, email_notifications_enabled, use_24_hour_time, telegram_chat_id, telegram_opted_out",
		)
		// Candidate pre-filter on channel-level columns only: a usable email channel
		// or a linked Telegram chat. The per-option price_move_alerts facet is checked
		// in the delivery loop.
		.or("email_notifications_enabled.eq.true,telegram_chat_id.not.is.null");

	if (error) {
		rootLogger.error(
			"Failed to fetch flat price alert users",
			{ action: "fetch_flat_price_alert_users" },
			error,
		);
		return [];
	}

	return attachPrefsToUsers(supabase, data ?? []);
}
