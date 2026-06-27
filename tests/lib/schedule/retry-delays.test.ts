import { describe, expect, it } from "vitest";
import { computeDeliveryRetryDelayMs } from "../../../src/lib/schedule/retry-delays";

describe("computeDeliveryRetryDelayMs", () => {
	it("uses 5m, 15m, 30m, then 60m cap", () => {
		expect(computeDeliveryRetryDelayMs(1)).toBe(5 * 60 * 1000);
		expect(computeDeliveryRetryDelayMs(2)).toBe(15 * 60 * 1000);
		expect(computeDeliveryRetryDelayMs(3)).toBe(30 * 60 * 1000);
		expect(computeDeliveryRetryDelayMs(4)).toBe(60 * 60 * 1000);
		expect(computeDeliveryRetryDelayMs(99)).toBe(60 * 60 * 1000);
	});

	it("returns exponential backoff steps capped at 60 minutes", () => {
		expect(computeDeliveryRetryDelayMs(1)).toBe(5 * 60 * 1000);
		expect(computeDeliveryRetryDelayMs(2)).toBe(15 * 60 * 1000);
		expect(computeDeliveryRetryDelayMs(3)).toBe(30 * 60 * 1000);
		expect(computeDeliveryRetryDelayMs(4)).toBe(60 * 60 * 1000);
	});
});
