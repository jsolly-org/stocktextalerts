/* =============
Twilio SMS
============= */

import twilio, { type RestException } from "twilio";
import { rootLogger } from "../../logging";

import type { DeliveryResult } from "../types";

interface TwilioConfig {
	accountSid: string;
	authToken: string;
	phoneNumber: string;
}

interface SmsRequest {
	to: string;
	body: string;
	from?: string;
}

export type SmsSender = (request: SmsRequest) => Promise<DeliveryResult>;

type TwilioClient = ReturnType<typeof twilio>;

// Reads Twilio credentials from import.meta.env.
// Presence is guaranteed by middleware env validation; types reflect this via ImportMetaEnv.
/**
 * Read validated Twilio credentials from environment variables.
 */
export function readTwilioConfig(): TwilioConfig {
	return {
		accountSid: import.meta.env.TWILIO_ACCOUNT_SID,
		authToken: import.meta.env.TWILIO_AUTH_TOKEN,
		phoneNumber: import.meta.env.TWILIO_PHONE_NUMBER,
	};
}

/**
 * Create a Twilio REST client from validated config.
 */
export function createTwilioClient(config: TwilioConfig): TwilioClient {
	return twilio(config.accountSid, config.authToken);
}

/**
 * Create an SMS sender function backed by Twilio.
 *
 * In `test` mode, returns a deterministic mock sender to avoid external API calls.
 */
export function createSmsSender(
	client: TwilioClient,
	defaultFromNumber: string,
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
		const from = request.from ?? defaultFromNumber;

		try {
			const message = await client.messages.create({
				body: request.body,
				from,
				to: request.to,
			});

			return {
				success: true,
				messageSid: message.sid,
			};
		} catch (error) {
			const maskedTo = request.to.slice(-4).padStart(request.to.length, "*");
			rootLogger.error(
				"Twilio SMS send error",
				{ action: "send_sms", from, to: maskedTo },
				error,
			);

			// Twilio SDK throws RestException for API errors (HTTP 400-5xx).
			// RestException has: status (HTTP status), code (numeric Twilio error code),
			// message, and moreInfo.
			if (error instanceof Error && "status" in error && "code" in error) {
				const twilioError = error as RestException;
				return {
					success: false,
					error: twilioError.message,
					errorCode: twilioError.code ? String(twilioError.code) : undefined,
				};
			}

			const errorMessage =
				error instanceof Error ? error.message : "Failed to send SMS";

			return {
				success: false,
				error: errorMessage,
			};
		}
	};
}
