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
		// sendSms (from createSmsSender) already catches Twilio RestException errors
		// and returns a DeliveryResult, so this catch block only handles unexpected
		// errors like network failures, timeouts, or implementation errors.
		console.error("Unexpected error sending SMS", {
			userId: user.id,
			error,
		});

		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			error: errorMessage,
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
