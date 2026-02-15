import { rootLogger } from "../../logging";
import type { DeliveryResult, SmsUser, UserRecord } from "../types";
import type { SmsSender } from "./twilio-utils";

type SmsEligibilityUser = Pick<
	UserRecord,
	| "sms_opted_out"
	| "sms_notifications_enabled"
	| "phone_verified"
	| "phone_country_code"
	| "phone_number"
> & {
	market_scheduled_asset_price_include_sms?: boolean;
	asset_events_include_calendar_sms?: boolean;
	asset_events_include_ipo_sms?: boolean;
	asset_events_include_analyst_sms?: boolean;
	asset_events_include_insider_sms?: boolean;
	market_asset_price_alerts_include_sms?: boolean;
};

/**
 * Send an SMS to a user using the provided sender implementation.
 * Caller should verify opt-in/verification (e.g., shouldSendSms) before calling.
 */
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

/**
 * Returns true when an SMS should be attempted for the user.
 *
 * Enforces opt-out and phone verification invariants.
 */
export function shouldSendSms(user: SmsEligibilityUser): boolean {
	if (user.sms_opted_out) {
		return false;
	}

	if (!user.sms_notifications_enabled) {
		return false;
	}

	const hasVerifiedPhone =
		user.phone_verified &&
		Boolean(user.phone_country_code) &&
		Boolean(user.phone_number);
	const hasAnySmsFeatureEnabled = [
		user.market_scheduled_asset_price_include_sms,
		user.asset_events_include_calendar_sms,
		user.asset_events_include_ipo_sms,
		user.asset_events_include_analyst_sms,
		user.asset_events_include_insider_sms,
		user.market_asset_price_alerts_include_sms,
	].some((value) => value === true);

	return hasVerifiedPhone && hasAnySmsFeatureEnabled;
}
