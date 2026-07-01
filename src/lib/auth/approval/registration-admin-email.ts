import { getSiteUrl } from "../../db/env";
import type { Logger } from "../../logging/types";
import { sendAppTransactionalEmail } from "../../messaging/email/dispatch-client";
import { renderEmailButton, renderEmailShell } from "../../messaging/email/layout";
import { escapeHtml } from "../../messaging/parts/html-utils";
import { getAdminEmails } from "./admin";

type RegisteredUserProfile = {
	id: string;
	email: string;
	timezone: string;
};

function formatRegistrationAdminEmail(
	user: RegisteredUserProfile,
	createdAt: string,
): { body: string; html: string } {
	const adminUsersUrl = `${getSiteUrl()}/admin/users`;
	const body = [
		"New StockTextAlerts registration pending approval.",
		"",
		`Email: ${user.email}`,
		`User ID: ${user.id}`,
		`Timezone: ${user.timezone}`,
		`Created at: ${createdAt}`,
		"",
		`Approve this user at ${adminUsersUrl}`,
	].join("\n");

	const html = renderEmailShell({
		bodyHtml: `<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600;">New registration pending approval</h2>
			<p style="color: #4b5563; font-size: 16px; margin-bottom: 20px;">
				A new user has registered and is waiting for approval.
			</p>
			<div style="background: #f9fafb; padding: 16px 20px; border-radius: 6px; margin-bottom: 24px; border: 1px solid #e5e7eb; font-size: 14px; color: #374151;">
				<p style="margin: 0 0 8px 0;"><strong>Email:</strong> ${escapeHtml(user.email)}</p>
				<p style="margin: 0 0 8px 0;"><strong>User ID:</strong> ${escapeHtml(user.id)}</p>
				<p style="margin: 0 0 8px 0;"><strong>Timezone:</strong> ${escapeHtml(user.timezone)}</p>
				<p style="margin: 0;"><strong>Created at:</strong> ${escapeHtml(createdAt)}</p>
			</div>
			${renderEmailButton(adminUsersUrl, "Review pending users →")}`,
	});

	return { body, html };
}

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
		const { body, html } = formatRegistrationAdminEmail(user, createdAt);

		const results = await Promise.all(
			recipients.map((recipient) =>
				sendAppTransactionalEmail(
					{
						to: recipient,
						subject: "New StockTextAlerts registration pending approval",
						body,
						html,
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
