import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERIFICATION_RESEND_COOLDOWN_MS } from "../../src/lib/constants";
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

const smsVerifyMocks = vi.hoisted(() => ({
	sendVerificationMock: vi.fn(),
	checkVerificationMock: vi.fn(),
}));

vi.mock("../../src/pages/api/auth/sms/verify-utils", () => ({
	sendVerification: smsVerifyMocks.sendVerificationMock,
	checkVerification: smsVerifyMocks.checkVerificationMock,
}));

/* ============= Send verification ============= */

describe("A signed-in user verifies their phone number to enable SMS alerts.", () => {
	afterEach(() => {
		smsVerifyMocks.sendVerificationMock.mockClear();
	});

	it("A signed-in user requests a verification code for their phone number and receives a confirmation.", async () => {
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

			smsVerifyMocks.sendVerificationMock.mockResolvedValue({ success: true });

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
			} as unknown as APIContext);

			expect(response.status).toBe(200);
			const payload = (await response.json()) as {
				ok: boolean;
				message: string;
			};
			expect(payload.ok).toBe(true);
			expect(payload.message).toBe("verification_sent");

			expect(smsVerifyMocks.sendVerificationMock).toHaveBeenCalledWith(
				`+1${phoneNumber}`,
			);

			const { data: updatedUser } = await adminClient
				.from("users")
				.select("*")
				.eq("id", testUser.id)
				.single();

			expect(updatedUser.phone_country_code).toBe("+1");
			expect(updatedUser.phone_number).toBe(phoneNumber);
			expect(updatedUser.sms_notifications_enabled).toBe(true);
			expect(updatedUser.phone_verified).toBe(false);
			expect(updatedUser.verification_sent_at).toBeTruthy();
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});

	it("When a verified phone number is changed, the user must verify the new number again.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

		try {
			const existingPhoneNumber = generateUniquePhoneNumber();
			await adminClient
				.from("users")
				.update({
					phone_country_code: "+1",
					phone_number: existingPhoneNumber,
					phone_verified: true,
					sms_notifications_enabled: true,
				})
				.eq("id", testUser.id);

			const cookies = await createAuthenticatedCookies(
				testUser.email,
				"TestPassword123!",
			);

			smsVerifyMocks.sendVerificationMock.mockResolvedValue({ success: true });

			const newPhoneNumber = generateUniquePhoneNumber();
			const formData = new FormData();
			formData.append("phone_country_code", "+1");
			formData.append("phone_number", newPhoneNumber);

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
			} as unknown as APIContext);

			expect(response.status).toBe(200);
			const payload = (await response.json()) as {
				ok: boolean;
				message: string;
			};
			expect(payload.ok).toBe(true);
			expect(payload.message).toBe("verification_sent");

			expect(smsVerifyMocks.sendVerificationMock).toHaveBeenCalledWith(
				`+1${newPhoneNumber}`,
			);

			const { data: updatedUser } = await adminClient
				.from("users")
				.select("*")
				.eq("id", testUser.id)
				.single();

			expect(updatedUser.phone_country_code).toBe("+1");
			expect(updatedUser.phone_number).toBe(newPhoneNumber);
			expect(updatedUser.phone_verified).toBe(false);
			expect(updatedUser.verification_sent_at).toBeTruthy();
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});

	it("After the cooldown expires, the user can request another verification code.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

		try {
			const oldTimestamp = new Date(
				Date.now() - VERIFICATION_RESEND_COOLDOWN_MS - 1000,
			).toISOString();

			await adminClient
				.from("users")
				.update({ verification_sent_at: oldTimestamp })
				.eq("id", testUser.id);

			const cookies = await createAuthenticatedCookies(
				testUser.email,
				"TestPassword123!",
			);

			smsVerifyMocks.sendVerificationMock.mockResolvedValue({ success: true });

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
			} as unknown as APIContext);

			expect(response.status).toBe(200);
			const payload = (await response.json()) as {
				ok: boolean;
				message: string;
			};
			expect(payload.ok).toBe(true);
			expect(payload.message).toBe("verification_sent");

			expect(smsVerifyMocks.sendVerificationMock).toHaveBeenCalledWith(
				`+1${phoneNumber}`,
			);
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});

	it("If a verification code was sent recently, the user is asked to wait before requesting another.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

		try {
			const recentTimestamp = new Date(
				Date.now() - VERIFICATION_RESEND_COOLDOWN_MS + 1000,
			).toISOString();

			await adminClient
				.from("users")
				.update({ verification_sent_at: recentTimestamp })
				.eq("id", testUser.id);

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
			} as unknown as APIContext);

			expect(response.status).toBe(429);
			const payload = (await response.json()) as {
				ok: boolean;
				message: string;
				tone?: string;
			};
			expect(payload.ok).toBe(false);
			expect(payload.message).toBe("verification_recently_sent");
			expect(payload.tone).toBe("warning");

			expect(smsVerifyMocks.sendVerificationMock).not.toHaveBeenCalled();
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
			} as unknown as APIContext);

			expect(response.status).toBe(400);
			const payload = (await response.json()) as {
				ok: boolean;
				message: string;
			};
			expect(payload.ok).toBe(false);
			expect(payload.message).toBe("sms_opted_out");
			expect(smsVerifyMocks.sendVerificationMock).not.toHaveBeenCalled();
		} finally {
			await cleanupTestUser(testUser.id);
		}
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
		expect(smsVerifyMocks.sendVerificationMock).not.toHaveBeenCalled();
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
			expect(smsVerifyMocks.sendVerificationMock).not.toHaveBeenCalled();
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});

	it("If sending the verification code fails, the user receives an error and no timestamp is saved.", async () => {
		allowConsoleErrors();
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

			smsVerifyMocks.sendVerificationMock.mockResolvedValue({
				success: false,
				error: "Twilio API error",
			});

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

			expect(response.status).toBe(500);
			const payload = (await response.json()) as {
				ok: boolean;
				message: string;
			};
			expect(payload.ok).toBe(false);
			expect(payload.message).toBe("verification_failed");

			const { data: updatedUser } = await adminClient
				.from("users")
				.select("verification_sent_at")
				.eq("id", testUser.id)
				.single();

			expect(updatedUser.verification_sent_at).toBeNull();
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});
});

