import type { DeliveryResult, EmailUser } from "../shared";
import type { EmailSender } from "./utils";

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
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		console.error("Failed to send email", {
			userId: user.id,
			error,
		});
		return { success: false, error: errorMessage };
	}
}
