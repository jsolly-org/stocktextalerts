/* =============
Twilio SMS
============= */

import twilio, { type RestException } from "twilio";

import type { DeliveryResult } from "../shared";

export interface TwilioConfig {
	accountSid: string;
	authToken: string;
	phoneNumber: string;
}

export interface SmsRequest {
	to: string;
	body: string;
	from?: string;
}

export type SmsSender = (request: SmsRequest) => Promise<DeliveryResult>;

export type TwilioClient = ReturnType<typeof twilio>;

export function readTwilioConfig(): TwilioConfig {
	const accountSid = import.meta.env.TWILIO_ACCOUNT_SID;
	const authToken = import.meta.env.TWILIO_AUTH_TOKEN;
	const phoneNumber = import.meta.env.TWILIO_PHONE_NUMBER;

	if (!accountSid || !authToken || !phoneNumber) {
		throw new Error("Missing Twilio configuration in environment variables");
	}

	return { accountSid, authToken, phoneNumber };
}

export function createTwilioClient(config: TwilioConfig): TwilioClient {
	return twilio(config.accountSid, config.authToken);
}

export function createSmsSender(
	client: TwilioClient,
	defaultFromNumber: string,
): SmsSender {
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
			console.error("Twilio SMS send error:", error);

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
