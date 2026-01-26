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

const toRedirect = (url: string, status = 302) =>
	new Response(null, {
		status,
		headers: { Location: url },
	});

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
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(302);
		const location = response.headers.get("Location");
		expect(location).toContain("/dashboard?success=verification_sent");
		expect(location).toContain("#notification-preferences");

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
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(302);
		const location = response.headers.get("Location");
		expect(location).toContain("/dashboard?warning=verification_recently_sent");
		expect(location).toContain("#notification-preferences");

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
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(302);
		const location = response.headers.get("Location");
		expect(location).toContain("/dashboard?success=verification_sent");
		expect(location).toContain("#notification-preferences");

		expect(sendVerificationMock).toHaveBeenCalledWith(`+1${phoneNumber}`);
	});

	it("should redirect unauthenticated users to signin", async () => {
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
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/signin?error=unauthorized");
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
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(302);
		const location = response.headers.get("Location");
		expect(location).toContain("/dashboard?error=invalid_form");
		expect(location).toContain("#notification-preferences");
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
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(302);
		const location = response.headers.get("Location");
		expect(location).toContain("/dashboard?error=sms_opted_out");
		expect(location).toContain("#notification-preferences");
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
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(302);
		const location = response.headers.get("Location");
		expect(location).toContain("/dashboard?error=verification_failed");
		expect(location).toContain("#notification-preferences");
	});
});
