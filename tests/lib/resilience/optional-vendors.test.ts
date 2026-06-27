import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getAndResetOptionalVendorSkipCount,
	isOptionalVendorUnavailable,
	noteOptionalVendorSkip,
	recordOptionalVendorFailure,
	recordOptionalVendorSuccess,
	resetOptionalVendorCircuitsForTests,
	withOptionalVendorBudget,
} from "../../../src/lib/resilience/optional-vendors";

describe("fault-tolerance", () => {
	afterEach(() => {
		resetOptionalVendorCircuitsForTests();
		vi.useRealTimers();
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
