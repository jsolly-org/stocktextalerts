import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "./helpers";

/**
 * Fetch users eligible for scheduled processing.
 * In force mode, users without `next_send_at` may be returned (e.g. newly enabled schedules).
 */
export async function fetchScheduledUsers(options: {
	supabase: SupabaseAdminClient;
	forceSend: boolean;
	currentTimeIso: string;
}): Promise<UserRecord[]> {
	let query = options.supabase
		.from("users")
		.select(
			`
			id,
			email,
			phone_country_code,
			phone_number,
			phone_verified,
			timezone,
			scheduled_updates_enabled,
			scheduled_update_times,
			next_send_at,
			email_notifications_enabled,
			sms_notifications_enabled,
			show_change_percent,
			show_company_name,
			detailed_format
		`,
		)
		.eq("scheduled_updates_enabled", true)
		.not("scheduled_update_times", "is", null)
		.or(
			"email_notifications_enabled.eq.true,sms_notifications_enabled.eq.true",
		);
	// When forceSend (manual send), include users even if next_send_at is null (e.g. newly enabled scheduled updates).
	// For normal cron, only process users due to send.
	if (!options.forceSend) {
		query = query
			.not("next_send_at", "is", null)
			.lte("next_send_at", options.currentTimeIso);
	}
	const { data, error } = await query;

	if (error) {
		throw new Error(`Failed to fetch users: ${error.message}`);
	}

	return (data ?? []) as UserRecord[];
}
