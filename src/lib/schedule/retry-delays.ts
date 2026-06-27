/** Exponential backoff delays (ms) for delivery/processing retries after failure. */
const DELIVERY_RETRY_DELAYS_MS = [
	5 * 60 * 1000,
	15 * 60 * 1000,
	30 * 60 * 1000,
	60 * 60 * 1000,
] as const;

/**
 * Delay before the next retry attempt.
 * `attemptCount` is the number of failed attempts so far (1-based after first failure).
 */
export function computeDeliveryRetryDelayMs(attemptCount: number): number {
	if (attemptCount <= 0) return DELIVERY_RETRY_DELAYS_MS[0];
	const index = Math.min(attemptCount - 1, DELIVERY_RETRY_DELAYS_MS.length - 1);
	return DELIVERY_RETRY_DELAYS_MS[index] ?? DELIVERY_RETRY_DELAYS_MS.at(-1) ?? 60 * 60 * 1000;
}
