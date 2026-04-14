import { rootLogger } from "../../logging";
import type { SupabaseAdminClient } from "../../schedule/helpers";

/** Minimal user shape for flat price alert delivery across email + SMS. */
export interface FlatPriceAlertUser {
	id: string;
	email: string;
	email_notifications_enabled: boolean;
	phone_country_code: string | null;
	phone_number: string | null;
	phone_verified: boolean;
	sms_notifications_enabled: boolean;
	sms_opted_out: boolean;
	price_move_alerts_include_email: boolean;
	price_move_alerts_include_sms: boolean;
	use_24_hour_time: boolean;
}

/**
 * Fetch users who have at least one flat-price-alert channel enabled.
 * Per-channel gates (global email unsub, verified phone, opt-out) are enforced
 * in `deliverFlatPriceAlert` so a user with both channels on can still receive
 * the email if their phone is unverified, etc.
 */
export async function fetchFlatPriceAlertUsers(
	supabase: SupabaseAdminClient,
): Promise<FlatPriceAlertUser[]> {
	const { data, error } = await (supabase
		.from("users")
		.select(
			"id, email, email_notifications_enabled, phone_country_code, phone_number, phone_verified, sms_notifications_enabled, sms_opted_out, price_move_alerts_include_email, price_move_alerts_include_sms, use_24_hour_time",
		)
		.or(
			"price_move_alerts_include_email.eq.true,price_move_alerts_include_sms.eq.true",
		) as unknown as Promise<{
		data: FlatPriceAlertUser[] | null;
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

	return data ?? [];
}
