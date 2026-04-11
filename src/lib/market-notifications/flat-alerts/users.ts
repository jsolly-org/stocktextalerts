import { rootLogger } from "../../logging";
import type { SupabaseAdminClient } from "../../schedule/helpers";

/** Minimal user shape for flat price alert delivery (email-only, no SMS fields). */
export interface FlatPriceAlertUser {
	id: string;
	email: string;
	use_24_hour_time: boolean;
}

/**
 * Fetch users with flat price alerts enabled AND email notifications globally
 * enabled. Returns only the columns needed to render and send the email.
 *
 * Unlike the anomaly `fetchPriceAlertUsers`, this has no SMS fields and no
 * anomaly move-size preference — the feature is email-only with a hard-coded
 * threshold.
 */
export async function fetchFlatPriceAlertUsers(
	supabase: SupabaseAdminClient,
): Promise<FlatPriceAlertUser[]> {
	const { data, error } = await supabase
		.from("users")
		.select("id, email, use_24_hour_time")
		.eq("price_move_alerts_enabled", true)
		.eq("email_notifications_enabled", true);

	if (error) {
		rootLogger.error(
			"Failed to fetch flat price alert users",
			{ action: "fetch_flat_price_alert_users" },
			error,
		);
		return [];
	}

	return data ?? [];
}
