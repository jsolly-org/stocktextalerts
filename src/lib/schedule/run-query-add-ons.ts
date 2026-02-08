import type { Logger } from "../logging";
import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "./helpers";

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

export async function fetchDailyAddOnsUsers(options: {
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
			add_ons_only_notify_when_market_open,
			add_ons_delivery_time,
			add_ons_next_send_at,
			email_notifications_enabled,
			sms_notifications_enabled,
			sms_opted_out,
			first_notification_include_news,
			first_notification_include_rumors,
			last_grok_rumors_at
		`,
			)
			.not("add_ons_delivery_time", "is", null)
			.or(
				"email_notifications_enabled.eq.true,sms_notifications_enabled.eq.true",
			);

		if (!options.forceSend) {
			query = query
				.not("add_ons_next_send_at", "is", null)
				.lte("add_ons_next_send_at", options.currentTimeIso);
		}

		const { data, error } = await query;
		if (!error) {
			return (data ?? []) as unknown as UserRecord[];
		}

		if (attempt < MAX_RETRIES) {
			options.logger.warn(
				"Transient error fetching daily add-ons users, retrying",
				{
					attempt: attempt + 1,
					maxRetries: MAX_RETRIES,
					errorMessage: error.message.slice(0, 200),
				},
			);
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
		} else {
			options.logger.error(
				"Failed to fetch daily add-ons users after retries",
				{
					attempts: MAX_RETRIES + 1,
					errorMessage: error.message.slice(0, 200),
				},
			);
			throw new Error(
				`Failed to fetch daily add-ons users after ${MAX_RETRIES + 1} attempts`,
			);
		}
	}

	throw new Error("Failed to fetch daily add-ons users: retries exhausted");
}
