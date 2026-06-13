/* =============
Twilio SMS
============= */

import twilio, { type RestException } from "twilio";
import { requireEnv } from "../../db/env";
import { rootLogger } from "../../logging";
import { isProduction } from "../../runtime/mode";

import { withDeliveryRetry } from "../delivery-retry";
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

/**
 * Read validated Twilio credentials from environment variables.
 */
export function readTwilioConfig(): TwilioConfig {
	return {
		accountSid: requireEnv("TWILIO_ACCOUNT_SID"),
		authToken: requireEnv("TWILIO_AUTH_TOKEN"),
		phoneNumber: requireEnv("TWILIO_PHONE_NUMBER"),
	};
}

/**
 * Create a Twilio REST client from validated config.
 */
export function createTwilioClient(config: TwilioConfig): TwilioClient {
	// 30s per-request timeout so a hung Twilio API can't park the Lambda.
	// Retries are handled by withDeliveryRetry, not the SDK.
	return twilio(config.accountSid, config.authToken, { timeout: 30_000, autoRetry: false });
}

/**
 * Create an SMS sender function backed by Twilio.
 *
 * SMS has **no live test tier**. Tests and `astro dev` always receive a
 * deterministic mock; only production builds reach real Twilio. `--live=sms`
 * was removed on 2026-04-11 — see AGENTS.md#testing-philosophy — because
 * the harness had no way to prevent real-number delivery or per-message
 * Twilio charges. SMS code paths are covered by unit/integration tests
 * that assert against the mock's recorded request shape.
 */
export function createSmsSender(client: TwilioClient, defaultFromNumber: string): SmsSender {
	// Hard gate: non-production always mocks. The `client` arg is ignored in
	// this branch, so even if upstream constructs a real Twilio client with
	// prod credentials from .env.local, we never call .messages.create on it.
	if (!isProduction()) {
		const behavior = process.env.SMS_TEST_BEHAVIOR ?? "success";
		const testMessageSid = process.env.SMS_TEST_MESSAGE_SID ?? "mock";
		const testError = process.env.SMS_TEST_ERROR ?? "Test SMS failure";
		const testErrorCode = process.env.SMS_TEST_ERROR_CODE;
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
					rootLogger.warn("Twilio SMS send attempt failed", {
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
