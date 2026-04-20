import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERIFICATION_RESEND_COOLDOWN_MS } from "../../../../src/lib/constants";
import { POST as sendVerificationPost } from "../../../../src/pages/api/auth/sms/send-verification";
import { createApiContext } from "../../../helpers/api-context";
import {
	adminClient,
	createAuthenticatedCookies,
} from "../../../helpers/test-env";
import {
	cleanupTestUser,
	createTestUser,
	generateUniquePhoneNumber,
} from "../../../helpers/test-user";

const { sendVerificationMock } = vi.hoisted(() => ({
	sendVerificationMock: vi.fn(),
}));

vi.mock("../../../../src/lib/auth/sms-verification", () => ({
	sendVerification: sendVerificationMock,
	checkVerification: vi.fn(),
}));

describe("A signed-in user requests an SMS verification code.", () => {
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

		const response = await sendVerificationPost(createApiContext({ request }));

		expect(response.status).toBe(401);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("unauthorized");
		expect(sendVerificationMock).not.toHaveBeenCalled();
	});

	it("If the phone number format is invalid, the request is rejected.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: "TestPassword123!",
			confirmed: true,
		});
		try {
			const cookies = await createAuthenticatedCookies(
				testUser.email,
				"TestPassword123!",
			);

			const formData = new FormData();
			formData.append("phone_country_code", "1"); // missing +
			formData.append("phone_number", "5551234567");

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

			expect(response.status).toBe(400);
			const payload = (await response.json()) as {
				ok: boolean;
				message: string;
			};
			expect(payload.ok).toBe(false);
			expect(payload.message).toBe("invalid_phone_format");
			expect(sendVerificationMock).not.toHaveBeenCalled();
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});

	it("If the form is incomplete, the request is rejected with a validation error.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
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

			const response = await sendVerificationPost(
				createApiContext({ request, cookies }),
			);

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

	it("When a verified phone number is changed, the user must verify the new number again.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
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
				})
				.eq("id", testUser.id);

			const cookies = await createAuthenticatedCookies(
				testUser.email,
				"TestPassword123!",
			);

			sendVerificationMock.mockResolvedValue({ success: true });

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

			expect(sendVerificationMock).toHaveBeenCalledWith(`+1${newPhoneNumber}`);

			const { data: updatedUser } = await adminClient
				.from("users")
				.select("*")
				.eq("id", testUser.id)
				.single();

			expect(updatedUser).not.toBeNull();
			if (!updatedUser) throw new Error("expected user row");
			expect(updatedUser.phone_country_code).toBe("+1");
			expect(updatedUser.phone_number).toBe(newPhoneNumber);
			expect(updatedUser.phone_verified).toBe(false);
			expect(updatedUser.verification_sent_at).toBeTruthy();
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});

	it("If a verification code was sent recently, the user is asked to wait before requesting another.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
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

			const response = await sendVerificationPost(
				createApiContext({ request, cookies }),
			);

			expect(response.status).toBe(429);
			const payload = (await response.json()) as {
				ok: boolean;
				message: string;
				tone?: string;
			};
			expect(payload.ok).toBe(false);
			expect(payload.message).toBe("verification_recently_sent");
			expect(payload.tone).toBe("warning");

			expect(sendVerificationMock).not.toHaveBeenCalled();
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});

	it("After the cooldown expires, the user can request another verification code.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: "TestPassword123!",
			confirmed: true,
		});

		try {
			// Give plenty of buffer to avoid boundary flakiness between app and DB clocks.
			const oldTimestamp = new Date(
				Date.now() - VERIFICATION_RESEND_COOLDOWN_MS - 60_000,
			).toISOString();

			await adminClient
				.from("users")
				.update({ verification_sent_at: oldTimestamp })
				.eq("id", testUser.id);

			const cookies = await createAuthenticatedCookies(
				testUser.email,
				"TestPassword123!",
			);

			sendVerificationMock.mockResolvedValue({ success: true });

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

			expect(sendVerificationMock).toHaveBeenCalledWith(`+1${phoneNumber}`);
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});
});
