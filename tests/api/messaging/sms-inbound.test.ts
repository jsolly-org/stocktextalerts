import type { APIContext } from "astro";
import { describe, expect, it, vi } from "vitest";
import { POST } from "../../../src/pages/api/messaging/inbound";
import { buildSmsInboundRequest } from "../../helpers/request-helpers";
import { adminClient } from "../../helpers/test-env";
import {
	cleanupTestUser,
	createTestUser,
	generateUniquePhoneNumber,
	getTestUserPhone,
} from "../../helpers/test-user";

const { validateRequestMock } = vi.hoisted(() => ({
	validateRequestMock: vi.fn(),
}));

vi.mock("twilio", () => ({
	default: {
		validateRequest: validateRequestMock,
	},
}));

describe("A user manages SMS notifications by replying to messages.", () => {
	it("When a user texts STOP, they are unsubscribed from SMS notifications but individual preferences are preserved.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(true);

		const testUser = await createTestUser({
			smsNotificationsEnabled: true,
			emailNotificationsEnabled: false,
			phoneVerified: true,
		});

		try {
			const from = await getTestUserPhone(testUser.id);
			const { error: seedSmsFieldsError } = await adminClient
				.from("users")
				.update({
					market_scheduled_asset_price_include_sms: true,
					asset_events_include_calendar_sms: true,
					asset_events_include_ipo_sms: true,
					asset_events_include_analyst_sms: true,
					asset_events_include_insider_sms: true,
					market_asset_price_alerts_include_sms: true,
				})
				.eq("id", testUser.id);
			if (seedSmsFieldsError) {
				throw new Error(seedSmsFieldsError.message);
			}

			const response = await POST({
				request: buildSmsInboundRequest({
					from,
					body: "STOP",
					includeSignature: true,
				}),
			} as APIContext);

			expect(response.status).toBe(200);
			const body = await response.text();
			expect(body).toContain("unsubscribed from SMS notifications");

			const { data: updated } = await adminClient
				.from("users")
				.select(
					[
						"sms_opted_out",
						"sms_notifications_enabled",
						"market_scheduled_asset_price_include_sms",
						"asset_events_include_calendar_sms",
						"asset_events_include_ipo_sms",
						"asset_events_include_analyst_sms",
						"asset_events_include_insider_sms",
						"market_asset_price_alerts_include_sms",
					].join(","),
				)
				.eq("id", testUser.id)
				.single();
			expect(updated).not.toBeNull();
			if (!updated) throw new Error("expected user row");
			expect(updated.sms_opted_out).toBe(true);
			expect(updated.sms_notifications_enabled).toBe(false);
			// Individual preferences are preserved (not zeroed out)
			expect(updated.market_scheduled_asset_price_include_sms).toBe(true);
			expect(updated.asset_events_include_calendar_sms).toBe(true);
			expect(updated.asset_events_include_ipo_sms).toBe(true);
			expect(updated.asset_events_include_analyst_sms).toBe(true);
			expect(updated.asset_events_include_insider_sms).toBe(true);
			expect(updated.market_asset_price_alerts_include_sms).toBe(true);
		} finally {
			await cleanupTestUser(testUser.id);
			vi.unstubAllEnvs();
		}
	});

	it("When a user texts STOP ALL, they are unsubscribed from both channels but individual SMS preferences are preserved.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(true);

		const testUser = await createTestUser({
			smsNotificationsEnabled: true,
			emailNotificationsEnabled: true,
			phoneVerified: true,
		});

		try {
			const from = await getTestUserPhone(testUser.id);

			const { error: seedError } = await adminClient
				.from("users")
				.update({ market_scheduled_asset_price_include_sms: true })
				.eq("id", testUser.id);
			if (seedError) throw new Error(seedError.message);

			const response = await POST({
				request: buildSmsInboundRequest({
					from,
					body: "STOP ALL",
					includeSignature: true,
				}),
			} as APIContext);

			expect(response.status).toBe(200);
			const body = await response.text();
			expect(body).toContain("unsubscribed from SMS and email");

			const { data: updated } = await adminClient
				.from("users")
				.select(
					"email_notifications_enabled,sms_opted_out,sms_notifications_enabled,market_scheduled_asset_price_include_sms",
				)
				.eq("id", testUser.id)
				.single();
			expect(updated).not.toBeNull();
			if (!updated) throw new Error("expected user row");
			expect(updated.email_notifications_enabled).toBe(false);
			expect(updated.sms_opted_out).toBe(true);
			expect(updated.sms_notifications_enabled).toBe(false);
			// Individual preference preserved
			expect(updated.market_scheduled_asset_price_include_sms).toBe(true);
		} finally {
			await cleanupTestUser(testUser.id);
			vi.unstubAllEnvs();
		}
	});

	it("When a user texts STOP EMAIL, only email notifications are disabled.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(true);

		const testUser = await createTestUser({
			smsNotificationsEnabled: true,
			emailNotificationsEnabled: true,
			phoneVerified: true,
		});

		try {
			const from = await getTestUserPhone(testUser.id);

			const response = await POST({
				request: buildSmsInboundRequest({
					from,
					body: "STOP EMAIL",
					includeSignature: true,
				}),
			} as APIContext);

			expect(response.status).toBe(200);
			const body = await response.text();
			expect(body).toContain("Email notifications are now off");

			const { data: updated } = await adminClient
				.from("users")
				.select(
					"email_notifications_enabled,sms_opted_out,market_scheduled_asset_price_include_sms",
				)
				.eq("id", testUser.id)
				.single();
			expect(updated).not.toBeNull();
			if (!updated) throw new Error("expected user row");
			expect(updated.email_notifications_enabled).toBe(false);
			expect(updated.sms_opted_out).toBe(false);
			expect(updated.market_scheduled_asset_price_include_sms).toBe(true);
		} finally {
			await cleanupTestUser(testUser.id);
			vi.unstubAllEnvs();
		}
	});

	it("When a user texts START, sms_opted_out is cleared but sms_notifications_enabled remains unchanged.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(true);

		const testUser = await createTestUser({
			smsNotificationsEnabled: false,
			smsOptedOut: true,
			phoneVerified: true,
			phoneCountryCode: "+1",
			phoneNumber: generateUniquePhoneNumber(),
		});

		try {
			const from = await getTestUserPhone(testUser.id);

			const { error: seedError } = await adminClient
				.from("users")
				.update({ market_scheduled_asset_price_include_sms: true })
				.eq("id", testUser.id);
			if (seedError) throw new Error(seedError.message);

			const response = await POST({
				request: buildSmsInboundRequest({
					from,
					body: "START",
					includeSignature: true,
				}),
			} as APIContext);

			expect(response.status).toBe(200);
			const body = await response.text();
			expect(body).toContain("Re-enable SMS notifications from your dashboard");

			const { data: updated } = await adminClient
				.from("users")
				.select(
					"sms_opted_out,sms_notifications_enabled,market_scheduled_asset_price_include_sms",
				)
				.eq("id", testUser.id)
				.single();
			expect(updated).not.toBeNull();
			if (!updated) throw new Error("expected user row");
			expect(updated.sms_opted_out).toBe(false);
			expect(updated.sms_notifications_enabled).toBe(false);
			// Individual field stays unchanged (seeded true, stays true)
			expect(updated.market_scheduled_asset_price_include_sms).toBe(true);
		} finally {
			await cleanupTestUser(testUser.id);
			vi.unstubAllEnvs();
		}
	});

	it("STOP then START round-trip preserves individual SMS preferences.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValue(true);

		const testUser = await createTestUser({
			smsNotificationsEnabled: true,
			emailNotificationsEnabled: false,
			phoneVerified: true,
		});

		try {
			const from = await getTestUserPhone(testUser.id);

			// Seed individual SMS preferences
			const { error: seedError } = await adminClient
				.from("users")
				.update({
					market_scheduled_asset_price_include_sms: true,
					asset_events_include_calendar_sms: true,
					asset_events_include_ipo_sms: false,
					asset_events_include_analyst_sms: true,
					asset_events_include_insider_sms: false,
					market_asset_price_alerts_include_sms: true,
				})
				.eq("id", testUser.id);
			if (seedError) throw new Error(seedError.message);

			// STOP
			const stopResponse = await POST({
				request: buildSmsInboundRequest({
					from,
					body: "STOP",
					includeSignature: true,
				}),
			} as APIContext);
			expect(stopResponse.status).toBe(200);

			// START
			const startResponse = await POST({
				request: buildSmsInboundRequest({
					from,
					body: "START",
					includeSignature: true,
				}),
			} as APIContext);
			expect(startResponse.status).toBe(200);

			const { data: updated } = await adminClient
				.from("users")
				.select(
					[
						"sms_opted_out",
						"sms_notifications_enabled",
						"market_scheduled_asset_price_include_sms",
						"asset_events_include_calendar_sms",
						"asset_events_include_ipo_sms",
						"asset_events_include_analyst_sms",
						"asset_events_include_insider_sms",
						"market_asset_price_alerts_include_sms",
					].join(","),
				)
				.eq("id", testUser.id)
				.single();
			expect(updated).not.toBeNull();
			if (!updated) throw new Error("expected user row");

			// STOP opt-out flag is cleared, but global SMS flag remains unchanged (still disabled)
			expect(updated.sms_opted_out).toBe(false);
			expect(updated.sms_notifications_enabled).toBe(false);

			// Individual preferences fully preserved through the round trip
			expect(updated.market_scheduled_asset_price_include_sms).toBe(true);
			expect(updated.asset_events_include_calendar_sms).toBe(true);
			expect(updated.asset_events_include_ipo_sms).toBe(false);
			expect(updated.asset_events_include_analyst_sms).toBe(true);
			expect(updated.asset_events_include_insider_sms).toBe(false);
			expect(updated.market_asset_price_alerts_include_sms).toBe(true);
		} finally {
			validateRequestMock.mockReset();
			await cleanupTestUser(testUser.id);
			vi.unstubAllEnvs();
		}
	});

	it("When a user texts HELP, they receive the help message.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(true);

		const testUser = await createTestUser({
			smsNotificationsEnabled: true,
			phoneVerified: true,
		});

		try {
			const from = await getTestUserPhone(testUser.id);

			const response = await POST({
				request: buildSmsInboundRequest({
					from,
					body: "HELP",
					includeSignature: true,
				}),
			} as APIContext);

			expect(response.status).toBe(200);
			const body = await response.text();
			expect(body).toContain("STOP ALL");
		} finally {
			await cleanupTestUser(testUser.id);
			vi.unstubAllEnvs();
		}
	});

	it("When a user texts an unknown command, they receive the unknown-command message.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(true);

		const testUser = await createTestUser({
			smsNotificationsEnabled: true,
			phoneVerified: true,
		});

		try {
			const from = await getTestUserPhone(testUser.id);

			const response = await POST({
				request: buildSmsInboundRequest({
					from,
					body: "random text",
					includeSignature: true,
				}),
			} as APIContext);

			expect(response.status).toBe(200);
			const body = await response.text();
			expect(body).toContain("Unknown command");
			expect(body).toContain("HELP");
		} finally {
			await cleanupTestUser(testUser.id);
			vi.unstubAllEnvs();
		}
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

		try {
			const from = await getTestUserPhone(testUser.id);

			const response = await POST({
				request: buildSmsInboundRequest({
					from,
					body: "STOP",
					includeSignature: true,
				}),
			} as APIContext);

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
			expect(updated?.sms_opted_out).toBe(false);
			expect(updated?.sms_notifications_enabled).toBe(true);
		} finally {
			await cleanupTestUser(testUser.id);
			vi.unstubAllEnvs();
		}
	});

	it("When an unknown phone number texts STOP, the response is empty and no error is returned.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(true);

		const response = await POST({
			request: buildSmsInboundRequest({
				from: "+15559999999",
				body: "STOP",
				includeSignature: true,
			}),
		} as APIContext);

		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).not.toContain("unsubscribed");
		expect(body).not.toContain("error");
	});
});
