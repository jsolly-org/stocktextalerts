/* =============
AWS End User Messaging SMS
============= */

import {
	PinpointSMSVoiceV2Client,
	SendTextMessageCommand,
} from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { rootLogger } from "../../logging";

import type { DeliveryResult } from "../types";

interface SmsConfig {
	region: string;
	originationIdentity: string;
}

interface SmsRequest {
	to: string;
	body: string;
	from?: string;
}

export type SmsSender = (request: SmsRequest) => Promise<DeliveryResult>;

type SmsClient = PinpointSMSVoiceV2Client;

/**
 * Read validated AWS SMS credentials from environment variables.
 */
export function readSmsConfig(): SmsConfig {
	return {
		region: import.meta.env.AWS_REGION,
		originationIdentity: import.meta.env.AWS_SMS_ORIGINATION_IDENTITY,
	};
}

/**
 * Create an AWS End User Messaging SMS client from validated config.
 */
export function createSmsClient(config: SmsConfig): SmsClient {
	return new PinpointSMSVoiceV2Client({ region: config.region });
}

/**
 * Create an SMS sender function backed by AWS End User Messaging.
 *
 * In `test` mode, returns a deterministic mock sender to avoid external API calls.
 */
export function createSmsSender(
	client: SmsClient,
	defaultOriginationIdentity: string,
): SmsSender {
	// In test mode, return a mock sender unless --live=sms is set.
	// LIVE_API_PROVIDERS is set by run-vitest.ts before Vitest starts, making it
	// visible in source code (unlike vi.stubEnv which only affects test context).
	const liveProviders = import.meta.env.LIVE_API_PROVIDERS || "";
	const liveSms =
		liveProviders === "all" ||
		liveProviders
			.split(",")
			.map((s: string) => s.trim())
			.includes("sms");
	if (import.meta.env.MODE === "test" && !liveSms) {
		const behavior = import.meta.env.SMS_TEST_BEHAVIOR ?? "success";
		const testMessageSid = import.meta.env.SMS_TEST_MESSAGE_SID ?? "test";
		const testError = import.meta.env.SMS_TEST_ERROR ?? "Test SMS failure";
		const testErrorCode = import.meta.env.SMS_TEST_ERROR_CODE;
		return async (request: SmsRequest) => {
			if (!request.to || !request.body) {
				return {
					success: false,
					error: `Test mock: missing required field(s): ${[!request.to && "to", !request.body && "body"].filter(Boolean).join(", ")}`,
				};
			}
			if (behavior === "fail") {
				return {
					success: false,
					error: testError,
					errorCode: testErrorCode,
				};
			}
			return {
				success: true,
				messageSid: testMessageSid,
			};
		};
	}

	return async (request: SmsRequest): Promise<DeliveryResult> => {
		const originationIdentity = request.from ?? defaultOriginationIdentity;

		try {
			const command = new SendTextMessageCommand({
				DestinationPhoneNumber: request.to,
				MessageBody: request.body,
				OriginationIdentity: originationIdentity,
			});

			const response = await client.send(command);

			return {
				success: true,
				messageSid: response.MessageId,
			};
		} catch (error) {
			const maskedTo = request.to.slice(-4).padStart(request.to.length, "*");
			rootLogger.error(
				"AWS SMS send error",
				{ action: "send_sms", originationIdentity, to: maskedTo },
				error,
			);

			const errorMessage =
				error instanceof Error ? error.message : "Failed to send SMS";
			const errorCode = (error as { name?: string })?.name;

			return {
				success: false,
				error: errorMessage,
				errorCode: errorCode ?? undefined,
			};
		}
	};
}
