import { rootLogger } from "../../logging";
import type { DeliveryResult } from "../../types";
import type { EmailSender, EmailUser } from "../types";

// Errors are caught and returned as DeliveryResult so callers can log outcomes consistently.
//
// Note: this is the DIRECT-SES path. It does NOT dedup — the SES sender ignores
// `EmailRequest.idempotencyKey`, which only the email-dispatch Lambda honors. Dedup for
// notification emails comes from the upstream claim/CAS (scheduled_notifications claim,
// flat-alert reserve). Do not pass an idempotency key here expecting
// SES to collapse duplicates — it won't.
export async function sendUserEmail(
	user: EmailUser,
	subject: string,
	message: { text: string; html: string },
	sendEmail: EmailSender,
): Promise<DeliveryResult> {
	try {
		return await sendEmail({
			to: user.email,
			subject,
			body: message.text,
			html: message.html,
			userId: user.id,
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		rootLogger.error("Failed to send email", { userId: user.id }, error);
		return { success: false, error: errorMessage };
	}
}
