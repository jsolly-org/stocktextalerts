import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_MARKET_UPDATE_TIME_MINUTES } from "../../../../src/lib/constants";
import { POST } from "../../../../src/pages/api/notification-preferences/update";
import { createApiContext, createFormPostRequest } from "../../../helpers/api-context";
import { TEST_PASSWORD } from "../../../helpers/constants";
import { adminClient, createAuthenticatedCookies } from "../../../helpers/test-env";
import { createTestUser } from "../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";

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
	it("When the user sets delivery_channel to email, existing schedule fields are preserved.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			deliveryChannel: "disabled",
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const formData = new FormData();
		formData.append("delivery_channel", "email");

		const response = await postNotificationPreferencesUpdate({
			formData,
			cookies,
		});

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			message: string;
			notificationPreferences: {
				delivery_channel: string;
				market_scheduled_asset_price_times: number[] | null;
				market_scheduled_asset_price_next_send_at: string | null;
			};
		};
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");
		expect(payload.notificationPreferences.delivery_channel).toBe("email");
		expect(payload.notificationPreferences.market_scheduled_asset_price_times).toEqual([
			DEFAULT_MARKET_UPDATE_TIME_MINUTES,
		]);
		expect(payload.notificationPreferences.market_scheduled_asset_price_next_send_at).toBeTruthy();

		const { data: updatedUser } = await adminClient
			.from("users")
			.select(
				"delivery_channel,market_scheduled_asset_price_times,market_scheduled_asset_price_next_send_at",
			)
			.eq("id", testUser.id)
			.single();

		expect(updatedUser?.delivery_channel).toBe("email");
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
		formData.append("delivery_channel", "email");
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

describe("A signed-in user toggles content options on notification_preferences.", () => {
	async function readPref(
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
			.maybeSingle();
		return data?.enabled ?? null;
	}

	it("Enabling daily-digest prices creates an enabled notification_preferences row.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const formData = new FormData();
		formData.append("daily_digest_include_prices", "true");

		const response = await postNotificationPreferencesUpdate({ formData, cookies });

		expect(response.status).toBe(200);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");

		expect(await readPref(testUser.id, "daily_notification", "prices")).toBe(true);
	});

	it("Submitting the same option as false sets the row's enabled to false.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		// First enable it.
		const enableForm = new FormData();
		enableForm.append("daily_digest_include_prices", "true");
		expect(
			(await postNotificationPreferencesUpdate({ formData: enableForm, cookies })).status,
		).toBe(200);
		expect(await readPref(testUser.id, "daily_notification", "prices")).toBe(true);

		// Then disable it.
		const disableForm = new FormData();
		disableForm.append("daily_digest_include_prices", "false");
		const response = await postNotificationPreferencesUpdate({ formData: disableForm, cookies });

		expect(response.status).toBe(200);
		expect(await readPref(testUser.id, "daily_notification", "prices")).toBe(false);
	});

	it("A facet-less option (price_move_alerts) persists a row keyed on empty content.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const formData = new FormData();
		formData.append("price_move_alerts_include", "true");

		const response = await postNotificationPreferencesUpdate({ formData, cookies });

		expect(response.status).toBe(200);
		expect(await readPref(testUser.id, "price_move_alerts", "")).toBe(true);
	});

	it("Submitting an unrelated option does not clobber an existing row (no-drift).", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		// Enable daily-digest prices.
		const seedForm = new FormData();
		seedForm.append("daily_digest_include_prices", "true");
		expect((await postNotificationPreferencesUpdate({ formData: seedForm, cookies })).status).toBe(
			200,
		);
		expect(await readPref(testUser.id, "daily_notification", "prices")).toBe(true);

		// Submit a totally unrelated field.
		const unrelatedForm = new FormData();
		unrelatedForm.append("asset_events_include_analyst", "true");
		const response = await postNotificationPreferencesUpdate({
			formData: unrelatedForm,
			cookies,
		});

		expect(response.status).toBe(200);
		// The prices row is untouched (still enabled); the analyst row is newly enabled.
		expect(await readPref(testUser.id, "daily_notification", "prices")).toBe(true);
		expect(await readPref(testUser.id, "daily_notification", "analyst")).toBe(true);
	});

	it("A request mixing delivery_channel and a content option persists both.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			deliveryChannel: "disabled",
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const formData = new FormData();
		formData.append("delivery_channel", "email");
		formData.append("daily_digest_include_prices", "true");

		const response = await postNotificationPreferencesUpdate({ formData, cookies });

		expect(response.status).toBe(200);

		const { data: user } = await adminClient
			.from("users")
			.select("delivery_channel")
			.eq("id", testUser.id)
			.single();
		expect(user?.delivery_channel).toBe("email");

		expect(await readPref(testUser.id, "daily_notification", "prices")).toBe(true);
	});
});
