import { getSiteUrl } from "../db/env";
import type { Logger } from "../logging";
import { sendAppTransactionalEmail } from "../messaging/email/dispatch-client";
import { getAdminEmails } from "./approval-admin";

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
		const recipients = [...getAdminEmails()];
		if (recipients.length === 0) {
			logger.error("Skipping registration admin email because no admin emails are configured", {
				userId: user.id,
				envVar: "ADMIN_EMAILS",
			});
			return;
		}
		const createdAt = new Date().toISOString();
		const body = [
			"New StockTextAlerts registration pending approval.",
			"",
			`Email: ${user.email}`,
			`User ID: ${user.id}`,
			`Timezone: ${user.timezone}`,
			`Created at: ${createdAt}`,
			"",
			`Approve this user at ${getSiteUrl()}/admin/users`,
		].join("\n");

		const results = await Promise.all(
			recipients.map((recipient) =>
				sendAppTransactionalEmail(
					{
						to: recipient,
						subject: "New StockTextAlerts registration pending approval",
						body,
						idempotencyKey: `registration-admin-${user.id}-${recipient}`,
						userId: user.id,
					},
					logger,
				),
			),
		);

		for (const [index, result] of results.entries()) {
			if (!result.success) {
				logger.error("Failed to send registration admin email", {
					userId: user.id,
					recipient: recipients[index],
					error: result.error,
					errorCode: result.errorCode,
				});
			}
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
