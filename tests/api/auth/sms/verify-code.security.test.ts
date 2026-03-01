import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as verifyCodePost } from "../../../../src/pages/api/auth/sms/verify-code";
import {
	adminClient,
	createAuthenticatedCookies,
} from "../../../helpers/test-env";
import { cleanupTestUser, createTestUser } from "../../../helpers/test-user";

const { checkVerificationMock } = vi.hoisted(() => ({
	checkVerificationMock: vi.fn(),
}));

vi.mock("../../../../src/lib/auth/sms-verification", () => ({
	sendVerification: vi.fn(),
	checkVerification: checkVerificationMock,
}));

describe("A signed-in user verifies their phone number with an SMS code.", () => {
	beforeEach(() => {
		checkVerificationMock.mockReset();
	});

	it("An invalid code is rejected and the phone number remains unverified.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
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

			const formData = new FormData();
			formData.append("code", "000000");

			const response = await verifyCodePost({
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

			expect(updatedUser).not.toBeNull();
			if (!updatedUser) throw new Error("expected user row");
			expect(updatedUser.phone_verified).toBe(false);
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});

	it("If rate limits are exceeded, verification is blocked and no update occurs.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
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

			checkVerificationMock.mockResolvedValue({ success: true });

			const formData = new FormData();
			formData.append("code", "123456");

			const response = await verifyCodePost({
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
			expect(checkVerificationMock).not.toHaveBeenCalled();

			const { data: updatedUser } = await adminClient
				.from("users")
				.select("phone_verified")
				.eq("id", testUser.id)
				.single();

			expect(updatedUser).not.toBeNull();
			if (!updatedUser) throw new Error("expected user row");
			expect(updatedUser.phone_verified).toBe(false);
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});
});
