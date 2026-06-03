import type { AppSupabaseClient } from "../../db/supabase";
import { rootLogger } from "../../logging";
import type { DeliveryResult, SmsUser, UserRecord } from "../types";
import { finalizeSmsBodyForUcs2Segments } from "./segment-utils";
import type { SmsSender } from "./twilio-utils";

type SmsEligibilityUser = Pick<
	UserRecord,
	| "sms_opted_out"
	| "sms_notifications_enabled"
	| "phone_verified"
	| "phone_country_code"
	| "phone_number"
> & {
	daily_digest_include_prices_sms?: boolean;
	daily_digest_include_top_movers_sms?: boolean;
	market_scheduled_asset_price_include_sms?: boolean;
	asset_events_include_calendar_sms?: boolean;
	asset_events_include_ipo_sms?: boolean;
	asset_events_include_analyst_sms?: boolean;
	asset_events_include_insider_sms?: boolean;
	market_asset_price_alerts_include_sms?: boolean;
	price_move_alerts_include_sms?: boolean;
	price_targets_include_sms?: boolean;
};

// Caller must verify opt-in/verification (e.g. shouldSendSms) before calling.
export async function sendUserSms(
	user: SmsUser,
	message: string,
	sendSms: SmsSender,
	supabase?: AppSupabaseClient,
): Promise<DeliveryResult> {
	if (!user.phone_country_code || !user.phone_number) {
		return { success: false, error: "Missing phone number" };
	}

	const fullPhone = `${user.phone_country_code}${user.phone_number}`;
	const body = finalizeSmsBodyForUcs2Segments(message);

	let result: DeliveryResult;
	try {
		result = await sendSms({
			to: fullPhone,
			body,
		});
	} catch (error) {
		// sendSms (from createSmsSender) already catches Twilio RestException errors
		// and returns a DeliveryResult, so this catch block only handles unexpected
		// errors like network failures, timeouts, or implementation errors.
		rootLogger.error("Unexpected error sending SMS", { userId: user.id }, error);

		const errorMessage = error instanceof Error ? error.message : String(error);
		const errorCode = (error as { code?: string | number })?.code;
		result = {
			success: false,
			error: errorMessage,
			errorCode: errorCode ? String(errorCode) : undefined,
		};
	}

	if (!result.success && result.errorCode === "21610" && supabase) {
		await autoOptOutUser(supabase, user.id);
	}

	return result;
}

async function autoOptOutUser(supabase: AppSupabaseClient, userId: string): Promise<void> {
	const { error } = await supabase
		.from("users")
		.update({ sms_opted_out: true, sms_notifications_enabled: false })
		.eq("id", userId);
	if (error) {
		rootLogger.error("Failed to auto opt-out user after 21610", { userId }, error);
	} else {
		rootLogger.info("Auto opted-out user due to Twilio 21610", { userId });
	}
}

export function shouldSendSms(user: SmsEligibilityUser): boolean {
	if (user.sms_opted_out) {
		return false;
	}

	if (!user.sms_notifications_enabled) {
		return false;
	}

	const hasVerifiedPhone =
		user.phone_verified && Boolean(user.phone_country_code) && Boolean(user.phone_number);
	// Exclude price_targets_include_sms so that enabling only price-target SMS does not
	// make users eligible for unrelated flows (e.g. daily digest) that gate on shouldSendSms.
	const hasAnySmsFeatureEnabled = [
		user.daily_digest_include_prices_sms,
		user.daily_digest_include_top_movers_sms,
		user.market_scheduled_asset_price_include_sms,
		user.asset_events_include_calendar_sms,
		user.asset_events_include_ipo_sms,
		user.asset_events_include_analyst_sms,
		user.asset_events_include_insider_sms,
		user.market_asset_price_alerts_include_sms,
		user.price_move_alerts_include_sms,
	].some((value) => value === true);

	return hasVerifiedPhone && hasAnySmsFeatureEnabled;
}

/** True if SMS channel is usable (not opted out, enabled, verified phone). Use for flows that have their own feature-specific opt-in (e.g. price targets). */
export function isSmsChannelUsable(user: SmsEligibilityUser): boolean {
	if (user.sms_opted_out) return false;
	if (!user.sms_notifications_enabled) return false;
	return user.phone_verified && Boolean(user.phone_country_code) && Boolean(user.phone_number);
}
