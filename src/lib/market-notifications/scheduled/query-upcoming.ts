import type { Logger } from "../../logging";
import type { UserRecord } from "../../messaging/types";
import type { SupabaseAdminClient } from "../../schedule/helpers";

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

/** Fetch users whose market scheduled update is due in an upcoming time window. */
export async function fetchUpcomingMarketScheduledUsers(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	afterTimeIso: string;
	beforeTimeIso: string;
}): Promise<UserRecord[]> {
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const { data, error } = await options.supabase
			.from("users")
			.select(
				`
			id,
			email,
			phone_country_code,
			phone_number,
			phone_verified,
			timezone,
			market_scheduled_asset_price_enabled,
			market_scheduled_asset_price_include_email,
			market_scheduled_asset_price_include_sms,
			market_scheduled_asset_price_times,
			daily_digest_time,
			daily_digest_next_send_at,
			market_scheduled_asset_price_next_send_at,
			email_notifications_enabled,
			sms_notifications_enabled,
			sms_opted_out,
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
			grok_sends_in_window,
			show_sparklines
		`,
			)
			.eq("market_scheduled_asset_price_enabled", true)
			.not("market_scheduled_asset_price_times", "is", null)
			.or(
				"email_notifications_enabled.eq.true,sms_notifications_enabled.eq.true",
			)
			.not("market_scheduled_asset_price_next_send_at", "is", null)
			.gt("market_scheduled_asset_price_next_send_at", options.afterTimeIso)
			.lte("market_scheduled_asset_price_next_send_at", options.beforeTimeIso);

		if (!error) {
			return (data ?? []) as unknown as UserRecord[];
		}

		if (attempt < MAX_RETRIES) {
			options.logger.warn(
				"Transient error fetching upcoming market users, retrying",
				{
					attempt: attempt + 1,
					maxRetries: MAX_RETRIES,
					errorMessage: error.message.slice(0, 200),
				},
			);
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
		} else {
			options.logger.error(
				"Failed to fetch upcoming market users after retries",
				{
					attempts: MAX_RETRIES + 1,
					errorMessage: error.message.slice(0, 200),
				},
			);
			throw new Error(
				`Failed to fetch upcoming market users after ${MAX_RETRIES + 1} attempts`,
			);
		}
	}

	throw new Error("Failed to fetch upcoming market users: retries exhausted");
}
