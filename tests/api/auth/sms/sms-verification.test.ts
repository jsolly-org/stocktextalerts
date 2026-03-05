import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as sendVerificationPost } from "../../../../src/pages/api/auth/sms/send-verification";
import { POST as verifyCodePost } from "../../../../src/pages/api/auth/sms/verify-code";
import { createApiContext } from "../../../helpers/api-context";
import {
	adminClient,
	createAuthenticatedCookies,
} from "../../../helpers/test-env";
import {
	createTestUser,
	generateUniquePhoneNumber,
} from "../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";

const smsVerifyMocks = vi.hoisted(() => ({
	sendVerificationMock: vi.fn(),
	checkVerificationMock: vi.fn(),
}));

vi.mock("../../../../src/lib/auth/sms-verification", () => ({
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
		registerTestUserForCleanup(testUser.id);

		{
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

			const response = await sendVerificationPost(
				createApiContext({ request, cookies }),
			);

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

			expect(updatedUser).not.toBeNull();
			if (!updatedUser) throw new Error("expected user row");
			expect(updatedUser.phone_country_code).toBe("+1");
			expect(updatedUser.phone_number).toBe(phoneNumber);
			expect(updatedUser.phone_verified).toBe(false);
			expect(updatedUser.verification_sent_at).toBeTruthy();
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
			smsNotificationsEnabled: false,
			phoneCountryCode: "+1",
			phoneNumber: "5550001234",
			phoneVerified: false,
		});
		registerTestUserForCleanup(testUser.id);

		{
			await adminClient
				.from("users")
				.update({ verification_sent_at: new Date().toISOString() })
				.eq("id", testUser.id);

			const cookies = await createAuthenticatedCookies(
				testUser.email,
				"TestPassword123!",
			);

			smsVerifyMocks.checkVerificationMock.mockResolvedValue({ success: true });

			const formData = new FormData();
			formData.append("code", "123456");

			const response = await verifyCodePost(
				createApiContext({
					request: new Request("http://localhost/api/auth/sms/verify-code", {
						method: "POST",
						body: formData,
					}),
					cookies,
				}),
			);

			expect(response.status).toBe(200);
			const json = await response.json();
			expect(json.ok).toBe(true);
			expect(json.message).toBe("phone_verified");

			const { data: updatedUser } = await adminClient
				.from("users")
				.select("phone_verified,verification_sent_at,sms_notifications_enabled")
				.eq("id", testUser.id)
				.single();

			expect(updatedUser).not.toBeNull();
			if (!updatedUser) throw new Error("expected user row");
			expect(updatedUser.phone_verified).toBe(true);
			expect(updatedUser.verification_sent_at).toBeNull();
			expect(updatedUser.sms_notifications_enabled).toBe(true);
		}
	});
});
