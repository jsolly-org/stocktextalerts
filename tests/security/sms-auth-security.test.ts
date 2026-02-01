import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSendVerificationHandler } from "../../src/pages/api/auth/sms/send-verification";
import { createVerifyCodeHandler } from "../../src/pages/api/auth/sms/verify-code";
import { allowConsoleErrors } from "../setup";
import {
	adminClient,
	cleanupTestUser,
	createAuthenticatedCookies,
	createTestUser,
	generateUniquePhoneNumber,
} from "../shared-utils";

const { sendVerificationMock, checkVerificationMock } = vi.hoisted(() => {
	return {
		sendVerificationMock: vi.fn(),
		checkVerificationMock: vi.fn(),
	};
});

vi.mock("../../src/pages/api/auth/sms/verify-utils", () => ({
	sendVerification: sendVerificationMock,
	checkVerification: checkVerificationMock,
}));

describe("A signed-in user verifies their phone number to enable SMS alerts.", () => {
	afterEach(() => {
		sendVerificationMock.mockClear();
	});

	it("A logged-out user cannot request a verification code.", async () => {
		const phoneNumber = generateUniquePhoneNumber();
		const formData = new FormData();
		formData.append("phone_country_code", "+1");
		formData.append("phone_number", phoneNumber);

		const request = new Request(
			"http://localhost/api/auth/sms/send-verification",
			{
				method: "POST",
				body: formData,
			},
		);

		const handler = createSendVerificationHandler();
		const response = await handler({
			request,
			cookies: {
				get: () => undefined,
				set: () => {},
			},
		} as APIContext);

		expect(response.status).toBe(401);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("unauthorized");
		expect(sendVerificationMock).not.toHaveBeenCalled();
	});

	it("If the form is incomplete, the request is rejected with a validation error.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});
		try {
			const cookies = await createAuthenticatedCookies(
				testUser.email,
				"TestPassword123!",
			);

			const formData = new FormData();
			// Missing required fields

			const request = new Request(
				"http://localhost/api/auth/sms/send-verification",
				{
					method: "POST",
					body: formData,
				},
			);

			const handler = createSendVerificationHandler();
			const response = await handler({
				request,
				cookies: {
					get: (name: string) => {
						const cookie = cookies.get(name);
						return cookie ? { value: cookie } : undefined;
					},
					set: () => {},
				},
			} as APIContext);

			expect(response.status).toBe(400);
			const payload = (await response.json()) as {
				ok: boolean;
				message: string;
			};
			expect(payload.ok).toBe(false);
			expect(payload.message).toBe("invalid_form");
			expect(sendVerificationMock).not.toHaveBeenCalled();
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});

	it("A user who opted out of SMS cannot start verification again.", async () => {
		allowConsoleErrors();
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
			smsOptedOut: true,
		});
		try {
			const cookies = await createAuthenticatedCookies(
				testUser.email,
				"TestPassword123!",
			);

			const phoneNumber = generateUniquePhoneNumber();
			const formData = new FormData();
			formData.append("phone_country_code", "+1");
			formData.append("phone_number", phoneNumber);

			const request = new Request(
				"http://localhost/api/auth/sms/send-verification",
				{
					method: "POST",
					body: formData,
				},
			);

			const handler = createSendVerificationHandler();
			const response = await handler({
				request,
				cookies: {
					get: (name: string) => {
						const cookie = cookies.get(name);
						return cookie ? { value: cookie } : undefined;
					},
					set: () => {},
				},
			} as APIContext);

			expect(response.status).toBe(400);
			const payload = (await response.json()) as {
				ok: boolean;
				message: string;
			};
			expect(payload.ok).toBe(false);
			expect(payload.message).toBe("sms_opted_out");
			expect(sendVerificationMock).not.toHaveBeenCalled();
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});
});

describe("A signed-in user verifies their phone number with an SMS code.", () => {
	beforeEach(() => {
		checkVerificationMock.mockReset();
	});

	it("An invalid code is rejected and the phone number remains unverified.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
			smsNotificationsEnabled: true,
			phoneCountryCode: "+1",
			phoneNumber: "5550001234",
			phoneVerified: false,
		});

		try {
			await adminClient
				.from("users")
				.update({ verification_sent_at: new Date().toISOString() })
				.eq("id", testUser.id);

			const cookies = await createAuthenticatedCookies(
				testUser.email,
				"TestPassword123!",
			);

			checkVerificationMock.mockResolvedValue({
				success: false,
				error: "invalid",
			});

			const handler = createVerifyCodeHandler();
			const formData = new FormData();
			formData.append("code", "000000");

			const response = await handler({
				request: new Request("http://localhost/api/auth/sms/verify-code", {
					method: "POST",
					body: formData,
				}),
				cookies: {
					get: (name: string) => {
						const cookie = cookies.get(name);
						return cookie ? { value: cookie } : undefined;
					},
					set: () => {},
				},
			} as APIContext);

			expect(response.status).toBe(400);
			const json = await response.json();
			expect(json.ok).toBe(false);
			expect(json.message).toBe("invalid_code");

			const { data: updatedUser } = await adminClient
				.from("users")
				.select("phone_verified")
				.eq("id", testUser.id)
				.single();

			expect(updatedUser.phone_verified).toBe(false);
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});
});
