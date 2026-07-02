import type { SupabaseAdminClient } from "../db/supabase";
import { fetchUsersWithRetry } from "../db/user-query";
import type { Logger } from "../logging";
import { attachPrefsToUsers } from "../messaging/load-prefs";
import type { UserRecord, UserRecordWithoutPrefs } from "../types";
import { hasAnyDailyNotificationFacet } from "./eligibility";

/** Channel-level user columns for the daily notification pipeline. */
export const DAILY_NOTIFICATION_USER_SELECT = `
	id,
	email,
	phone_country_code,
	phone_number,
	phone_verified,
	timezone,
	use_24_hour_time,
	market_scheduled_asset_price_enabled,
	daily_notification_time,
	daily_notification_next_send_at,
	market_scheduled_asset_price_next_send_at,
	email_notifications_enabled,
	sms_notifications_enabled,
	sms_opted_out,
	asset_events_last_analyst_sent_month,
	market_scheduled_asset_price_times,
	telegram_chat_id,
	telegram_opted_out,
	last_grok_rumors_at,
	grok_window_start,
	grok_sends_in_window
`;

export const HAS_DELIVERY_CHANNEL_OR =
	"email_notifications_enabled.eq.true,sms_notifications_enabled.eq.true,telegram_chat_id.not.is.null";

/**
 * Fetch users due for the unified daily notification pipeline.
 *
 * Eligible when any daily facet is enabled and the next-send cursor is due.
 */
export async function fetchDailyNotificationUsers(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	forceSend: boolean;
	currentTimeIso: string;
}): Promise<UserRecord[]> {
	return fetchUsersWithRetry<UserRecord>({
		supabase: options.supabase,
		logger: options.logger,
		label: "daily notification users",
		execute: async () => {
			let query = options.supabase
				.from("users")
				.select(DAILY_NOTIFICATION_USER_SELECT)
				.or(HAS_DELIVERY_CHANNEL_OR);

			if (!options.forceSend) {
				query = query
					.not("daily_notification_next_send_at", "is", null)
					.lte("daily_notification_next_send_at", options.currentTimeIso);
			}

			const { data, error } = await query;
			if (error) return { data: null, error };

			const withPrefs = await attachPrefsToUsers(
				options.supabase,
				(data ?? []) as unknown as UserRecordWithoutPrefs[],
			);
			const filtered = withPrefs.filter((user) => hasAnyDailyNotificationFacet(user.prefs));
			return { data: filtered, error: null };
		},
	});
}

export async function fetchOneDailyNotificationUser(
	supabase: SupabaseAdminClient,
	userId: string,
): Promise<UserRecord | null> {
	const { data, error } = await supabase
		.from("users")
		.select(DAILY_NOTIFICATION_USER_SELECT)
		.eq("id", userId)
		.maybeSingle();
	if (error) throw error;
	if (!data) return null;
	const [withPrefs] = await attachPrefsToUsers(supabase, [
		data as unknown as UserRecordWithoutPrefs,
	]);
	return withPrefs ?? null;
}
