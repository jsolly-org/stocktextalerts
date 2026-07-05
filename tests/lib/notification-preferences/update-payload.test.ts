import { describe, expect, it } from "vitest";
import type { User } from "../../../src/lib/db/types";
import {
	buildNotificationPreferencesUpdatePayload,
	computeTimezoneUpdatePayload,
} from "../../../src/lib/notification-preferences/update-payload";

function makeUser(overrides: Partial<User> = {}): User {
	return {
		id: "00000000-0000-0000-0000-000000000111",
		timezone: "America/New_York",
		market_scheduled_asset_price_times: [570], // 09:30
		market_scheduled_asset_price_next_send_at: "2026-01-14T14:30:00.000Z",
		daily_notification_time: 1020,
		daily_notification_next_send_at: "2026-01-14T22:00:00.000Z",
		email_notifications_enabled: true,
		market_scheduled_asset_price_enabled: true,
		...overrides,
	} as unknown as User;
}

describe("Notification preference update payloads stay aligned with user schedule behavior.", () => {
	it("Recomputes next-send timestamps when timezone changes.", () => {
		const user = makeUser();

		const payload = computeTimezoneUpdatePayload("America/Chicago", user, true);

		expect(payload.timezone).toBe("America/Chicago");
		// Market-scheduled times are ET-canonical post-extended-hours migration
		// — the absolute UTC instant of next_send_at is invariant under user-
		// timezone changes, so the payload deliberately omits the field.
		expect(payload.market_scheduled_asset_price_next_send_at).toBeUndefined();
		expect(payload.daily_notification_next_send_at).toBeTruthy();
	});

	it("Leaves derived send times untouched when timezone is unchanged.", () => {
		const user = makeUser({ timezone: "America/Chicago" });

		const payload = computeTimezoneUpdatePayload("America/Chicago", user, false);

		expect(payload).toEqual({ timezone: "America/Chicago" });
	});

	it("Clears next market send time when user removes all scheduled update times.", () => {
		const user = makeUser();
		const formData = new FormData();
		formData.set("market_scheduled_asset_price_times", "[]");

		const payload = buildNotificationPreferencesUpdatePayload({
			parsedData: {
				market_scheduled_asset_price_times: [],
			},
			formData,
			rawTimesValue: "",
			dbUser: user,
			dailyNotificationEnabledAfterUpdate: false,
			dailyNotificationOptionsChanged: false,
		});

		expect(payload.market_scheduled_asset_price_times).toBeNull();
		expect(payload.market_scheduled_asset_price_next_send_at).toBeNull();
	});

	it("Only persists booleans explicitly submitted in the form payload.", () => {
		const user = makeUser();
		const formData = new FormData();
		formData.set("email_notifications_enabled", "on");

		const payload = buildNotificationPreferencesUpdatePayload({
			parsedData: {
				email_notifications_enabled: true,
				market_scheduled_asset_price_enabled: true,
			},
			formData,
			rawTimesValue: null,
			dbUser: user,
			dailyNotificationEnabledAfterUpdate: false,
			dailyNotificationOptionsChanged: false,
		});

		expect(payload.email_notifications_enabled).toBe(true);
		// market_scheduled_asset_price_enabled was in parsedData but not the
		// submitted formData, so it must be omitted (no unchecked-drift).
		expect(payload.market_scheduled_asset_price_enabled).toBeUndefined();
	});

	it("Schedules daily_notification_next_send_at when a daily facet becomes enabled.", () => {
		const user = makeUser();
		const formData = new FormData();
		formData.set("asset_events_include_insider_telegram", "on");

		const payload = buildNotificationPreferencesUpdatePayload({
			parsedData: { asset_events_include_insider_telegram: true },
			formData,
			rawTimesValue: null,
			dbUser: user,
			dailyNotificationEnabledAfterUpdate: true,
			dailyNotificationOptionsChanged: true,
		});

		expect(payload.daily_notification_next_send_at).toBeTruthy();
	});

	it("Nullifies daily notification cursors when the last facet is disabled.", () => {
		const user = makeUser();
		const formData = new FormData();
		formData.set("asset_events_include_calendar_email", "on");

		const payload = buildNotificationPreferencesUpdatePayload({
			parsedData: { asset_events_include_calendar_email: false },
			formData,
			rawTimesValue: null,
			dbUser: user,
			dailyNotificationEnabledAfterUpdate: false,
			dailyNotificationOptionsChanged: true,
		});

		expect(payload.daily_notification_next_send_at).toBeNull();
	});

	it("Timezone change recomputes daily notification cursors when a facet is enabled.", () => {
		const user = makeUser();

		const payload = computeTimezoneUpdatePayload("America/Chicago", user, true);

		expect(payload.daily_notification_next_send_at).toBeTruthy();
	});

	it("Timezone change skips daily notification cursors when no facet is enabled.", () => {
		const user = makeUser();

		const payload = computeTimezoneUpdatePayload("America/Chicago", user, false);

		expect(payload.daily_notification_next_send_at).toBeUndefined();
	});

	it("Normalizes and sorts submitted scheduled times before persistence.", () => {
		const user = makeUser();
		const formData = new FormData();
		formData.set("market_scheduled_asset_price_times", '["11:00","09:30"]');

		const payload = buildNotificationPreferencesUpdatePayload({
			parsedData: {
				market_scheduled_asset_price_times: ["11:00", "09:30"],
			},
			formData,
			rawTimesValue: '["11:00","09:30"]',
			dbUser: user,
			dailyNotificationEnabledAfterUpdate: false,
			dailyNotificationOptionsChanged: false,
		});

		expect(payload.market_scheduled_asset_price_times).toEqual([570, 660]);
		expect(payload.market_scheduled_asset_price_next_send_at).toBeTruthy();
	});
});
