import twilio, { type RestException } from "twilio";
import { rootLogger } from "../../../../lib/logging";

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

	const errorMessage = error instanceof Error ? error.message : defaultMessage;
	const errorType = error?.constructor?.name || typeof error;
	rootLogger.error(
		logPrefix,
		{
			errorType,
			message: errorMessage,
		},
		error instanceof Error ? error : undefined,
	);
	return {
		success: false,
		error: errorMessage,
	};
}

function createVerificationClient(): {
	client: ReturnType<typeof twilio>;
	serviceSid: string;
} {
	const twilioAccountSid = import.meta.env.TWILIO_ACCOUNT_SID;
	const twilioAuthToken = import.meta.env.TWILIO_AUTH_TOKEN;
	const twilioVerifyServiceSid = import.meta.env.TWILIO_VERIFY_SERVICE_SID;

	return {
		client: twilio(twilioAccountSid, twilioAuthToken),
		serviceSid: twilioVerifyServiceSid,
	};
}

export async function sendVerification(
	fullPhone: string,
): Promise<{ success: boolean; error?: string }> {
	try {
		const { client, serviceSid } = createVerificationClient();
		await client.verify.v2
			.services(serviceSid)
			.verifications.create({ to: fullPhone, channel: "sms" });

		return { success: true };
	} catch (error) {
		return handleTwilioError(
			error,
			"Failed to send verification",
			"Verification send error",
		);
	}
}

export async function checkVerification(
	fullPhone: string,
	code: string,
): Promise<{ success: boolean; error?: string }> {
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
		return handleTwilioError(
			error,
			"Failed to check verification",
			"Verification check error",
		);
	}
}
