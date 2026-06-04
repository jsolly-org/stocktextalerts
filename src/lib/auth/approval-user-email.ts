import { getSiteUrl } from "../db/env";
import type { Logger } from "../logging";
import { sendAppTransactionalEmail } from "../messaging/email/dispatch-client";
import type { DeliveryResult } from "../messaging/types";

type ApprovedUser = {
	id: string;
	email: string;
};

export async function sendUserApprovalEmail(
	user: ApprovedUser,
	logger: Logger,
): Promise<DeliveryResult> {
	const signInUrl = `${getSiteUrl()}/auth/signin`;
	const body = [
		"Your StockTextAlerts account has been approved.",
		"",
		"You can now sign in and set up your stock alerts:",
		signInUrl,
	].join("\n");

	const result = await sendAppTransactionalEmail(
		{
			to: user.email,
			subject: "Your StockTextAlerts account is approved",
			body,
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
