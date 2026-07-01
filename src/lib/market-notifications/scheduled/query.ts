import type { SupabaseAdminClient } from "../../db/supabase";
import { fetchUsersWithRetry } from "../../db/user-query";
import type { Logger } from "../../logging";
import { attachPrefsToUsers } from "../../messaging/load-prefs";
import type { UserRecord } from "../../types";

/** User column projection for market-scheduled queries (channel-level columns only;
 *  per-option facets live in notification_preferences, attached separately). */
const MARKET_SCHEDULED_USER_SELECT = `
	id,
	email,
	phone_country_code,
	phone_number,
	phone_verified,
	timezone,
	use_24_hour_time,
	market_scheduled_asset_price_enabled,
	market_scheduled_asset_price_times,
	daily_notification_time,
	daily_notification_next_send_at,
	market_scheduled_asset_price_next_send_at,
	email_notifications_enabled,
	sms_notifications_enabled,
	sms_opted_out,
	asset_events_last_analyst_sent_month,
	telegram_chat_id,
	telegram_opted_out,
	last_grok_rumors_at,
	grok_window_start,
	grok_sends_in_window
`;

/** Candidate filter: user has at least one usable delivery channel (email global on,
 *  SMS opted in + verified, or a linked Telegram chat). The per-option
 *  market_scheduled_asset_price facet is checked per-channel in process.ts. */
const HAS_DELIVERY_CHANNEL_OR =
	"email_notifications_enabled.eq.true,and(sms_notifications_enabled.eq.true,phone_verified.eq.true),telegram_chat_id.not.is.null";

type UserRecordWithoutPrefs = Omit<UserRecord, "prefs">;

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
					.lte("market_scheduled_asset_price_next_send_at", options.currentTimeIso);
			}

			const { data, error } = await query;
			if (error) return { data: null, error };
			const withPrefs = await attachPrefsToUsers(
				options.supabase,
				(data ?? []) as unknown as UserRecordWithoutPrefs[],
			);
			return { data: withPrefs as UserRecord[], error: null };
		},
	});
}
