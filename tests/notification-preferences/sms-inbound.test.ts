import type { APIContext } from "astro";
import { describe, expect, it, vi } from "vitest";
import { POST } from "../../src/pages/api/notifications/sms/inbound";
import {
	adminClient,
	buildSmsInboundRequest,
	cleanupTestUser,
	createTestUser,
} from "../shared-utils";

async function getTestUserPhone(userId: string): Promise<string> {
	const { data: user } = await adminClient
		.from("users")
		.select("phone_country_code,phone_number")
		.eq("id", userId)
		.single();
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
			phoneVerified: true,
			smsOptedOut: false,
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
				.select("sms_opted_out")
				.eq("id", testUser.id)
				.single();
			expect(updated.sms_opted_out).toBe(true);
		} finally {
			await cleanupTestUser(testUser.id);
			vi.unstubAllEnvs();
		}
	});

	it("When a user texts START, they are resubscribed to SMS notifications.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(true);

		const testUser = await createTestUser({
			smsNotificationsEnabled: true,
			phoneVerified: true,
			smsOptedOut: true,
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
			expect(body).toContain("subscribed to SMS notifications");

			const { data: updated } = await adminClient
				.from("users")
				.select("sms_opted_out")
				.eq("id", testUser.id)
				.single();
			expect(updated.sms_opted_out).toBe(false);
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
			expect(body).toContain("Reply STOP to unsubscribe");
		} finally {
			await cleanupTestUser(testUser.id);
			vi.unstubAllEnvs();
		}
	});
});
