import type { Logger } from "../logging";
import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "../schedule/helpers";

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

/**
 * Fetch users eligible for a daily digest run.
 *
 * When `forceSend` is false, users are filtered by `daily_digest_next_send_at <= currentTimeIso`.
 * Retries transient Supabase errors a small number of times before throwing.
 */
export async function fetchDailyDigestUsers(options: {
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
			daily_digest_time,
			daily_digest_next_send_at,
			email_notifications_enabled,
			sms_opted_out,
			show_sparklines,
			daily_digest_include_news_email,
			daily_digest_include_rumors_email,
			asset_events_include_calendar_email,
			asset_events_include_calendar_sms,
			asset_events_include_ipo_email,
			asset_events_include_ipo_sms,
			asset_events_include_analyst_email,
			asset_events_include_analyst_sms,
			asset_events_include_insider_email,
			asset_events_include_insider_sms,
			asset_events_next_send_at,
			asset_events_last_analyst_sent_month,
			last_grok_rumors_at,
			grok_window_start,
			grok_sends_in_window
		`,
			)
			.not("daily_digest_time", "is", null)
			.or(
				"email_notifications_enabled.eq.true,market_scheduled_asset_price_include_sms.eq.true,asset_events_include_calendar_sms.eq.true,asset_events_include_ipo_sms.eq.true,asset_events_include_analyst_sms.eq.true,asset_events_include_insider_sms.eq.true,market_asset_price_alerts_include_sms.eq.true",
			);

		if (!options.forceSend) {
			query = query
				.not("daily_digest_next_send_at", "is", null)
				.lte("daily_digest_next_send_at", options.currentTimeIso);
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
