import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_MARKET_UPDATE_TIME_MINUTES } from "../../../src/lib/constants";
import { POST } from "../../../src/pages/api/notification-preferences/update";
import { createApiContext, createFormPostRequest } from "../../helpers/api-context";
import { TEST_PASSWORD } from "../../helpers/constants";
import { adminClient, createAuthenticatedCookies } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

async function postNotificationPreferencesUpdate(options: {
	formData: FormData;
	cookies: Map<string, string>;
}) {
	return POST(
		createApiContext({
			request: createFormPostRequest("/api/notification-preferences/update", options.formData),
			cookies: options.cookies,
		}),
	);
}

describe("A signed-in user updates their notification channels.", () => {
	it("The user can update price-alert move size.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const formData = new FormData();
		formData.append("market_asset_price_alerts_include_email", "true");
		formData.append("market_asset_price_alert_move_size", "extreme");

		const response = await postNotificationPreferencesUpdate({
			formData,
			cookies,
		});

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			message: string;
			notificationPreferences: {
				market_asset_price_alert_move_size: string;
			};
		};
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");
		expect(payload.notificationPreferences.market_asset_price_alert_move_size).toBe("extreme");

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("market_asset_price_alert_move_size")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser?.market_asset_price_alert_move_size).toBe("extreme");
	});

	it("The API rejects invalid price-alert move size with 400.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const formData = new FormData();
		formData.append("market_asset_price_alerts_include_email", "true");
		formData.append("market_asset_price_alert_move_size", "very_large");

		const response = await postNotificationPreferencesUpdate({
			formData,
			cookies,
		});

		expect(response.status).toBe(400);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("invalid_form");
	});

	it("When the user enables their first notification channel, scheduled updates are enabled at the default time.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: false,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

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
		expect(payload.notificationPreferences.market_scheduled_asset_price_times).toEqual([
			DEFAULT_MARKET_UPDATE_TIME_MINUTES,
		]);
		expect(payload.notificationPreferences.market_scheduled_asset_price_next_send_at).toBeTruthy();

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("market_scheduled_asset_price_times,market_scheduled_asset_price_next_send_at")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser?.market_scheduled_asset_price_times).toEqual([
			DEFAULT_MARKET_UPDATE_TIME_MINUTES,
		]);
		expect(updatedUser?.market_scheduled_asset_price_next_send_at).toBeTruthy();
	});

	it("The user updates the notification time to a new hour.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const formData = new FormData();
		formData.append("email_notifications_enabled", "true");
		formData.append("market_scheduled_asset_price_times", JSON.stringify(["12:00"]));

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
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

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

		expect(updatedUser?.market_scheduled_asset_price_times).toEqual([600, 660, 840]);
	});

	it("When all notification times are removed, scheduled updates are cleared.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			scheduledUpdateTimes: [480],
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

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
		expect(payload.notificationPreferences.market_scheduled_asset_price_times).toBeNull();
		expect(payload.notificationPreferences.market_scheduled_asset_price_next_send_at).toBeNull();
	});
});

describe("A signed-in user toggles Telegram on their notification options.", () => {
	async function readTelegramPref(
		userId: string,
		notificationType: string,
		content: string,
	): Promise<boolean | null> {
		const { data } = await adminClient
			.from("notification_preferences")
			.select("enabled")
			.eq("user_id", userId)
			.eq("notification_type", notificationType)
			.eq("content", content)
			.eq("channel", "telegram")
			.maybeSingle();
		return data?.enabled ?? null;
	}

	it("Enabling daily-digest prices for Telegram creates an enabled notification_preferences row.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const formData = new FormData();
		formData.append("daily_digest_include_prices_telegram", "true");

		const response = await postNotificationPreferencesUpdate({ formData, cookies });

		expect(response.status).toBe(200);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");

		expect(await readTelegramPref(testUser.id, "daily_digest", "prices")).toBe(true);
	});

	it("Submitting the same option as false sets the Telegram row's enabled to false.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		// First enable it.
		const enableForm = new FormData();
		enableForm.append("daily_digest_include_prices_telegram", "true");
		expect(
			(await postNotificationPreferencesUpdate({ formData: enableForm, cookies })).status,
		).toBe(200);
		expect(await readTelegramPref(testUser.id, "daily_digest", "prices")).toBe(true);

		// Then disable it.
		const disableForm = new FormData();
		disableForm.append("daily_digest_include_prices_telegram", "false");
		const response = await postNotificationPreferencesUpdate({ formData: disableForm, cookies });

		expect(response.status).toBe(200);
		expect(await readTelegramPref(testUser.id, "daily_digest", "prices")).toBe(false);
	});

	it("A facet-less option (price_move_alerts) persists a Telegram row keyed on empty content.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const formData = new FormData();
		formData.append("price_move_alerts_include_telegram", "true");

		const response = await postNotificationPreferencesUpdate({ formData, cookies });

		expect(response.status).toBe(200);
		expect(await readTelegramPref(testUser.id, "price_move_alerts", "")).toBe(true);
	});

	it("Submitting an unrelated option does not clobber an existing Telegram row (no-drift).", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		// Enable Telegram for daily-digest prices.
		const seedForm = new FormData();
		seedForm.append("daily_digest_include_prices_telegram", "true");
		expect((await postNotificationPreferencesUpdate({ formData: seedForm, cookies })).status).toBe(
			200,
		);
		expect(await readTelegramPref(testUser.id, "daily_digest", "prices")).toBe(true);

		// Submit a totally unrelated field (Telegram for a different option).
		const unrelatedForm = new FormData();
		unrelatedForm.append("asset_events_include_analyst_telegram", "true");
		const response = await postNotificationPreferencesUpdate({
			formData: unrelatedForm,
			cookies,
		});

		expect(response.status).toBe(200);
		// The prices row is untouched (still enabled); the analyst row is newly enabled.
		expect(await readTelegramPref(testUser.id, "daily_digest", "prices")).toBe(true);
		expect(await readTelegramPref(testUser.id, "asset_events", "analyst")).toBe(true);
	});

	it("A request mixing an email column write and a Telegram option persists both.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const formData = new FormData();
		// Legacy column write (email) alongside a Telegram table write.
		formData.append("daily_digest_include_prices_email", "true");
		formData.append("daily_digest_include_prices_telegram", "true");

		const response = await postNotificationPreferencesUpdate({ formData, cookies });

		expect(response.status).toBe(200);

		// Email lands on the daily-digest prices email row in notification_preferences.
		const { data: emailPref } = await adminClient
			.from("notification_preferences")
			.select("enabled")
			.eq("user_id", testUser.id)
			.eq("notification_type", "daily_digest")
			.eq("content", "prices")
			.eq("channel", "email")
			.maybeSingle();
		expect(emailPref?.enabled).toBe(true);

		// Telegram lands on notification_preferences.
		expect(await readTelegramPref(testUser.id, "daily_digest", "prices")).toBe(true);
	});
});
