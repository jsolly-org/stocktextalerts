import { describe, expect, it } from "vitest";
import {
	buildNotificationPreferencesUpdatePayload,
	computeTimezoneUpdatePayload,
} from "../../../src/lib/api/notification-preferences-update";
import type { User } from "../../../src/lib/db";

function makeUser(overrides: Partial<User> = {}): User {
	return {
		id: "00000000-0000-0000-0000-000000000111",
		timezone: "America/New_York",
		market_scheduled_asset_price_times: [570], // 09:30
		market_scheduled_asset_price_next_send_at: "2026-01-14T14:30:00.000Z",
		daily_digest_time: 1020,
		daily_digest_next_send_at: "2026-01-14T22:00:00.000Z",
		asset_events_next_send_at: "2026-01-14T22:00:00.000Z",
		email_notifications_enabled: true,
		sms_notifications_enabled: false,
		sms_opted_out: false,
		asset_events_include_calendar_email: true,
		asset_events_include_calendar_sms: false,
		asset_events_include_ipo_email: false,
		asset_events_include_ipo_sms: false,
		asset_events_include_analyst_email: false,
		asset_events_include_analyst_sms: false,
		asset_events_include_insider_email: false,
		asset_events_include_insider_sms: false,
		market_scheduled_asset_price_enabled: true,
		market_scheduled_asset_price_include_email: true,
		market_scheduled_asset_price_include_sms: false,
		market_asset_price_alerts_enabled: false,
		market_asset_price_alerts_include_email: false,
		market_asset_price_alerts_include_sms: false,
		market_asset_price_alert_onboarding_completed: false,
		...overrides,
	} as unknown as User;
}

describe("Notification preference update payloads stay aligned with user schedule behavior.", () => {
	it("Recomputes next-send timestamps when timezone changes.", () => {
		const user = makeUser();

		const payload = computeTimezoneUpdatePayload("America/Chicago", user);

		expect(payload.timezone).toBe("America/Chicago");
		expect(payload.market_scheduled_asset_price_next_send_at).toBeTruthy();
		expect(payload.daily_digest_next_send_at).toBeTruthy();
		expect(payload.asset_events_next_send_at).toBeTruthy();
	});

	it("Leaves derived send times untouched when timezone is unchanged.", () => {
		const user = makeUser({ timezone: "America/Chicago" });

		const payload = computeTimezoneUpdatePayload("America/Chicago", user);

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
		});

		expect(payload.market_scheduled_asset_price_times).toBeNull();
		expect(payload.market_scheduled_asset_price_next_send_at).toBeNull();
	});

	it("Only persists booleans explicitly submitted in the form payload.", () => {
		const user = makeUser({
			sms_notifications_enabled: false,
		});
		const formData = new FormData();
		formData.set("email_notifications_enabled", "on");

		const payload = buildNotificationPreferencesUpdatePayload({
			parsedData: {
				email_notifications_enabled: true,
				sms_notifications_enabled: true,
			},
			formData,
			rawTimesValue: null,
			dbUser: user,
		});

		expect(payload.email_notifications_enabled).toBe(true);
		expect(payload.sms_notifications_enabled).toBeUndefined();
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
		});

		expect(payload.market_scheduled_asset_price_times).toEqual([570, 660]);
		expect(payload.market_scheduled_asset_price_next_send_at).toBeTruthy();
	});
});
