import { randomInt, randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERIFICATION_RESEND_COOLDOWN_MS } from "../../src/lib/constants";
import { createSendVerificationHandler } from "../../src/pages/api/auth/sms/send-verification";
import { adminClient, allowConsoleErrors } from "../setup";
import { createAuthenticatedCookies, createTestUser } from "../utils";

const { sendVerificationMock } = vi.hoisted(() => {
	return {
		sendVerificationMock: vi.fn(),
	};
});

vi.mock("../../src/pages/api/auth/sms/verify-utils", () => ({
	sendVerification: sendVerificationMock,
}));

function generateUniquePhoneNumber(): string {
	return `555${String(randomInt(1000000, 9999999))}`;
}

describe("POST /api/auth/sms/send-verification", () => {
	afterEach(() => {
		sendVerificationMock.mockClear();
	});
	it("should successfully send verification code", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

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

		expect(response.status).toBe(200);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("verification_sent");

		expect(sendVerificationMock).toHaveBeenCalledWith(`+1${phoneNumber}`);

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
	});

	it("should reset verification when changing a verified phone number", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

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

		expect(response.status).toBe(200);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("verification_sent");

		expect(sendVerificationMock).toHaveBeenCalledWith(`+1${newPhoneNumber}`);

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("*")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser.phone_country_code).toBe("+1");
		expect(updatedUser.phone_number).toBe(newPhoneNumber);
		expect(updatedUser.phone_verified).toBe(false);
		expect(updatedUser.verification_sent_at).toBeTruthy();
	});

	it("should block resend when verification was recently sent (cooldown)", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

		// Set verification_sent_at to a recent timestamp (within cooldown)
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
		} as APIContext);

		expect(response.status).toBe(429);
		const payload = (await response.json()) as {
			ok: boolean;
			message: string;
			tone?: string;
		};
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("verification_recently_sent");
		expect(payload.tone).toBe("warning");

		// Should not call sendVerification when cooldown is active
		expect(sendVerificationMock).not.toHaveBeenCalled();
	});

	it("should allow resend when cooldown period has passed", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

		// Set verification_sent_at to a timestamp outside cooldown
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

		expect(response.status).toBe(200);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("verification_sent");

		expect(sendVerificationMock).toHaveBeenCalledWith(`+1${phoneNumber}`);
	});

	it("returns unauthorized for unauthenticated users", async () => {
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

	it("should reject invalid form data", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

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
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("invalid_form");
		expect(sendVerificationMock).not.toHaveBeenCalled();
	});

	it("should block SMS verification for opted-out users", async () => {
		allowConsoleErrors();
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
			smsOptedOut: true,
		});

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
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("sms_opted_out");
		expect(sendVerificationMock).not.toHaveBeenCalled();
	});

	it("should handle verification send failure", async () => {
		allowConsoleErrors();
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			"TestPassword123!",
		);

		sendVerificationMock.mockResolvedValue({
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
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("verification_failed");

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("verification_sent_at")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser.verification_sent_at).toBeNull();
	});
});
