import { fetchUsersWithRetry } from "../db/user-query";
import type { Logger } from "../logging";
import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "../schedule/helpers";

const ASSET_EVENTS_USER_SELECT = `
	id,
	email,
	phone_country_code,
	phone_number,
	phone_verified,
	timezone,
	use_24_hour_time,
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
	grok_sends_in_window
`;

const ASSET_EVENTS_ENABLED_OR =
	"asset_events_include_calendar_email.eq.true,asset_events_include_calendar_sms.eq.true,asset_events_include_ipo_email.eq.true,asset_events_include_ipo_sms.eq.true,asset_events_include_analyst_email.eq.true,asset_events_include_analyst_sms.eq.true,asset_events_include_insider_email.eq.true,asset_events_include_insider_sms.eq.true";

const HAS_DELIVERY_CHANNEL_OR =
	"email_notifications_enabled.eq.true,market_scheduled_asset_price_include_sms.eq.true,asset_events_include_calendar_sms.eq.true,asset_events_include_ipo_sms.eq.true,asset_events_include_analyst_sms.eq.true,asset_events_include_insider_sms.eq.true,market_asset_price_alerts_include_sms.eq.true";

/**
 * Fetch users eligible for a standalone asset events run.
 *
 * Only picks up users who have asset events enabled but are NOT handled by
 * the daily pipeline (i.e., they don't have daily_digest_time set with daily features enabled).
 */
export async function fetchAssetEventsUsers(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	forceSend: boolean;
	currentTimeIso: string;
}): Promise<UserRecord[]> {
	return fetchUsersWithRetry<UserRecord>({
		supabase: options.supabase,
		logger: options.logger,
		label: "asset events users",
		execute: async () => {
			let query = options.supabase
				.from("users")
				.select(ASSET_EVENTS_USER_SELECT)
				.or(ASSET_EVENTS_ENABLED_OR)
				.or(HAS_DELIVERY_CHANNEL_OR);

			if (!options.forceSend) {
				query = query
					.not("asset_events_next_send_at", "is", null)
					.lte("asset_events_next_send_at", options.currentTimeIso);
			}

			const { data, error } = await query;
			if (error) return { data: null, error };

			const users = (data ?? []) as UserRecord[];
			const filtered = users.filter(
				(user) =>
					!(
						user.daily_digest_time != null &&
						(user.daily_digest_include_news_email ||
							user.daily_digest_include_rumors_email)
					),
			);
			return { data: filtered, error: null };
		},
	});
}
