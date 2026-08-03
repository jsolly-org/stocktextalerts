import type { DeliveryChannelMode } from "../../constants";
import type { SupabaseAdminClient } from "../../db/supabase";
import { rootLogger } from "../../logging";
import { attachPrefsToUsers } from "../../messaging/load-prefs";
import type { PrefRow } from "../../types";

/** Minimal user shape for flat price alert delivery. */
export interface FlatPriceAlertUser {
	id: string;
	email: string;
	delivery_channel: DeliveryChannelMode;
	use_24_hour_time: boolean;
	telegram_chat_id: number | null;
	price_move_why_window_start: string | null;
	price_move_why_sends_in_window: number;
	prefs: PrefRow[];
}

/**
 * Fetch users whose account delivery_channel is email or telegram.
 * The `price_move_alerts` content toggle is enforced in `deliverFlatPriceAlert`.
 */
export async function fetchFlatPriceAlertUsers(
	supabase: SupabaseAdminClient,
): Promise<FlatPriceAlertUser[]> {
	const { data, error } = await supabase
		.from("users")
		.select(
			"id, email, delivery_channel, use_24_hour_time, telegram_chat_id, price_move_why_window_start, price_move_why_sends_in_window",
		)
		.in("delivery_channel", ["email", "telegram"]);

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
