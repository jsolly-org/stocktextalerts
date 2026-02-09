import { describe, expect, it } from "vitest";
import { isOutsideMarketHours } from "../../../src/lib/time/format";

describe("isOutsideMarketHours", () => {
	// US market hours: 9:30 AM – 4:00 PM ET

	it("Returns false for a time during market hours in Eastern timezone.", () => {
		const noon = 12 * 60; // 12:00 PM
		expect(isOutsideMarketHours(noon, "America/New_York")).toBe(false);
	});

	it("Returns false for market open in Eastern timezone.", () => {
		const marketOpen = 9 * 60 + 30; // 9:30 AM
		expect(isOutsideMarketHours(marketOpen, "America/New_York")).toBe(false);
	});

	it("Returns true for market close in Eastern timezone.", () => {
		const marketClose = 16 * 60; // 4:00 PM — close is exclusive
		expect(isOutsideMarketHours(marketClose, "America/New_York")).toBe(true);
	});

	it("Returns true for a time before market open in Eastern timezone.", () => {
		const earlyMorning = 7 * 60; // 7:00 AM
		expect(isOutsideMarketHours(earlyMorning, "America/New_York")).toBe(true);
	});

	it("Returns true for a time after market close in Eastern timezone.", () => {
		const evening = 20 * 60; // 8:00 PM
		expect(isOutsideMarketHours(evening, "America/New_York")).toBe(true);
	});

	it("Correctly converts for a US Pacific timezone user.", () => {
		// Market hours in Pacific: 6:30 AM – 1:00 PM
		const nineAmPacific = 9 * 60; // 9:00 AM Pacific = 12:00 PM ET (in market)
		expect(isOutsideMarketHours(nineAmPacific, "America/Los_Angeles")).toBe(
			false,
		);

		const twoAmPacific = 2 * 60; // 2:00 AM Pacific = 5:00 AM ET (outside market)
		expect(isOutsideMarketHours(twoAmPacific, "America/Los_Angeles")).toBe(
			true,
		);
	});

	it("Correctly handles a timezone where market hours cross midnight.", () => {
		// Tokyo is UTC+9, ET is UTC-5 (winter) = 14-hour offset
		// 9:30 AM ET = 11:30 PM JST, 4:00 PM ET = 6:00 AM+1 JST
		// A time at 1:00 AM JST should be inside market hours (wraps midnight)
		const oneAmTokyo = 1 * 60;
		expect(isOutsideMarketHours(oneAmTokyo, "Asia/Tokyo")).toBe(false);

		// 12:00 PM JST should be outside market hours
		const noonTokyo = 12 * 60;
		expect(isOutsideMarketHours(noonTokyo, "Asia/Tokyo")).toBe(true);
	});
});
