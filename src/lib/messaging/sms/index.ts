import { rootLogger } from "../../logging";
import type { DeliveryResult, SmsUser, UserRecord } from "../types";
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
		rootLogger.error(
			"Unexpected error sending SMS",
			{ userId: user.id },
			error,
		);

		const errorMessage = error instanceof Error ? error.message : String(error);
		const errorCode = (error as { code?: string | number })?.code;
		return {
			success: false,
			error: errorMessage,
			errorCode: errorCode ? String(errorCode) : undefined,
		};
	}
}

export function shouldSendSms(
	user: Pick<
		UserRecord,
		| "sms_notifications_enabled"
		| "sms_opted_out"
		| "phone_verified"
		| "phone_country_code"
		| "phone_number"
	>,
): boolean {
	if (user.sms_opted_out) {
		return false;
	}

	const hasOptedIn = user.sms_notifications_enabled;
	const hasVerifiedPhone =
		user.phone_verified &&
		Boolean(user.phone_country_code) &&
		Boolean(user.phone_number);

	if (!hasOptedIn) {
		return false;
	}

	return hasVerifiedPhone;
}
