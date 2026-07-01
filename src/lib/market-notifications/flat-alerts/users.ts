import type { SupabaseAdminClient } from "../../db/supabase";
import { rootLogger } from "../../logging";
import { attachPrefsToUsers } from "../../messaging/load-prefs";
import type { FlatPriceAlertUser } from "./types";

/**
 * Fetch users who have at least one flat-price-alert channel enabled.
 * Per-channel gates (global email unsub, verified phone, opt-out) and the
 * per-option `price_move_alerts` facet are enforced in `deliverFlatPriceAlert`.
 *
 * The per-option prefs now live in `notification_preferences`, which PostgREST
 * can't filter against the `users` table in one query, so the candidate set is
 * gated by channel-level columns only (email global enable / verified-phone SMS /
 * Telegram linked); prefs are loaded in a batch and the delivery loop filters.
 */
export async function fetchFlatPriceAlertUsers(
	supabase: SupabaseAdminClient,
): Promise<FlatPriceAlertUser[]> {
	const { data, error } = await (supabase
		.from("users")
		.select(
			"id, email, email_notifications_enabled, phone_country_code, phone_number, phone_verified, sms_notifications_enabled, sms_opted_out, use_24_hour_time, telegram_chat_id, telegram_opted_out",
		)
		// Candidate pre-filter on channel-level columns only: a usable email channel,
		// a usable SMS channel (verified phone + opted in), or a linked Telegram chat.
		// The per-option price_move_alerts facet is checked in the delivery loop.
		.or(
			"email_notifications_enabled.eq.true,and(sms_notifications_enabled.eq.true,phone_verified.eq.true),telegram_chat_id.not.is.null",
		) as unknown as Promise<{
		data: Omit<FlatPriceAlertUser, "prefs">[] | null;
		error: unknown;
	}>);

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
