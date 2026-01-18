import type { DeliveryResult, SmsUser, UserRecord } from "../shared";
import type { SmsSender } from "./twilio-utils";

export async function sendUserSms(
	user: SmsUser,
	message: string,
	sendSms: SmsSender,
): Promise<DeliveryResult> {
	if (!user.phone_country_code || !user.phone_number) {
		return { success: false, error: "Missing phone number" };
	}

	const fullPhone = `${user.phone_country_code}${user.phone_number}`;

	try {
		return await sendSms({
			to: fullPhone,
			body: message,
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		console.error("Failed to send SMS", {
			userId: user.id,
			error,
		});

		const twilioError = error as { code?: string | number };

		return {
			success: false,
			error: errorMessage,
			errorCode: twilioError.code ? String(twilioError.code) : undefined,
		};
	}
}

export function shouldSendSms(user: UserRecord): boolean {
	const hasOptedIn = user.sms_notifications_enabled && !user.sms_opted_out;
	const hasVerifiedPhone =
		user.phone_verified &&
		Boolean(user.phone_country_code) &&
		Boolean(user.phone_number);

	if (!hasOptedIn) {
		return false;
	}

	return hasVerifiedPhone;
}
