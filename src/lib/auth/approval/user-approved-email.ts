import { getSiteUrl } from "../../db/env";
import type { DeliveryResult } from "../../delivery-types";
import type { Logger } from "../../logging";
import { sendAppTransactionalEmail } from "../../messaging/email/dispatch-client";
import { renderEmailButton, renderEmailShell } from "../../messaging/email/layout";

type ApprovedUser = {
	id: string;
	email: string;
};

function formatUserApprovalEmail(signInUrl: string): { body: string; html: string } {
	const body = [
		"Your StockTextAlerts account has been approved.",
		"",
		"You can now sign in and set up your stock alerts:",
		signInUrl,
	].join("\n");

	const html = renderEmailShell({
		bodyHtml: `<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600;">Your account is approved</h2>
			<p style="color: #4b5563; font-size: 16px; margin-bottom: 28px;">
				Your StockTextAlerts account has been approved. You can now sign in and set up your stock alerts.
			</p>
			${renderEmailButton(signInUrl, "Sign in →")}`,
	});

	return { body, html };
}

export async function sendUserApprovalEmail(
	user: ApprovedUser,
	logger: Logger,
): Promise<DeliveryResult> {
	const signInUrl = `${getSiteUrl()}/auth/signin`;
	const { body, html } = formatUserApprovalEmail(signInUrl);

	const result = await sendAppTransactionalEmail(
		{
			to: user.email,
			subject: "Your StockTextAlerts account is approved",
			body,
			html,
			idempotencyKey: `user-approved-${user.id}`,
			userId: user.id,
		},
		logger,
	);

	if (!result.success) {
		logger.error("Failed to send user approval email", {
			userId: user.id,
			error: result.error,
			errorCode: result.errorCode,
		});
	}

	return result;
}
