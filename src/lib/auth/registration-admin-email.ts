import { getSiteUrl } from "../db/env";
import type { Logger } from "../logging";
import { sendAppTransactionalEmail } from "../messaging/email/dispatch-client";
import { getApprovalAdminEmails } from "./approval-admin";

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
		const recipients = [...getApprovalAdminEmails()];
		if (recipients.length === 0) {
			logger.warn("Skipping registration admin email because no approval admins are configured", {
				userId: user.id,
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
