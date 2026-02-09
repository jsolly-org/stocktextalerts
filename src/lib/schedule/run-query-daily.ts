import type { Logger } from "../logging";
import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "./helpers";

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

export async function fetchDailyUsers(options: {
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
			daily_only_notify_when_market_open,
			daily_delivery_time,
			daily_next_send_at,
			email_notifications_enabled,
			sms_notifications_enabled,
			sms_opted_out,
			daily_include_news,
			daily_include_rumors,
			daily_include_analyst,
			daily_include_insider,
			last_grok_rumors_at,
			grok_window_start,
			grok_sends_in_window
		`,
			)
			.not("daily_delivery_time", "is", null)
			.or(
				"email_notifications_enabled.eq.true,sms_notifications_enabled.eq.true",
			);

		if (!options.forceSend) {
			query = query
				.not("daily_next_send_at", "is", null)
				.lte("daily_next_send_at", options.currentTimeIso);
		}

		const { data, error } = await query;
		if (!error) {
			return (data ?? []) as unknown as UserRecord[];
		}

		if (attempt === MAX_RETRIES) {
			options.logger.error("Failed to fetch daily users after retries", {
				attempts: MAX_RETRIES + 1,
				errorMessage: error.message.slice(0, 200),
			});
			throw new Error(
				`Failed to fetch daily users after ${MAX_RETRIES + 1} attempts`,
			);
		}

		options.logger.warn("Transient error fetching daily users, retrying", {
			attempt: attempt + 1,
			maxRetries: MAX_RETRIES,
			errorMessage: error.message.slice(0, 200),
		});
		await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
	}

	// Unreachable — loop always returns or throws — but satisfies TypeScript
	throw new Error("Failed to fetch daily users: retries exhausted");
}
