import type { Logger } from "../logging";
import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "./helpers";

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

/**
 * Fetch users eligible for a scheduled price update run.
 *
 * When `forceSend` is false, users are filtered by `next_send_at <= currentTimeIso`.
 * Retries transient Supabase errors a small number of times before throwing.
 */
export async function fetchScheduledUsers(options: {
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
			price_notifications_enabled,
			price_include_email,
			price_include_sms,
			scheduled_update_times,
			daily_delivery_time,
			daily_next_send_at,
			next_send_at,
			email_notifications_enabled,
			sms_notifications_enabled,
			sms_opted_out,
			daily_include_news_email,
			daily_include_rumors_email,
			daily_include_analyst_email,
			daily_include_insider_email,
			daily_include_analyst_sms,
			daily_include_insider_sms,
			last_grok_rumors_at,
			grok_window_start,
			grok_sends_in_window,
			show_change_percent,
			show_company_name,
			detailed_format
		`,
			)
			.eq("price_notifications_enabled", true)
			.not("scheduled_update_times", "is", null)
			.or(
				"email_notifications_enabled.eq.true,sms_notifications_enabled.eq.true",
			);
		/* =============
		Force-send scheduling rationale
		- When forceSend (manual send), include users even if next_send_at is null (e.g. newly enabled scheduled updates).
		- For normal cron, only process users due to send.
		============= */
		if (!options.forceSend) {
			query = query
				.not("next_send_at", "is", null)
				.lte("next_send_at", options.currentTimeIso);
		}
		const { data, error } = await query;

		if (!error) {
			return (data ?? []) as unknown as UserRecord[];
		}

		if (attempt < MAX_RETRIES) {
			options.logger.warn(
				"Transient error fetching scheduled users, retrying",
				{
					attempt: attempt + 1,
					maxRetries: MAX_RETRIES,
					errorMessage: error.message.slice(0, 200),
				},
			);
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
		} else {
			options.logger.error("Failed to fetch scheduled users after retries", {
				attempts: MAX_RETRIES + 1,
				errorMessage: error.message.slice(0, 200),
			});
			throw new Error(
				`Failed to fetch users after ${MAX_RETRIES + 1} attempts`,
			);
		}
	}

	/* ============= TypeScript unreachable guard ============= */
	throw new Error("Failed to fetch users: retries exhausted");
}
