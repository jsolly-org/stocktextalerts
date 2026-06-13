import twilio, { type RestException } from "twilio";
import { requireEnv } from "../db/env";
import { rootLogger } from "../logging";
import { createErrorForLogging, extractErrorMessage } from "../logging/errors";
import { isProduction } from "../runtime/mode";

function handleTwilioError(
	error: unknown,
	defaultMessage: string,
	logPrefix: string,
): { success: false; error: string } {
	// Twilio SDK throws RestException for API errors (HTTP 400-5xx).
	// RestException has: status (HTTP status), code (numeric Twilio error code),
	// message, and moreInfo.
	if (error instanceof Error && "status" in error && "code" in error) {
		const twilioError = error as RestException;
		rootLogger.error(
			logPrefix,
			{
				code: twilioError.code,
				status: twilioError.status,
				moreInfo: twilioError.moreInfo,
			},
			twilioError,
		);
		return {
			success: false,
			error: twilioError.message,
		};
	}

	const errorMessage = extractErrorMessage(error) || defaultMessage;
	const errorType = error?.constructor?.name || typeof error;
	rootLogger.error(logPrefix, { errorType }, createErrorForLogging(error));
	return {
		success: false,
		error: errorMessage,
	};
}

/**
 * Twilio Verify API is paid per attempt and delivers a real SMS to a
 * real phone. Tests and `astro dev` must never reach it. Non-production
 * builds short-circuit at every entry point and use the mock code
 * `MOCK_VERIFICATION_CODE` as the only accepted OTP. Real Verify is only
 * reachable from a production build (Lambda / Vercel SSR).
 *
 * Added 2026-04-11 after a local test run delivered a real notification
 * through prod SES credentials. The same "no real services from non-prod
 * builds" rule applies to Twilio Verify as to `createEmailSender`.
 */
const MOCK_VERIFICATION_CODE = "000000";

function createVerificationClient(): {
	client: ReturnType<typeof twilio>;
	serviceSid: string;
} {
	const twilioAccountSid = requireEnv("TWILIO_ACCOUNT_SID");
	const twilioApiKeySid = requireEnv("TWILIO_API_KEY_SID");
	const twilioApiKeySecret = requireEnv("TWILIO_API_KEY_SECRET");
	const twilioVerifyServiceSid = requireEnv("TWILIO_VERIFY_SERVICE_SID");

	return {
		// Restricted API key auth, scoped to verify/verification[-check]/create.
		client: twilio(twilioApiKeySid, twilioApiKeySecret, { accountSid: twilioAccountSid }),
		serviceSid: twilioVerifyServiceSid,
	};
}

/**
 * Send an SMS verification code to the given fully-qualified phone number.
 */
export async function sendVerification(
	fullPhone: string,
): Promise<{ success: boolean; error?: string }> {
	// Hard gate: Twilio Verify charges per attempt and delivers real SMS.
	// Tests and dev always succeed without network calls.
	if (!isProduction()) {
		return { success: true };
	}
	try {
		const { client, serviceSid } = createVerificationClient();
		await client.verify.v2
			.services(serviceSid)
			.verifications.create({ to: fullPhone, channel: "sms" });

		return { success: true };
	} catch (error) {
		return handleTwilioError(error, "Failed to send verification", "Verification send error");
	}
}

/**
 * Verify an SMS code for the given fully-qualified phone number.
 */
export async function checkVerification(
	fullPhone: string,
	code: string,
): Promise<{ success: boolean; error?: string }> {
	// Hard gate: non-production accepts MOCK_VERIFICATION_CODE and rejects
	// everything else, letting local OTP flows exercise both success and
	// failure paths without calling Twilio.
	if (!isProduction()) {
		if (code === MOCK_VERIFICATION_CODE) {
			return { success: true };
		}
		return { success: false, error: "Invalid verification code" };
	}
	try {
		const { client, serviceSid } = createVerificationClient();
		const verificationCheck = await client.verify.v2
			.services(serviceSid)
			.verificationChecks.create({ to: fullPhone, code });

		if (verificationCheck.status === "approved") {
			return { success: true };
		}

		return { success: false, error: "Invalid verification code" };
	} catch (error) {
		return handleTwilioError(error, "Failed to check verification", "Verification check error");
	}
}
