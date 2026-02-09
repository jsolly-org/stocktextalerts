import type { Logger } from "../logging";
import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "./helpers";

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

/**
 * Fetch users eligible for a weekly calendar run.
 *
 * When `forceSend` is false, users are filtered by `weekly_next_send_at <= currentTimeIso`.
 * Retries transient Supabase errors a small number of times before throwing.
 */
export async function fetchWeeklyUsers(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	forceSend: boolean;
	currentTimeIso: string;
}): Promise<UserRecord[]> {
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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
			daily_delivery_time,
			weekly_include_earnings,
			weekly_include_dividends,
			weekly_next_send_at,
			email_notifications_enabled,
			sms_notifications_enabled,
			sms_opted_out
		`,
			)
			.or("weekly_include_earnings.eq.true,weekly_include_dividends.eq.true")
			.or(
				"email_notifications_enabled.eq.true,sms_notifications_enabled.eq.true",
			);

		if (!options.forceSend) {
			query = query
				.not("weekly_next_send_at", "is", null)
				.lte("weekly_next_send_at", options.currentTimeIso);
		}

		const { data, error } = await query;
		if (!error) {
			return (data ?? []) as unknown as UserRecord[];
		}

		if (attempt === MAX_RETRIES) {
			options.logger.error("Failed to fetch weekly users after retries", {
				attempts: MAX_RETRIES + 1,
				errorMessage: error.message.slice(0, 200),
			});
			throw new Error(
				`Failed to fetch weekly users after ${MAX_RETRIES + 1} attempts`,
			);
		}

		options.logger.warn("Transient error fetching weekly users, retrying", {
			attempt: attempt + 1,
			maxRetries: MAX_RETRIES,
			errorMessage: error.message.slice(0, 200),
		});
		await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
	}

	// Unreachable — loop always returns or throws — but satisfies TypeScript
	throw new Error("Failed to fetch weekly users: retries exhausted");
}
