import type { SupabaseAdminClient } from "../db/supabase";
import { fetchUsersWithRetry } from "../db/user-query";
import type { Logger } from "../logging";
import { attachPrefsToUsers } from "../messaging/load-prefs";
import { anyFacetEnabled, isFacetEnabled } from "../messaging/notification-prefs";
import type { UserRecord } from "../user-record-types";

/** Channel-level user columns (per-option facets live in notification_preferences). */
const ASSET_EVENTS_USER_SELECT = `
	id,
	email,
	phone_country_code,
	phone_number,
	phone_verified,
	timezone,
	use_24_hour_time,
	market_scheduled_asset_price_enabled,
	market_scheduled_asset_price_times,
	daily_digest_time,
	daily_digest_next_send_at,
	market_scheduled_asset_price_next_send_at,
	email_notifications_enabled,
	sms_notifications_enabled,
	sms_opted_out,
	asset_events_next_send_at,
	asset_events_last_analyst_sent_month,
	telegram_chat_id,
	telegram_opted_out,
	last_grok_rumors_at,
	grok_window_start,
	grok_sends_in_window
`;

// Per-option asset_events facets now live in notification_preferences, which
// PostgREST can't join in one query against `users`. The candidate set is gated
// by channel-level columns only (a usable email channel, a usable SMS channel, or
// a linked Telegram chat); the asset_events-enabled-and-not-handled-by-daily check
// runs in code after prefs are attached.
const HAS_DELIVERY_CHANNEL_OR =
	"email_notifications_enabled.eq.true,and(sms_notifications_enabled.eq.true,phone_verified.eq.true),telegram_chat_id.not.is.null";

type UserRecordWithoutPrefs = Omit<UserRecord, "prefs">;

/**
 * Fetch users eligible for a standalone asset events run.
 *
 * Only picks up users who have asset events enabled (any facet on an enabled
 * channel) but are NOT handled by the daily pipeline (i.e., they don't have
 * daily_digest_time set with a daily Grok feature — news/rumors — enabled).
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
				.or(HAS_DELIVERY_CHANNEL_OR);

			if (!options.forceSend) {
				query = query
					.not("asset_events_next_send_at", "is", null)
					.lte("asset_events_next_send_at", options.currentTimeIso);
			}

			const { data, error } = await query;
			if (error) return { data: null, error };

			const users = await attachPrefsToUsers(
				options.supabase,
				(data ?? []) as unknown as UserRecordWithoutPrefs[],
			);
			const filtered = (users as UserRecord[]).filter((user) => {
				const wantsAssetEvents =
					anyFacetEnabled(user.prefs, "asset_events", "email") ||
					anyFacetEnabled(user.prefs, "asset_events", "sms") ||
					anyFacetEnabled(user.prefs, "asset_events", "telegram");
				const handledByDaily =
					user.daily_digest_time != null &&
					(isFacetEnabled(user.prefs, "daily_digest", "email", "news") ||
						isFacetEnabled(user.prefs, "daily_digest", "email", "rumors"));
				return wantsAssetEvents && !handledByDaily;
			});
			return { data: filtered, error: null };
		},
	});
}
