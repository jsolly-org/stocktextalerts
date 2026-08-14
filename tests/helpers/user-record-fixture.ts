import type { NotificationPreferenceType } from "../../src/lib/constants";
import { parsePrefRow } from "../../src/lib/messaging/notification-prefs";
import type { PrefRow, UserRecord } from "../../src/lib/types";

/**
 * Build notification_preferences rows for a test user from a compact spec.
 *
 * Each entry is `[notification_type, content, enabled]`.
 */
export function makePrefRows(
	specs: ReadonlyArray<[NotificationPreferenceType, string, boolean]>,
): PrefRow[] {
	return specs.map(([notification_type, content, enabled]) => {
		const row = parsePrefRow({ notification_type, content, enabled });
		if (!row) {
			throw new Error(`Invalid test preference row: ${notification_type}/${content}`);
		}
		return row;
	});
}

/** Default UserRecord fixture for unit tests that don't hit the DB. */
export function makeUserRecord(overrides: Partial<UserRecord> = {}): UserRecord {
	return {
		id: "user-1",
		email: "test@example.com",
		timezone: "UTC",
		use_24_hour_time: false,
		market_scheduled_asset_price_next_send_at: null,
		delivery_channel: "email",
		market_scheduled_asset_price_enabled: false,
		market_scheduled_asset_price_times: null,
		daily_notification_time: null,
		daily_notification_next_send_at: null,
		asset_events_last_analyst_sent_month: null,
		last_grok_rumors_at: null,
		grok_window_start: null,
		grok_sends_in_window: 0,
		telegram_chat_id: null,
		prefs: [],
		...overrides,
	};
}
