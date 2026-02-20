import { rootLogger } from "../../logging";
import type { DeliveryResult, EmailUser } from "../types";
import type { EmailSender } from "./utils";

// Errors are caught and returned as DeliveryResult so callers can log outcomes consistently.
export async function sendUserEmail(
	user: EmailUser,
	subject: string,
	message: { text: string; html: string },
	sendEmail: EmailSender,
	idempotencyKey?: string,
): Promise<DeliveryResult> {
	try {
		return await sendEmail({
			to: user.email,
			subject,
			body: message.text,
			html: message.html,
			idempotencyKey,
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		rootLogger.error("Failed to send email", { userId: user.id }, error);
		return { success: false, error: errorMessage };
	}
}
