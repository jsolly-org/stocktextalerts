import { fetchUsersWithRetry } from "../db/user-query";
import type { Logger } from "../logging";
import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "../schedule/helpers";

const UPCOMING_DAILY_USER_SELECT = `
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
	market_asset_price_alerts_include_sms,
	last_grok_rumors_at,
	grok_window_start,
	grok_sends_in_window
`;

const HAS_DELIVERY_CHANNEL_OR =
	"email_notifications_enabled.eq.true,market_scheduled_asset_price_include_sms.eq.true,asset_events_include_calendar_sms.eq.true,asset_events_include_ipo_sms.eq.true,asset_events_include_analyst_sms.eq.true,asset_events_include_insider_sms.eq.true,market_asset_price_alerts_include_sms.eq.true";

/** Fetch users whose daily digest is due in an upcoming time window. */
export async function fetchUpcomingDailyDigestUsers(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	afterTimeIso: string;
	beforeTimeIso: string;
}): Promise<UserRecord[]> {
	return fetchUsersWithRetry<UserRecord>({
		supabase: options.supabase,
		logger: options.logger,
		label: "upcoming daily users",
		execute: async () => {
			const { data, error } = await options.supabase
				.from("users")
				.select(UPCOMING_DAILY_USER_SELECT)
				.not("daily_digest_time", "is", null)
				.or(HAS_DELIVERY_CHANNEL_OR)
				.not("daily_digest_next_send_at", "is", null)
				.gt("daily_digest_next_send_at", options.afterTimeIso)
				.lte("daily_digest_next_send_at", options.beforeTimeIso);

			if (error) return { data: null, error };

			const users = (data ?? []) as UserRecord[];
			const filtered = users.filter(
				(user) =>
					user.daily_digest_include_news_email ||
					user.daily_digest_include_rumors_email,
			);
			return { data: filtered, error: null };
		},
	});
}
