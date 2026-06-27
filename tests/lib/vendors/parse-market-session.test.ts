import { describe, expect, it } from "vitest";
import { parseMarketSession } from "../../../src/lib/vendors/price-fetcher";
import { warnSpy } from "../../setup";

/** True when any console.warn logged during this test matches `pattern`. */
function loggedWarning(pattern: RegExp): boolean {
	return warnSpy.mock.calls.some(([raw]) => pattern.test(String(raw)));
}

describe("parseMarketSession", () => {
	it("A regular-hours payload from Massive is classified as a regular session", () => {
		expect(parseMarketSession({ market: "open", earlyHours: false, afterHours: false })).toBe(
			"regular",
		);
	});

	it("A pre-market payload from Massive is classified as pre-market", () => {
		expect(
			parseMarketSession({ market: "extended-hours", earlyHours: true, afterHours: false }),
		).toBe("pre");
	});

	it("An after-hours payload from Massive is classified as after-hours", () => {
		expect(
			parseMarketSession({ market: "extended-hours", earlyHours: false, afterHours: true }),
		).toBe("after");
	});

	it("A fully-closed payload from Massive is classified as closed", () => {
		expect(parseMarketSession({ market: "closed", earlyHours: false, afterHours: false })).toBe(
			"closed",
		);
	});

	it("A corrupt payload with both early/after flags set is safely downgraded to closed and logged at warn", () => {
		expect(
			parseMarketSession({ market: "extended-hours", earlyHours: true, afterHours: true }),
		).toBe("closed");
		expect(loggedWarning(/both earlyHours and afterHours/)).toBe(true);
	});

	it("A payload missing the `market` field is safely downgraded to closed and logged at warn", () => {
		expect(parseMarketSession({ earlyHours: false, afterHours: false })).toBe("closed");
		expect(loggedWarning(/missing 'market'/)).toBe(true);
	});

	it("A non-object payload is safely downgraded to closed and logged at warn", () => {
		expect(parseMarketSession(null)).toBe("closed");
		expect(loggedWarning(/not an object/)).toBe(true);
	});

	it("When the market is open, set early/after flags do not override regular-session classification", () => {
		// Authoritative: market === "open" wins regardless of other flags.
		expect(parseMarketSession({ market: "open", earlyHours: true, afterHours: true })).toBe(
			"regular",
		);
	});
});
