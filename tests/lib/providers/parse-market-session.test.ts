import { describe, expect, it } from "vitest";
import { parseMarketSession } from "../../../src/lib/providers/price-fetcher";
import { expectConsoleWarning } from "../../setup";

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
		expectConsoleWarning(/both earlyHours and afterHours/);
		expect(
			parseMarketSession({ market: "extended-hours", earlyHours: true, afterHours: true }),
		).toBe("closed");
	});

	it("A payload missing the `market` field is safely downgraded to closed and logged at warn", () => {
		expectConsoleWarning(/missing 'market'/);
		expect(parseMarketSession({ earlyHours: false, afterHours: false })).toBe("closed");
	});

	it("A non-object payload is safely downgraded to closed and logged at warn", () => {
		expectConsoleWarning(/not an object/);
		expect(parseMarketSession(null)).toBe("closed");
	});

	it("When the market is open, set early/after flags do not override regular-session classification", () => {
		// Authoritative: market === "open" wins regardless of other flags.
		expect(parseMarketSession({ market: "open", earlyHours: true, afterHours: true })).toBe(
			"regular",
		);
	});
});
