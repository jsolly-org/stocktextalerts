import type { APIContext } from "astro";
import { describe, expect, it, vi } from "vitest";
import { POST } from "../../../src/pages/api/messaging/inbound";
import {
	adminClient,
	buildSmsInboundRequest,
	cleanupTestUser,
	createTestUser,
	generateUniquePhoneNumber,
} from "../../helpers/shared-utils";

async function getTestUserPhone(userId: string): Promise<string> {
	const { data: user } = await adminClient
		.from("users")
		.select("phone_country_code,phone_number")
		.eq("id", userId)
		.single();
	if (!user) throw new Error("expected user row");
	return `${user.phone_country_code}${user.phone_number}`;
}

const { validateRequestMock } = vi.hoisted(() => ({
	validateRequestMock: vi.fn(),
}));

vi.mock("twilio", () => ({
	default: {
		validateRequest: validateRequestMock,
	},
}));

describe("A user manages SMS notifications by replying to messages.", () => {
	it("When a user texts STOP, they are unsubscribed from SMS notifications.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(true);

		const testUser = await createTestUser({
			smsNotificationsEnabled: true,
			emailNotificationsEnabled: false,
			phoneVerified: true,
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
			expect(body).toContain("unsubscribed from SMS notifications");

			const { data: updated } = await adminClient
				.from("users")
				.select("sms_notifications_enabled,sms_opted_out")
				.eq("id", testUser.id)
				.single();
			expect(updated).not.toBeNull();
			if (!updated) throw new Error("expected user row");
			expect(updated.sms_notifications_enabled).toBe(false);
			expect(updated.sms_opted_out).toBe(true);
		} finally {
			await cleanupTestUser(testUser.id);
			vi.unstubAllEnvs();
		}
	});

	it("When a user texts STOP ALL, they are unsubscribed from both channels.", async () => {
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
					"sms_notifications_enabled,email_notifications_enabled,sms_opted_out",
				)
				.eq("id", testUser.id)
				.single();
			expect(updated).not.toBeNull();
			if (!updated) throw new Error("expected user row");
			expect(updated.sms_notifications_enabled).toBe(false);
			expect(updated.email_notifications_enabled).toBe(false);
			expect(updated.sms_opted_out).toBe(true);
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
					"sms_notifications_enabled,email_notifications_enabled,sms_opted_out",
				)
				.eq("id", testUser.id)
				.single();
			expect(updated).not.toBeNull();
			if (!updated) throw new Error("expected user row");
			expect(updated.sms_notifications_enabled).toBe(true);
			expect(updated.email_notifications_enabled).toBe(false);
			expect(updated.sms_opted_out).toBe(false);
		} finally {
			await cleanupTestUser(testUser.id);
			vi.unstubAllEnvs();
		}
	});

	it("When a user texts START, sms_opted_out is cleared but SMS stays disabled.", async () => {
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

			const response = await POST({
				request: buildSmsInboundRequest({
					from,
					body: "START",
					includeSignature: true,
				}),
			} as APIContext);

			expect(response.status).toBe(200);
			const body = await response.text();
			expect(body).toContain("unblocked");
			expect(body).toContain("visit your dashboard");

			const { data: updated } = await adminClient
				.from("users")
				.select("sms_notifications_enabled,sms_opted_out")
				.eq("id", testUser.id)
				.single();
			expect(updated).not.toBeNull();
			if (!updated) throw new Error("expected user row");
			expect(updated.sms_opted_out).toBe(false);
			expect(updated.sms_notifications_enabled).toBe(false);
		} finally {
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
});
