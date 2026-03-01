import { createHash } from "node:crypto";
import {
	PinpointClient,
	SendOTPMessageCommand,
	VerifyOTPMessageCommand,
} from "@aws-sdk/client-pinpoint";
import { rootLogger } from "../logging";

function handleAwsError(
	error: unknown,
	defaultMessage: string,
	logPrefix: string,
): { success: false; error: string } {
	if (error instanceof Error) {
		const awsError = error as Error & {
			name?: string;
			$metadata?: { httpStatusCode?: number };
		};
		rootLogger.error(
			logPrefix,
			{
				name: awsError.name,
				httpStatus: awsError.$metadata?.httpStatusCode,
			},
			awsError,
		);
		return {
			success: false,
			error: awsError.message,
		};
	}

	const errorType = error?.constructor?.name || typeof error;
	rootLogger.error(
		logPrefix,
		{
			errorType,
			message: defaultMessage,
		},
		undefined,
	);
	return {
		success: false,
		error: defaultMessage,
	};
}

function createOtpClient(): {
	client: PinpointClient;
	applicationId: string;
	originationIdentity: string;
} {
	const region = import.meta.env.AWS_REGION;
	const applicationId = import.meta.env.AWS_PINPOINT_APP_ID;
	const originationIdentity = import.meta.env.AWS_SMS_ORIGINATION_IDENTITY;

	return {
		client: new PinpointClient({ region }),
		applicationId,
		originationIdentity,
	};
}

/**
 * Derive a stable reference ID from a phone number for matching send/verify pairs.
 */
function deriveReferenceId(fullPhone: string): string {
	return createHash("sha256").update(fullPhone).digest("hex").slice(0, 48);
}

/**
 * Send an SMS verification code to the given fully-qualified phone number.
 */
export async function sendVerification(
	fullPhone: string,
): Promise<{ success: boolean; error?: string }> {
	try {
		const { client, applicationId, originationIdentity } = createOtpClient();
		const command = new SendOTPMessageCommand({
			ApplicationId: applicationId,
			SendOTPMessageRequestParameters: {
				Channel: "SMS",
				BrandName: "StockTextAlerts",
				CodeLength: 6,
				ValidityPeriod: 10,
				AllowedAttempts: 5,
				OriginationIdentity: originationIdentity,
				DestinationIdentity: fullPhone,
				ReferenceId: deriveReferenceId(fullPhone),
			},
		});

		await client.send(command);
		return { success: true };
	} catch (error) {
		return handleAwsError(
			error,
			"Failed to send verification",
			"Verification send error",
		);
	}
}

/**
 * Verify an SMS code for the given fully-qualified phone number.
 */
export async function checkVerification(
	fullPhone: string,
	code: string,
): Promise<{ success: boolean; error?: string }> {
	try {
		const { client, applicationId } = createOtpClient();
		const command = new VerifyOTPMessageCommand({
			ApplicationId: applicationId,
			VerifyOTPMessageRequestParameters: {
				DestinationIdentity: fullPhone,
				Otp: code,
				ReferenceId: deriveReferenceId(fullPhone),
			},
		});

		const response = await client.send(command);

		if (response.VerificationResponse?.Valid) {
			return { success: true };
		}

		return { success: false, error: "Invalid verification code" };
	} catch (error) {
		return handleAwsError(
			error,
			"Failed to check verification",
			"Verification check error",
		);
	}
}
