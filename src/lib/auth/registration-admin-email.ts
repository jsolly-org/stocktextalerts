import { requireEnv } from "../db/env";
import type { Logger } from "../logging";
import { createEmailSender } from "../messaging/email/utils";

type RegisteredUserProfile = {
	id: string;
	email: string;
	timezone: string;
};

export async function sendRegistrationAdminEmail(
	user: RegisteredUserProfile,
	logger: Logger,
): Promise<void> {
	try {
		const recipient = requireEnv("EMAIL_FROM");
		const sendEmail = createEmailSender();
		const createdAt = new Date().toISOString();
		const body = [
			"New StockTextAlerts registration pending approval.",
			"",
			`Email: ${user.email}`,
			`User ID: ${user.id}`,
			`Timezone: ${user.timezone}`,
			`Created at: ${createdAt}`,
			"",
			"Approve this user at /admin/users (requires APPROVAL_ADMIN_EMAILS).",
		].join("\n");

		const result = await sendEmail({
			to: recipient,
			subject: "New StockTextAlerts registration pending approval",
			body,
			idempotencyKey: `registration-admin-${user.id}`,
			userId: user.id,
		});

		if (!result.success) {
			logger.error("Failed to send registration admin email", {
				userId: user.id,
				error: result.error,
				errorCode: result.errorCode,
			});
		}
	} catch (error) {
		logger.error(
			"Failed to prepare registration admin email",
			{
				userId: user.id,
			},
			error,
		);
	}
}
