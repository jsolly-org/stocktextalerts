/* =============
Twilio SMS
============= */

import twilio, { type RestException } from "twilio";
import { requireEnv } from "../../db/env";
import { rootLogger } from "../../logging";
import type { DeliveryResult } from "../../types";
import { withDeliveryRetry } from "../delivery-retry";

interface TwilioSenderConfig {
	accountSid: string;
	apiKeySid: string;
	apiKeySecret: string;
	phoneNumber: string;
}

interface SmsRequest {
	to: string;
	body: string;
	from?: string;
}

export type SmsSender = (request: SmsRequest) => Promise<DeliveryResult>;

type TwilioClient = ReturnType<typeof twilio>;

/**
 * Read validated Twilio SENDER credentials from environment variables.
 *
 * Uses a Restricted API key (scoped to messages/create), NOT the account
 * Auth Token. The Auth Token is reserved for inbound webhook signature
 * validation (see pages/api/messaging/inbound.ts) and is intentionally
 * absent from sender runtimes (e.g. the Lambda crons).
 */
export function readTwilioSenderConfig(): TwilioSenderConfig {
	return {
		accountSid: requireEnv("TWILIO_ACCOUNT_SID"),
		apiKeySid: requireEnv("TWILIO_API_KEY_SID"),
		apiKeySecret: requireEnv("TWILIO_API_KEY_SECRET"),
		phoneNumber: requireEnv("TWILIO_PHONE_NUMBER"),
	};
}

/**
 * Create a Twilio REST client authenticated with a Restricted API key.
 */
export function createTwilioClient(config: TwilioSenderConfig): TwilioClient {
	// 30s per-request timeout so a hung Twilio API can't park the Lambda.
	// Retries are handled by withDeliveryRetry, not the SDK.
	// Restricted API key auth: twilio(apiKeySid, apiKeySecret, { accountSid }).
	return twilio(config.apiKeySid, config.apiKeySecret, {
		accountSid: config.accountSid,
		timeout: 30_000,
		autoRetry: false,
	});
}

/** Create an SMS sender function backed by Twilio. */
export function createSmsSender(client: TwilioClient, defaultFromNumber: string): SmsSender {
	return async (request: SmsRequest): Promise<DeliveryResult> => {
		const from = request.from ?? defaultFromNumber;

		return withDeliveryRetry(
			async () => {
				try {
					const message = await client.messages.create({
						body: request.body,
						from,
						to: request.to,
					});
					return { success: true, messageSid: message.sid };
				} catch (error) {
					const maskedTo = request.to.slice(-4).padStart(request.to.length, "*");
					rootLogger.debug("Twilio SMS send attempt failed", {
						action: "send_sms",
						from,
						to: maskedTo,
						error: error instanceof Error ? error.message : String(error),
					});

					if (error instanceof Error && "status" in error && "code" in error) {
						const twilioError = error as RestException;
						return {
							success: false,
							error: twilioError.message,
							errorCode: twilioError.code ? String(twilioError.code) : undefined,
						};
					}

					return {
						success: false,
						error: error instanceof Error ? error.message : "Failed to send SMS",
					};
				}
			},
			{ channel: "sms" },
		);
	};
}
