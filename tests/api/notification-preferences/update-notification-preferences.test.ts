import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_MARKET_UPDATE_TIME_MINUTES } from "../../../src/lib/constants";
import { POST } from "../../../src/pages/api/notification-preferences/update";
import {
	createApiContext,
	createFormPostRequest,
} from "../../helpers/api-context";
import { TEST_PASSWORD } from "../../helpers/constants";
import {
	adminClient,
	createAuthenticatedCookies,
} from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

async function postNotificationPreferencesUpdate(options: {
	formData: FormData;
	cookies: Map<string, string>;
}) {
	return POST(
		createApiContext({
			request: createFormPostRequest(
				"/api/notification-preferences/update",
				options.formData,
			),
			cookies: options.cookies,
		}),
	);
}

describe("A signed-in user updates their notification channels.", () => {
	it("The user can update realtime price-alert onboarding answers.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append("market_asset_price_alerts_include_email", "true");
		formData.append("market_asset_price_alert_risk_priority", "both_equally");
		formData.append("market_asset_price_alert_market_context", "standout");
		formData.append("market_asset_price_alert_move_size", "extreme");
		formData.append("market_asset_price_alert_follow_up_mode", "first_only");
		formData.append("market_asset_price_alert_onboarding_completed", "true");

		const response = await postNotificationPreferencesUpdate({
			formData,
			cookies,
		});

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			message: string;
			notificationPreferences: {
				market_asset_price_alert_risk_priority: string;
				market_asset_price_alert_market_context: string;
				market_asset_price_alert_move_size: string;
				market_asset_price_alert_follow_up_mode: string;
				market_asset_price_alert_onboarding_completed: boolean;
			};
		};
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");
		expect(
			payload.notificationPreferences.market_asset_price_alert_risk_priority,
		).toBe("both_equally");
		expect(
			payload.notificationPreferences.market_asset_price_alert_market_context,
		).toBe("standout");
		expect(
			payload.notificationPreferences.market_asset_price_alert_move_size,
		).toBe("extreme");
		expect(
			payload.notificationPreferences.market_asset_price_alert_follow_up_mode,
		).toBe("first_only");
		expect(
			payload.notificationPreferences
				.market_asset_price_alert_onboarding_completed,
		).toBe(true);

		const { data: updatedUser } = await adminClient
			.from("users")
			.select(
				"market_asset_price_alert_risk_priority,market_asset_price_alert_market_context,market_asset_price_alert_move_size,market_asset_price_alert_follow_up_mode,market_asset_price_alert_onboarding_completed",
			)
			.eq("id", testUser.id)
			.single();

		expect(updatedUser.market_asset_price_alert_risk_priority).toBe(
			"both_equally",
		);
		expect(updatedUser.market_asset_price_alert_market_context).toBe(
			"standout",
		);
		expect(updatedUser.market_asset_price_alert_move_size).toBe("extreme");
		expect(updatedUser.market_asset_price_alert_follow_up_mode).toBe(
			"first_only",
		);
		expect(updatedUser.market_asset_price_alert_onboarding_completed).toBe(
			true,
		);
	});

	it("The API rejects legacy price-alert enum values with 400.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append("market_asset_price_alerts_include_email", "true");
		formData.append("market_asset_price_alert_risk_priority", "big_drops");
		formData.append("market_asset_price_alert_market_context", "extreme_only");
		formData.append("market_asset_price_alert_move_size", "very_large");
		formData.append("market_asset_price_alert_follow_up_mode", "first_only");
		formData.append("market_asset_price_alert_onboarding_completed", "true");

		const response = await postNotificationPreferencesUpdate({
			formData,
			cookies,
		});

		expect(response.status).toBe(400);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("invalid_form");
	});

	it("The user can update price-alert follow-up mode to allow_follow_up.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append("market_asset_price_alerts_include_email", "true");
		formData.append("market_asset_price_alert_risk_priority", "both_equally");
		formData.append("market_asset_price_alert_market_context", "any_major");
		formData.append("market_asset_price_alert_move_size", "significant");
		formData.append(
			"market_asset_price_alert_follow_up_mode",
			"allow_follow_up",
		);
		formData.append("market_asset_price_alert_onboarding_completed", "true");

		const response = await postNotificationPreferencesUpdate({
			formData,
			cookies,
		});

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			message: string;
			notificationPreferences: {
				market_asset_price_alert_follow_up_mode: string;
			};
		};
		expect(payload.ok).toBe(true);
		expect(
			payload.notificationPreferences.market_asset_price_alert_follow_up_mode,
		).toBe("allow_follow_up");

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("market_asset_price_alert_follow_up_mode")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser.market_asset_price_alert_follow_up_mode).toBe(
			"allow_follow_up",
		);
	});

	it("When the user enables their first notification channel, scheduled updates are enabled at the default time.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			scheduledUpdatesEnabled: false,
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: false,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append("email_notifications_enabled", "true");

		const response = await postNotificationPreferencesUpdate({
			formData,
			cookies,
		});

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			message: string;
			notificationPreferences: {
				market_scheduled_asset_price_times: number[] | null;
				market_scheduled_asset_price_next_send_at: string | null;
			};
		};
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");
		expect(
			payload.notificationPreferences.market_scheduled_asset_price_times,
		).toEqual([DEFAULT_MARKET_UPDATE_TIME_MINUTES]);
		expect(
			payload.notificationPreferences.market_scheduled_asset_price_next_send_at,
		).toBeTruthy();

		const { data: updatedUser } = await adminClient
			.from("users")
			.select(
				"market_scheduled_asset_price_times,market_scheduled_asset_price_next_send_at",
			)
			.eq("id", testUser.id)
			.single();

		expect(updatedUser.market_scheduled_asset_price_times).toEqual([
			DEFAULT_MARKET_UPDATE_TIME_MINUTES,
		]);
		expect(updatedUser.market_scheduled_asset_price_next_send_at).toBeTruthy();
	});

	it("The user updates the notification time to a new hour.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append("email_notifications_enabled", "true");
		formData.append(
			"market_scheduled_asset_price_times",
			JSON.stringify(["12:00"]),
		);

		const response = await postNotificationPreferencesUpdate({
			formData,
			cookies,
		});

		expect(response.status).toBe(200);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("*")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser.market_scheduled_asset_price_times).toEqual([720]);
	});

	it("Submitted scheduled times are cleaned up and stored in order.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append(
			"market_scheduled_asset_price_times",
			JSON.stringify(["10:00", "14:00", "10:00", "11:00"]),
		);

		const response = await postNotificationPreferencesUpdate({
			formData,
			cookies,
		});

		expect(response.status).toBe(200);

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("*")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser.market_scheduled_asset_price_times).toEqual([
			600, 660, 840,
		]);
	});

	it("When all notification times are removed, scheduled updates are cleared.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			scheduledUpdatesEnabled: true,
			scheduledUpdateTimes: [480],
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append("market_scheduled_asset_price_times", "[]");

		const response = await postNotificationPreferencesUpdate({
			formData,
			cookies,
		});

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			message: string;
			notificationPreferences: {
				market_scheduled_asset_price_times: number[] | null;
				market_scheduled_asset_price_next_send_at: string | null;
			};
		};

		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");
		expect(
			payload.notificationPreferences.market_scheduled_asset_price_times,
		).toBeNull();
		expect(
			payload.notificationPreferences.market_scheduled_asset_price_next_send_at,
		).toBeNull();
	});
});
