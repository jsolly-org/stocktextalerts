import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "./helpers";

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
			daily_digest_enabled,
			daily_digest_notification_times,
			next_send_at,
			email_notifications_enabled,
			sms_notifications_enabled
		`,
		)
		.eq("daily_digest_enabled", true)
		.not("daily_digest_notification_times", "is", null)
		.or(
			"email_notifications_enabled.eq.true,sms_notifications_enabled.eq.true",
		);
	// When forceSend (manual send), include users even if next_send_at is null (e.g. newly enabled digests).
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
