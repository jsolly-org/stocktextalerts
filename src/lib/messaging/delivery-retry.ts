import { rootLogger } from "../logging";
import type { DeliveryResult } from "./types";

/**
 * Error codes that warrant a retry. Twilio surfaces numeric codes as strings
 * (e.g. "20429"); SES/AWS surface exception names; the abort timeout surfaces
 * "TimeoutError". Everything else (bad recipient, invalid number, auth) is
 * permanent and must NOT be retried.
 */
const TRANSIENT_DELIVERY_ERROR_CODES = new Set<string>([
	"TimeoutError",
	"AbortError",
	"ThrottlingException",
	"TooManyRequestsException",
	"ServiceUnavailable",
	"ServiceUnavailableException",
	"InternalFailure",
	"InternalServerError",
	"500",
	"502",
	"503",
	"504",
	"20429", // Twilio: too many requests
	"20500", // Twilio: internal server error
	"20503", // Twilio: service unavailable
]);

/** True when a failed delivery result is worth retrying. */
export function isTransientDeliveryError(result: DeliveryResult): boolean {
	if (result.success) return false;
	return result.errorCode !== undefined && TRANSIENT_DELIVERY_ERROR_CODES.has(result.errorCode);
}

interface DeliveryRetryOptions {
	channel: "email" | "sms";
	/** Total attempts including the first. Default 3. */
	maxAttempts?: number;
	/** Base backoff; attempt N waits baseDelayMs * 2^(N-1). Default 500ms. */
	baseDelayMs?: number;
	isTransient?: (result: DeliveryResult) => boolean;
	/** Injected in tests so we don't sleep against real timers. */
	sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry a single delivery (SMS/email) on transient failure with exponential
 * backoff. Mirrors the explicit retry loops used for Massive/Finnhub/Grok.
 * Logs `warn` per retry, `error` only when all attempts are exhausted.
 */
export async function withDeliveryRetry(
	send: () => Promise<DeliveryResult>,
	options: DeliveryRetryOptions,
): Promise<DeliveryResult> {
	const maxAttempts = options.maxAttempts ?? 3;
	const baseDelayMs = options.baseDelayMs ?? 500;
	const isTransient = options.isTransient ?? isTransientDeliveryError;
	const sleep = options.sleep ?? defaultSleep;

	let lastResult: DeliveryResult = { success: false, error: "no delivery attempt made" };

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		lastResult = await send();
		if (lastResult.success) return lastResult;

		const retriable = isTransient(lastResult) && attempt < maxAttempts;
		if (!retriable) {
			rootLogger.error("Delivery failed", {
				channel: options.channel,
				attempts: attempt,
				errorCode: lastResult.errorCode,
				error: lastResult.error,
			});
			return lastResult;
		}

		const delayMs = baseDelayMs * 2 ** (attempt - 1);
		rootLogger.warn("Transient delivery failure; retrying", {
			channel: options.channel,
			attempt,
			nextDelayMs: delayMs,
			errorCode: lastResult.errorCode,
		});
		await sleep(delayMs);
	}

	return lastResult;
}
