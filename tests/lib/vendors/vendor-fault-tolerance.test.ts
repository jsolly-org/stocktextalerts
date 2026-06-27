import { afterEach, describe, expect, it, vi } from "vitest";
import {
	computeDeliveryRetryDelayMs,
	getAndResetOptionalVendorSkipCount,
	isOptionalVendorUnavailable,
	noteOptionalVendorSkip,
	recordOptionalVendorFailure,
	recordOptionalVendorSuccess,
	resetOptionalVendorCircuitsForTests,
	withOptionalVendorBudget,
} from "../../../src/lib/vendors/vendor-fault-tolerance";

describe("vendor-fault-tolerance", () => {
	afterEach(() => {
		resetOptionalVendorCircuitsForTests();
		vi.useRealTimers();
	});

	it("computeDeliveryRetryDelayMs uses 5m, 15m, 30m, then 60m cap", () => {
		expect(computeDeliveryRetryDelayMs(1)).toBe(5 * 60 * 1000);
		expect(computeDeliveryRetryDelayMs(2)).toBe(15 * 60 * 1000);
		expect(computeDeliveryRetryDelayMs(3)).toBe(30 * 60 * 1000);
		expect(computeDeliveryRetryDelayMs(4)).toBe(60 * 60 * 1000);
		expect(computeDeliveryRetryDelayMs(99)).toBe(60 * 60 * 1000);
	});

	it("withOptionalVendorBudget returns ok when fn finishes within budget", async () => {
		const result = await withOptionalVendorBudget("test-vendor", 500, async () => "done");
		expect(result).toEqual({ status: "ok", value: "done" });
	});

	it("withOptionalVendorBudget skips when budget is exceeded", async () => {
		vi.useFakeTimers();
		const pending = withOptionalVendorBudget("slow-vendor", 10, async () => {
			await new Promise(() => {});
			return "never";
		});
		await vi.advanceTimersByTimeAsync(15);
		const result = await pending;
		expect(result.status).toBe("skipped");
		if (result.status === "skipped") {
			expect(result.reason).toBe("budget_exceeded");
		}
	});

	it("opens circuit after repeated failures and recovers on success", async () => {
		recordOptionalVendorFailure("circuit-test");
		expect(isOptionalVendorUnavailable("circuit-test")).toBe(false);
		recordOptionalVendorFailure("circuit-test");
		expect(isOptionalVendorUnavailable("circuit-test")).toBe(true);

		const skipped = await withOptionalVendorBudget("circuit-test", 1000, async () => "x");
		expect(skipped.status).toBe("skipped");
		if (skipped.status === "skipped") {
			expect(skipped.reason).toBe("circuit_open");
		}

		recordOptionalVendorSuccess("circuit-test");
		expect(isOptionalVendorUnavailable("circuit-test")).toBe(false);
	});

	it("tracks optional vendor skip count for scheduler summary", () => {
		expect(getAndResetOptionalVendorSkipCount()).toBe(0);
		noteOptionalVendorSkip();
		noteOptionalVendorSkip();
		expect(getAndResetOptionalVendorSkipCount()).toBe(2);
		expect(getAndResetOptionalVendorSkipCount()).toBe(0);
	});
});
