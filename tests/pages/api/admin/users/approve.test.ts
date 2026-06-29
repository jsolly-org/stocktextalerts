import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailRequest, EmailSender } from "../../../../../src/lib/messaging/email/utils";
import { POST } from "../../../../../src/pages/api/admin/users/approve";
import { createApiContext } from "../../../../helpers/api-context";
import { TEST_PASSWORD } from "../../../../helpers/constants";
import { createAuthenticatedCookies } from "../../../../helpers/test-env";
import { createTestUser } from "../../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../../helpers/test-user-cleanup";
import { expectConsoleError } from "../../../../setup";

const mockEmailSender = vi.hoisted(() =>
	vi.fn<EmailSender>(async () => ({
		success: true,
		messageSid: "approval-email",
	})),
);

vi.mock("../../../../../src/lib/messaging/email/dispatch-client", () => ({
	sendAppTransactionalEmail: (request: EmailRequest, _logger: unknown) => mockEmailSender(request),
}));

function makeRequest(userId: string) {
	return new Request("http://localhost/api/admin/users/approve", {
		method: "POST",
		body: new URLSearchParams({ user_id: userId }),
	});
}

describe("admin user approval API", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it("redirects logged-out requests to sign in.", async () => {
		const response = await POST(createApiContext({ request: makeRequest(randomUUID()) }));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			"/auth/signin?redirect=%2Fapi%2Fadmin%2Fusers%2Fapprove",
		);
	});

	it("rejects signed-in users outside ADMIN_EMAILS.", async () => {
		vi.stubEnv("ADMIN_EMAILS", "test@jsolly.com");
		const user = await createTestUser({
			email: `not-admin-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			approved: true,
		});
		registerTestUserForCleanup(user.id);
		const cookies = await createAuthenticatedCookies(user.email, TEST_PASSWORD);

		const response = await POST(createApiContext({ request: makeRequest(randomUUID()), cookies }));

		expect(response.status).toBe(403);
		expect(await response.text()).toContain("Forbidden");
	});

	it("approves a pending user and redirects with success.", async () => {
		vi.stubEnv("ADMIN_EMAILS", "admin@example.com");
		vi.stubEnv("EMAIL_FROM", "StockTextAlerts <notify@example.com>");
		const admin = await createTestUser({
			email: "admin@example.com",
			password: TEST_PASSWORD,
			confirmed: true,
			approved: true,
		});
		registerTestUserForCleanup(admin.id);
		const pending = await createTestUser({
			email: `pending-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			approved: false,
		});
		registerTestUserForCleanup(pending.id);
		const cookies = await createAuthenticatedCookies(admin.email, TEST_PASSWORD);

		const response = await POST(createApiContext({ request: makeRequest(pending.id), cookies }));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/admin/users?success=approved");
		expect(mockEmailSender).toHaveBeenCalledOnce();
	});

	it("does not email an already-approved user.", async () => {
		vi.stubEnv("ADMIN_EMAILS", "admin@example.com");
		const admin = await createTestUser({
			email: "admin@example.com",
			password: TEST_PASSWORD,
			confirmed: true,
			approved: true,
		});
		registerTestUserForCleanup(admin.id);
		const approved = await createTestUser({
			email: `approved-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			approved: true,
		});
		registerTestUserForCleanup(approved.id);
		const cookies = await createAuthenticatedCookies(admin.email, TEST_PASSWORD);

		const response = await POST(createApiContext({ request: makeRequest(approved.id), cookies }));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/admin/users?info=already_approved");
		expect(mockEmailSender).not.toHaveBeenCalled();
	});

	it("keeps approval when email fails and redirects with warning.", async () => {
		expectConsoleError("Failed to send user approval email");
		mockEmailSender.mockResolvedValueOnce({
			success: false,
			error: "SMTP down",
			errorCode: "smtp_error",
		});
		vi.stubEnv("ADMIN_EMAILS", "admin@example.com");
		const admin = await createTestUser({
			email: "admin@example.com",
			password: TEST_PASSWORD,
			confirmed: true,
			approved: true,
		});
		registerTestUserForCleanup(admin.id);
		const pending = await createTestUser({
			email: `email-fail-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			approved: false,
		});
		registerTestUserForCleanup(pending.id);
		const cookies = await createAuthenticatedCookies(admin.email, TEST_PASSWORD);

		const response = await POST(createApiContext({ request: makeRequest(pending.id), cookies }));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/admin/users?warning=email_failed");
	});
});