/* ============= Verify code ============= */

describe("A signed-in user verifies their phone number with an SMS code.", () => {
	afterEach(() => {
		smsVerifyMocks.checkVerificationMock.mockClear();
	});

	it("A valid code confirms the phone number and clears the pending verification.", async () => {
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

			smsVerifyMocks.checkVerificationMock.mockResolvedValue({ success: true });

			const handler = createVerifyCodeHandler();

			const formData = new FormData();
			formData.append("code", "123456");

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
			} as unknown as APIContext);

			expect(response.status).toBe(200);
			const json = await response.json();
			expect(json.ok).toBe(true);
			expect(json.message).toBe("phone_verified");

			const { data: updatedUser } = await adminClient
				.from("users")
				.select("phone_verified,verification_sent_at")
				.eq("id", testUser.id)
				.single();

			expect(updatedUser.phone_verified).toBe(true);
			expect(updatedUser.verification_sent_at).toBeNull();
		} finally {
			await cleanupTestUser(testUser.id);
		}
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

			smsVerifyMocks.checkVerificationMock.mockResolvedValue({
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
			} as unknown as APIContext);

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

	it("If rate limits are exceeded, verification is blocked and no update occurs.", async () => {
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

			const { error: rateLimitError } = await adminClient
				.from("rate_limit_log")
				.insert(
					Array.from({ length: 10 }, () => ({
						user_id: testUser.id,
						endpoint: "sms_verify_code",
					})),
				);
			expect(rateLimitError).toBeNull();

			const cookies = await createAuthenticatedCookies(
				testUser.email,
				"TestPassword123!",
			);

			smsVerifyMocks.checkVerificationMock.mockResolvedValue({ success: true });

			const handler = createVerifyCodeHandler();
			const formData = new FormData();
			formData.append("code", "123456");

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
			} as unknown as APIContext);

			expect(response.status).toBe(429);
			const json = await response.json();
			expect(json.ok).toBe(false);
			expect(json.message).toBe("verification_rate_limited");
			expect(smsVerifyMocks.checkVerificationMock).not.toHaveBeenCalled();

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
