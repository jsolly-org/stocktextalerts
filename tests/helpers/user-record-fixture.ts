import {
	type NotificationPreferenceType,
	type PrefChannel,
	type PrefRow,
	parsePrefRow,
} from "../../src/lib/messaging/notification-prefs";
import type { UserRecord } from "../../src/lib/messaging/types";

/**
 * Build notification_preferences rows for a test user from a compact spec.
 *
 * Each entry is `[notification_type, content, channel, enabled]`. Use this to set
 * per-option channel preferences on a UserRecord fixture (replacing the old
 * per-column `*_include_*` flags).
 */
export function makePrefRows(
	specs: ReadonlyArray<[NotificationPreferenceType, string, PrefChannel, boolean]>,
): PrefRow[] {
	return specs.map(([notification_type, content, channel, enabled]) => {
		const row = parsePrefRow({ notification_type, content, channel, enabled });
		if (!row) {
			throw new Error(`Invalid test preference row: ${notification_type}/${content}/${channel}`);
		}
		return row;
	});
}

/** Default UserRecord fixture for unit tests that don't hit the DB. */
export function makeUserRecord(overrides: Partial<UserRecord> = {}): UserRecord {
	return {
		id: "user-1",
		email: "test@example.com",
		phone_country_code: "1",
		phone_number: "5551112222",
		phone_verified: false,
		timezone: "UTC",
		use_24_hour_time: false,
		market_scheduled_asset_price_next_send_at: null,
		email_notifications_enabled: true,
		sms_notifications_enabled: false,
		sms_opted_out: false,
		market_scheduled_asset_price_enabled: false,
		market_scheduled_asset_price_times: null,
		daily_digest_time: null,
		daily_digest_next_send_at: null,
		asset_events_next_send_at: null,
		asset_events_last_analyst_sent_month: null,
		last_grok_rumors_at: null,
		grok_window_start: null,
		grok_sends_in_window: 0,
		telegram_chat_id: null,
		telegram_opted_out: false,
		prefs: [],
		...overrides,
	};
}
