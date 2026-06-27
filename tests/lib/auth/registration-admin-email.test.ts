import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailSender } from "../../../src/lib/messaging/email/utils";
import { expectConsoleError } from "../../setup";

const mockEmailSender = vi.hoisted(() =>
	vi.fn<EmailSender>(async () => ({
		success: true,
		messageSid: "registration-admin-email",
	})),
);

vi.mock("../../../src/lib/messaging/email/dispatch-client", () => ({
	sendAppTransactionalEmail: (request: unknown, _logger: unknown) => mockEmailSender(request),
}));

describe("sendRegistrationAdminEmail", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it("sends one admin notification to each configured approval admin.", async () => {
		vi.stubEnv("ADMIN_EMAILS", "admin@example.com, second@example.com");
		const { sendRegistrationAdminEmail } = await import(
			"../../../src/lib/auth/registration-admin-email"
		);
		const { createLogger } = await import("../../../src/lib/logging");

		await sendRegistrationAdminEmail(
			{ id: "user-1", email: "new-user@example.com", timezone: "America/New_York" },
			createLogger({ path: "/test", method: "POST" }),
		);

		expect(mockEmailSender).toHaveBeenCalledTimes(2);
		expect(mockEmailSender).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "admin@example.com",
				subject: "New StockTextAlerts registration pending approval",
				body: expect.stringContaining("new-user@example.com"),
				html: expect.stringContaining("📈 StockTextAlerts"),
				idempotencyKey: "registration-admin-user-1-admin@example.com",
				userId: "user-1",
			}),
		);
		expect(mockEmailSender).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "second@example.com",
				body: expect.stringContaining("http://localhost/admin/users"),
				html: expect.stringContaining("http://localhost/admin/users"),
			}),
		);
	});

	it("skips sending when no approval admins are configured.", async () => {
		expectConsoleError("Skipping registration admin email because no admin emails are configured");
		vi.stubEnv("ADMIN_EMAILS", "");
		const { sendRegistrationAdminEmail } = await import(
			"../../../src/lib/auth/registration-admin-email"
		);
		const { createLogger } = await import("../../../src/lib/logging");

		await sendRegistrationAdminEmail(
			{ id: "user-2", email: "new-user@example.com", timezone: "America/New_York" },
			createLogger({ path: "/test", method: "POST" }),
		);

		expect(mockEmailSender).not.toHaveBeenCalled();
	});

	it("logs per-recipient failures without throwing when one admin email fails.", async () => {
		expectConsoleError("Failed to send registration admin email");
		vi.stubEnv("ADMIN_EMAILS", "admin@example.com, second@example.com");
		mockEmailSender
			.mockResolvedValueOnce({ success: true, messageSid: "registration-admin-email" })
			.mockResolvedValueOnce({
				success: false,
				error: "SMTP down",
				errorCode: "smtp_error",
			});
		const { sendRegistrationAdminEmail } = await import(
			"../../../src/lib/auth/registration-admin-email"
		);
		const { createLogger } = await import("../../../src/lib/logging");

		await sendRegistrationAdminEmail(
			{ id: "user-3", email: "new-user@example.com", timezone: "America/New_York" },
			createLogger({ path: "/test", method: "POST" }),
		);

		expect(mockEmailSender).toHaveBeenCalledTimes(2);
		expect(mockEmailSender).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ to: "admin@example.com" }),
		);
		expect(mockEmailSender).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ to: "second@example.com" }),
		);
	});
});
