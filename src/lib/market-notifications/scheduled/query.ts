import { fetchUsersWithRetry } from "../../db/user-query";
import type { Logger } from "../../logging";
import type { UserRecord } from "../../messaging/types";
import type { SupabaseAdminClient } from "../../schedule/helpers";

const MARKET_SCHEDULED_USER_SELECT = `
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
	market_asset_price_alerts_include_sms,
	last_grok_rumors_at,
	grok_window_start,
	grok_sends_in_window,
	show_sparklines
`;

const HAS_DELIVERY_CHANNEL_OR =
	"email_notifications_enabled.eq.true,market_scheduled_asset_price_include_sms.eq.true";

/**
 * Fetch users eligible for a scheduled asset price update run.
 *
 * When `forceSend` is false, users are filtered by `market_scheduled_asset_price_next_send_at <= currentTimeIso`.
 * Retries transient Supabase errors a small number of times before throwing.
 *
 * Force-send: when manual send, include users even if market_scheduled_asset_price_next_send_at is null
 * (e.g. newly enabled scheduled updates). For normal cron, only process users due to send.
 */
export async function fetchMarketScheduledUsers(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	forceSend: boolean;
	currentTimeIso: string;
}): Promise<UserRecord[]> {
	return fetchUsersWithRetry<UserRecord>({
		supabase: options.supabase,
		logger: options.logger,
		label: "scheduled users",
		execute: async () => {
			let query = options.supabase
				.from("users")
				.select(MARKET_SCHEDULED_USER_SELECT)
				.eq("market_scheduled_asset_price_enabled", true)
				.not("market_scheduled_asset_price_times", "is", null)
				.or(HAS_DELIVERY_CHANNEL_OR);

			if (!options.forceSend) {
				query = query
					.not("market_scheduled_asset_price_next_send_at", "is", null)
					.lte(
						"market_scheduled_asset_price_next_send_at",
						options.currentTimeIso,
					);
			}

			const { data, error } = await query;
			if (error) return { data: null, error };
			return { data: (data ?? []) as UserRecord[], error: null };
		},
	});
}
