import { fetchUsersWithRetry } from "../db/user-query";
import type { Logger } from "../logging";
import { attachPrefsToUsers } from "../messaging/load-prefs";
import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "../schedule/helpers";

/** Channel-level user columns (per-option facets live in notification_preferences,
 *  attached via attachPrefsToUsers). */
export const DAILY_DIGEST_USER_SELECT = `
	id,
	email,
	phone_country_code,
	phone_number,
	phone_verified,
	timezone,
	use_24_hour_time,
	market_scheduled_asset_price_enabled,
	daily_digest_time,
	daily_digest_next_send_at,
	market_scheduled_asset_price_next_send_at,
	email_notifications_enabled,
	sms_notifications_enabled,
	sms_opted_out,
	asset_events_next_send_at,
	asset_events_last_analyst_sent_month,
	market_scheduled_asset_price_times,
	telegram_chat_id,
	telegram_opted_out,
	last_grok_rumors_at,
	grok_window_start,
	grok_sends_in_window
`;

/** `notification_preferences`-free `UserRecord` (prefs attached separately). */
type UserRecordWithoutPrefs = Omit<UserRecord, "prefs">;

export const HAS_DELIVERY_CHANNEL_OR =
	"email_notifications_enabled.eq.true,sms_notifications_enabled.eq.true,telegram_chat_id.not.is.null";

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
	return fetchUsersWithRetry<UserRecord>({
		supabase: options.supabase,
		logger: options.logger,
		label: "daily users",
		execute: async () => {
			let query = options.supabase
				.from("users")
				.select(DAILY_DIGEST_USER_SELECT)
				.not("daily_digest_time", "is", null)
				.or(HAS_DELIVERY_CHANNEL_OR);

			if (!options.forceSend) {
				query = query
					.not("daily_digest_next_send_at", "is", null)
					.lte("daily_digest_next_send_at", options.currentTimeIso);
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

/**
 * Fetch a single user as a complete daily-digest `UserRecord` (with prefs), via the
 * same canonical `DAILY_DIGEST_USER_SELECT` + `attachPrefsToUsers` as the batch fetch.
 * Used by the standalone-invoke dispatch path so it doesn't hand-maintain a second copy
 * of the column list. Throws on a query error; returns null when the user doesn't exist.
 */
export async function fetchOneDailyDigestUser(
	supabase: SupabaseAdminClient,
	userId: string,
): Promise<UserRecord | null> {
	const { data, error } = await supabase
		.from("users")
		.select(DAILY_DIGEST_USER_SELECT)
		.eq("id", userId)
		.maybeSingle();
	if (error) throw error;
	if (!data) return null;
	const [withPrefs] = await attachPrefsToUsers(supabase, [
		data as unknown as UserRecordWithoutPrefs,
	]);
	return (withPrefs as UserRecord | undefined) ?? null;
}
