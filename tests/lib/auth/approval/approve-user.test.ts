import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailRequest, EmailSender } from "../../../../src/lib/messaging/types";
import { TEST_PASSWORD } from "../../../helpers/constants";
import { adminClient } from "../../../helpers/test-env";
import { createTestUser } from "../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";
import { expectConsoleError } from "../../../setup";

const mockEmailSender = vi.hoisted(() =>
	vi.fn<EmailSender>(async () => ({
		success: true,
		messageSid: "approval-email",
	})),
);

vi.mock("../../../../src/lib/messaging/email/dispatch-client", () => ({
	sendAppTransactionalEmail: (request: EmailRequest, _logger: unknown) => mockEmailSender(request),
}));

describe("approvePendingUser", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it("approves a pending user and sends exactly one approval email.", async () => {
		vi.stubEnv("EMAIL_FROM", "StockTextAlerts <notify@example.com>");
		const pendingUser = await createTestUser({
			email: `pending-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			approved: false,
		});
		registerTestUserForCleanup(pendingUser.id);
		const { approvePendingUser } = await import("../../../../src/lib/auth/approval/approve-user");
		const { createLogger } = await import("../../../../src/lib/logging");

		const result = await approvePendingUser({
			adminSupabase: adminClient,
			targetUserId: pendingUser.id,
			approvedBy: "test@jsolly.com",
			logger: createLogger({ path: "/test", method: "POST" }),
		});

		expect(result.status).toBe("approved");
		expect(result.emailSent).toBe(true);
		expect(mockEmailSender).toHaveBeenCalledOnce();
		const { data: row, error } = await adminClient
			.from("users")
			.select("approved_at, approved_by")
			.eq("id", pendingUser.id)
			.single();
		expect(error).toBeNull();
		expect(row?.approved_at).toBeTruthy();
		expect(row?.approved_by).toBe("test@jsolly.com");
	});

	it("does not send an email for an already-approved user.", async () => {
		const approvedUser = await createTestUser({
			email: `approved-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			approved: true,
		});
		registerTestUserForCleanup(approvedUser.id);
		const { approvePendingUser } = await import("../../../../src/lib/auth/approval/approve-user");
		const { createLogger } = await import("../../../../src/lib/logging");

		const result = await approvePendingUser({
			adminSupabase: adminClient,
			targetUserId: approvedUser.id,
			approvedBy: "test@jsolly.com",
			logger: createLogger({ path: "/test", method: "POST" }),
		});

		expect(result.status).toBe("already_approved");
		expect(result.emailSent).toBe(false);
		expect(mockEmailSender).not.toHaveBeenCalled();
	});

	it("keeps the user approved when approval email delivery fails.", async () => {
		expectConsoleError("Failed to send user approval email");
		mockEmailSender.mockResolvedValueOnce({
			success: false,
			error: "SMTP down",
			errorCode: "smtp_error",
		});
		const pendingUser = await createTestUser({
			email: `email-fails-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			approved: false,
		});
		registerTestUserForCleanup(pendingUser.id);
		const { approvePendingUser } = await import("../../../../src/lib/auth/approval/approve-user");
		const { createLogger } = await import("../../../../src/lib/logging");

		const result = await approvePendingUser({
			adminSupabase: adminClient,
			targetUserId: pendingUser.id,
			approvedBy: "test@jsolly.com",
			logger: createLogger({ path: "/test", method: "POST" }),
		});

		expect(result.status).toBe("approved_email_failed");
		expect(result.emailSent).toBe(false);
		const { data: row } = await adminClient
			.from("users")
			.select("approved_at, approved_by")
			.eq("id", pendingUser.id)
			.single();
		expect(row?.approved_at).toBeTruthy();
		expect(row?.approved_by).toBe("test@jsolly.com");
	});

	it("returns not_found when the target user does not exist.", async () => {
		const { approvePendingUser } = await import("../../../../src/lib/auth/approval/approve-user");
		const { createLogger } = await import("../../../../src/lib/logging");

		const result = await approvePendingUser({
			adminSupabase: adminClient,
			targetUserId: randomUUID(),
			approvedBy: "test@jsolly.com",
			logger: createLogger({ path: "/test", method: "POST" }),
		});

		expect(result.status).toBe("not_found");
		expect(mockEmailSender).not.toHaveBeenCalled();
	});
});
