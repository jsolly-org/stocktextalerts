import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailRequest, EmailSender } from "../../../../src/lib/messaging/types";
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

describe("sendUserApprovalEmail", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it("sends a user-facing approval email with the sign-in link.", async () => {
		vi.stubEnv("EMAIL_FROM", "StockTextAlerts <notify@example.com>");
		const { getSiteUrl } = await import("../../../../src/lib/db/env");
		const { sendUserApprovalEmail } = await import(
			"../../../../src/lib/auth/approval/user-approved-email"
		);
		const { createLogger } = await import("../../../../src/lib/logging");

		const result = await sendUserApprovalEmail(
			{ id: "user-1", email: "new-user@example.com" },
			createLogger({ path: "/test", method: "POST" }),
		);

		expect(result.success).toBe(true);
		expect(mockEmailSender).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "new-user@example.com",
				subject: "Your StockTextAlerts account is approved",
				body: expect.stringContaining(`${getSiteUrl()}/auth/signin`),
				html: expect.stringContaining("📈 StockTextAlerts"),
				userId: "user-1",
				idempotencyKey: "user-approved-user-1",
			}),
		);
		const callArgs = mockEmailSender.mock.calls[0]?.[0];
		expect(callArgs?.html).toContain(`${getSiteUrl()}/auth/signin`);
	});

	it("returns failure and logs when the email sender fails.", async () => {
		expectConsoleError("Failed to send user approval email");
		mockEmailSender.mockResolvedValueOnce({
			success: false,
			error: "SMTP down",
			errorCode: "smtp_error",
		});
		vi.stubEnv("EMAIL_FROM", "StockTextAlerts <notify@example.com>");
		const { sendUserApprovalEmail } = await import(
			"../../../../src/lib/auth/approval/user-approved-email"
		);
		const { createLogger } = await import("../../../../src/lib/logging");

		const result = await sendUserApprovalEmail(
			{ id: "user-2", email: "new-user@example.com" },
			createLogger({ path: "/test", method: "POST" }),
		);

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.errorCode).toBe("smtp_error");
		}
	});
});
