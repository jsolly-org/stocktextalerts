import type { AppSupabaseClient } from "../../db/supabase";
import { rootLogger } from "../../logging";
import type { DeliveryResult, PrefRow, UserRecord } from "../../types";
import { anySmsFacetEnabledExceptPriceTargets } from "../notification-prefs";
import type { SmsUser } from "../types";
import { finalizeSmsBodyForUcs2Segments } from "./segment-utils";
import type { SmsSender } from "./twilio-utils";

/** Channel-level SMS usability (opted in, verified phone, not opted out). Does
 *  NOT read per-option facets, so it doesn't require `prefs`. */
type SmsChannelUser = Pick<
	UserRecord,
	| "sms_opted_out"
	| "sms_notifications_enabled"
	| "phone_verified"
	| "phone_country_code"
	| "phone_number"
>;

/** Adds the per-option facet rows needed by `shouldSendSms`. */
type SmsEligibilityUser = SmsChannelUser & {
	/** Per-option preference rows (the single source of truth for SMS facets). */
	prefs: readonly PrefRow[];
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
	// Exclude price_targets SMS so that enabling only price-target SMS does not
	// make users eligible for unrelated flows (e.g. daily digest) that gate on shouldSendSms.
	const hasAnySmsFeatureEnabled = anySmsFacetEnabledExceptPriceTargets(user.prefs);

	return hasVerifiedPhone && hasAnySmsFeatureEnabled;
}

/** True if SMS channel is usable (not opted out, enabled, verified phone). Use for flows that have their own feature-specific opt-in (e.g. price targets). */
export function isSmsChannelUsable(user: SmsChannelUser): boolean {
	if (user.sms_opted_out) return false;
	if (!user.sms_notifications_enabled) return false;
	return user.phone_verified && Boolean(user.phone_country_code) && Boolean(user.phone_number);
}
