import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailSender } from "../../../src/lib/messaging/email/utils";
import { expectConsoleError } from "../../setup";

const mockEmailSender = vi.hoisted(() =>
	vi.fn<EmailSender>(async () => ({
		success: true,
		messageSid: "approval-email",
	})),
);

vi.mock("../../../src/lib/messaging/email/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/lib/messaging/email/utils")>();
	return {
		...actual,
		createEmailSender: () => mockEmailSender,
	};
});

describe("sendUserApprovalEmail", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it("sends a user-facing approval email with the sign-in link.", async () => {
		vi.stubEnv("EMAIL_FROM", "StockTextAlerts <notify@example.com>");
		const { getSiteUrl } = await import("../../../src/lib/db/env");
		const { sendUserApprovalEmail } = await import("../../../src/lib/auth/approval-user-email");
		const { createLogger } = await import("../../../src/lib/logging");

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
				userId: "user-1",
				idempotencyKey: "user-approved-user-1",
			}),
		);
	});

	it("returns failure and logs when the email sender fails.", async () => {
		expectConsoleError("Failed to send user approval email");
		mockEmailSender.mockResolvedValueOnce({
			success: false,
			error: "SMTP down",
			errorCode: "smtp_error",
		});
		vi.stubEnv("EMAIL_FROM", "StockTextAlerts <notify@example.com>");
		const { sendUserApprovalEmail } = await import("../../../src/lib/auth/approval-user-email");
		const { createLogger } = await import("../../../src/lib/logging");

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
