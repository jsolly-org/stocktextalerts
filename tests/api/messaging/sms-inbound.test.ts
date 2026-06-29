import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../../src/pages/api/messaging/inbound";
import { createApiContext } from "../../helpers/api-context";
import { buildSmsInboundRequest } from "../../helpers/request-helpers";
import { adminClient } from "../../helpers/test-env";
import {
	createTestUser,
	generateUniquePhoneNumber,
	getTestUserPhone,
	setTestUserPrefs,
} from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

/** Read a single per-option preference's enabled state from notification_preferences. */
async function readPref(
	userId: string,
	notificationType: string,
	content: string,
	channel: string,
): Promise<boolean | null> {
	const { data } = await adminClient
		.from("notification_preferences")
		.select("enabled")
		.eq("user_id", userId)
		.eq("notification_type", notificationType)
		.eq("content", content)
		.eq("channel", channel)
		.maybeSingle();
	return data?.enabled ?? null;
}

const { validateRequestMock } = vi.hoisted(() => ({
	validateRequestMock: vi.fn(),
}));

vi.mock("twilio", () => ({
	default: {
		validateRequest: validateRequestMock,
	},
}));

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("A user manages SMS notifications by replying to messages.", () => {
	it("When a user texts STOP, they are unsubscribed from SMS notifications but individual preferences are preserved.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(true);

		const testUser = await createTestUser({
			smsNotificationsEnabled: true,
			emailNotificationsEnabled: false,
			phoneVerified: true,
		});
		registerTestUserForCleanup(testUser.id);

		const from = await getTestUserPhone(testUser.id);
		// Per-option SMS prefs live in notification_preferences. Enable the facets
		// whose preservation through STOP this test verifies.
		await setTestUserPrefs(testUser.id, [
			["market_scheduled_asset_price", "", "sms", true],
			["daily_notification", "calendar", "sms", true],
			["daily_notification", "ipo", "sms", true],
			["daily_notification", "analyst", "sms", true],
			["daily_notification", "insider", "sms", true],
			["market_asset_price_alerts", "", "sms", true],
		]);

		const response = await POST(
			createApiContext({
				request: buildSmsInboundRequest({
					from,
					body: "STOP",
					includeSignature: true,
				}),
			}),
		);

		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("unsubscribed from SMS notifications");

		const { data: updated } = await adminClient
			.from("users")
			.select("sms_opted_out,sms_notifications_enabled")
			.eq("id", testUser.id)
			.single();
		expect(updated).not.toBeNull();
		if (!updated) throw new Error("expected user row");
		expect(updated.sms_opted_out).toBe(true);
		expect(updated.sms_notifications_enabled).toBe(false);
		// Individual preferences are preserved (not zeroed out)
		expect(await readPref(testUser.id, "market_scheduled_asset_price", "", "sms")).toBe(true);
		expect(await readPref(testUser.id, "daily_notification", "calendar", "sms")).toBe(true);
		expect(await readPref(testUser.id, "daily_notification", "ipo", "sms")).toBe(true);
		expect(await readPref(testUser.id, "daily_notification", "analyst", "sms")).toBe(true);
		expect(await readPref(testUser.id, "daily_notification", "insider", "sms")).toBe(true);
		expect(await readPref(testUser.id, "market_asset_price_alerts", "", "sms")).toBe(true);
	});

	it("When a user texts STOP ALL, they are unsubscribed from both channels but individual SMS preferences are preserved.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(true);

		const testUser = await createTestUser({
			smsNotificationsEnabled: true,
			emailNotificationsEnabled: true,
			phoneVerified: true,
		});
		registerTestUserForCleanup(testUser.id);

		const from = await getTestUserPhone(testUser.id);

		// createTestUser seeds market_scheduled_asset_price sms = smsNotificationsEnabled (true here),
		// so the facet is already enabled by default — no extra seeding needed.

		const response = await POST(
			createApiContext({
				request: buildSmsInboundRequest({
					from,
					body: "STOP ALL",
					includeSignature: true,
				}),
			}),
		);

		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("unsubscribed from SMS and email");

		const { data: updated } = await adminClient
			.from("users")
			.select("email_notifications_enabled,sms_opted_out,sms_notifications_enabled")
			.eq("id", testUser.id)
			.single();
		expect(updated).not.toBeNull();
		if (!updated) throw new Error("expected user row");
		expect(updated.email_notifications_enabled).toBe(false);
		expect(updated.sms_opted_out).toBe(true);
		expect(updated.sms_notifications_enabled).toBe(false);
		// Individual preference preserved
		expect(await readPref(testUser.id, "market_scheduled_asset_price", "", "sms")).toBe(true);
	});

	it("When a user texts STOP EMAIL, only email notifications are disabled.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(true);

		const testUser = await createTestUser({
			smsNotificationsEnabled: true,
			emailNotificationsEnabled: true,
			phoneVerified: true,
		});
		registerTestUserForCleanup(testUser.id);

		const from = await getTestUserPhone(testUser.id);

		const response = await POST(
			createApiContext({
				request: buildSmsInboundRequest({
					from,
					body: "STOP EMAIL",
					includeSignature: true,
				}),
			}),
		);

		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("Email notifications are now off");

		const { data: updated } = await adminClient
			.from("users")
			.select("email_notifications_enabled,sms_opted_out")
			.eq("id", testUser.id)
			.single();
		expect(updated).not.toBeNull();
		if (!updated) throw new Error("expected user row");
		expect(updated.email_notifications_enabled).toBe(false);
		expect(updated.sms_opted_out).toBe(false);
		expect(await readPref(testUser.id, "market_scheduled_asset_price", "", "sms")).toBe(true);
	});

	it("When a user texts START, sms_opted_out is cleared and sms_notifications_enabled is turned on.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(true);

		const testUser = await createTestUser({
			smsNotificationsEnabled: false,
			smsOptedOut: true,
			phoneVerified: true,
			phoneCountryCode: "+1",
			phoneNumber: generateUniquePhoneNumber(),
		});
		registerTestUserForCleanup(testUser.id);

		const from = await getTestUserPhone(testUser.id);

		// Non-default for this user (sms off), so enable the facet explicitly.
		await setTestUserPrefs(testUser.id, [["market_scheduled_asset_price", "", "sms", true]]);

		const response = await POST(
			createApiContext({
				request: buildSmsInboundRequest({
					from,
					body: "START",
					includeSignature: true,
				}),
			}),
		);

		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("SMS notifications are now on");

		const { data: updated } = await adminClient
			.from("users")
			.select("sms_opted_out,sms_notifications_enabled")
			.eq("id", testUser.id)
			.single();
		expect(updated).not.toBeNull();
		if (!updated) throw new Error("expected user row");
		expect(updated.sms_opted_out).toBe(false);
		expect(updated.sms_notifications_enabled).toBe(true);
		// Individual field stays unchanged (seeded true, stays true)
		expect(await readPref(testUser.id, "market_scheduled_asset_price", "", "sms")).toBe(true);
	});

	it("STOP then START round-trip preserves individual SMS preferences.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValue(true);

		const testUser = await createTestUser({
			smsNotificationsEnabled: true,
			emailNotificationsEnabled: false,
			phoneVerified: true,
		});
		registerTestUserForCleanup(testUser.id);

		const from = await getTestUserPhone(testUser.id);

		// Seed individual SMS preferences. createTestUser already defaults
		// market_scheduled_asset_price sms = true (smsNotificationsEnabled) and every
		// asset_events / market_asset_price_alerts sms facet = false, so only the
		// non-default trues need explicit seeding here.
		await setTestUserPrefs(testUser.id, [
			["daily_notification", "calendar", "sms", true],
			["daily_notification", "analyst", "sms", true],
			["market_asset_price_alerts", "", "sms", true],
		]);

		// STOP
		const stopResponse = await POST(
			createApiContext({
				request: buildSmsInboundRequest({
					from,
					body: "STOP",
					includeSignature: true,
				}),
			}),
		);
		expect(stopResponse.status).toBe(200);

		// START
		const startResponse = await POST(
			createApiContext({
				request: buildSmsInboundRequest({
					from,
					body: "START",
					includeSignature: true,
				}),
			}),
		);
		expect(startResponse.status).toBe(200);

		const { data: updated } = await adminClient
			.from("users")
			.select("sms_opted_out,sms_notifications_enabled")
			.eq("id", testUser.id)
			.single();
		expect(updated).not.toBeNull();
		if (!updated) throw new Error("expected user row");

		// STOP opt-out flag is cleared, and global SMS toggle is re-enabled
		expect(updated.sms_opted_out).toBe(false);
		expect(updated.sms_notifications_enabled).toBe(true);

		// Individual preferences fully preserved through the round trip
		expect(await readPref(testUser.id, "market_scheduled_asset_price", "", "sms")).toBe(true);
		expect(await readPref(testUser.id, "daily_notification", "calendar", "sms")).toBe(true);
		expect(await readPref(testUser.id, "daily_notification", "ipo", "sms")).toBe(false);
		expect(await readPref(testUser.id, "daily_notification", "analyst", "sms")).toBe(true);
		expect(await readPref(testUser.id, "daily_notification", "insider", "sms")).toBe(false);
		expect(await readPref(testUser.id, "market_asset_price_alerts", "", "sms")).toBe(true);

		validateRequestMock.mockReset();
	});

	it("When a user texts HELP, they receive the help message.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(true);

		const testUser = await createTestUser({
			smsNotificationsEnabled: true,
			phoneVerified: true,
		});
		registerTestUserForCleanup(testUser.id);

		const from = await getTestUserPhone(testUser.id);

		const response = await POST(
			createApiContext({
				request: buildSmsInboundRequest({
					from,
					body: "HELP",
					includeSignature: true,
				}),
			}),
		);

		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("STOP ALL");
	});

	it("When a user texts an unknown command, they receive the unknown-command message.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(true);

		const testUser = await createTestUser({
			smsNotificationsEnabled: true,
			phoneVerified: true,
		});
		registerTestUserForCleanup(testUser.id);

		const from = await getTestUserPhone(testUser.id);

		const response = await POST(
			createApiContext({
				request: buildSmsInboundRequest({
					from,
					body: "random text",
					includeSignature: true,
				}),
			}),
		);

		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("Unknown command");
		expect(body).toContain("HELP");
	});

	it("When a user with unverified phone texts STOP, they receive the verification prompt.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(true);

		const testUser = await createTestUser({
			smsNotificationsEnabled: true,
			phoneVerified: false,
			phoneCountryCode: "+1",
			phoneNumber: generateUniquePhoneNumber(),
		});
		registerTestUserForCleanup(testUser.id);

		const from = await getTestUserPhone(testUser.id);

		const response = await POST(
			createApiContext({
				request: buildSmsInboundRequest({
					from,
					body: "STOP",
					includeSignature: true,
				}),
			}),
		);

		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("Phone number not verified");
		expect(body).toContain("verify your phone number first");

		const { data: updated } = await adminClient
			.from("users")
			.select("sms_opted_out,sms_notifications_enabled")
			.eq("id", testUser.id)
			.single();
		expect(updated).not.toBeNull();
		if (!updated) throw new Error("expected user row");
		expect(updated.sms_opted_out).toBe(false);
		expect(updated.sms_notifications_enabled).toBe(true);
	});

	it("When an unknown phone number texts STOP, the response is empty and no error is returned.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(true);

		const response = await POST(
			createApiContext({
				request: buildSmsInboundRequest({
					from: "+15559999999",
					body: "STOP",
					includeSignature: true,
				}),
			}),
		);

		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).not.toContain("unsubscribed");
		expect(body).not.toContain("error");
	});
});
