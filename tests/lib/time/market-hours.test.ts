import { describe, expect, it } from "vitest";
import { isOutsideMarketHours } from "../../../src/lib/time/format";

describe("isOutsideMarketHours", () => {
	// Notification window: 10:00 AM – 3:59 PM ET

	it("Returns false for a time during market hours in Eastern timezone.", () => {
		const noon = 12 * 60; // 12:00 PM
		expect(isOutsideMarketHours(noon, "America/New_York")).toBe(false);
	});

	it("Returns false for earliest allowed time (10:00 AM ET).", () => {
		const earliest = 10 * 60; // 10:00 AM
		expect(isOutsideMarketHours(earliest, "America/New_York")).toBe(false);
	});

	it("Returns false for latest allowed time (3:59 PM ET).", () => {
		const latest = 15 * 60 + 59; // 3:59 PM
		expect(isOutsideMarketHours(latest, "America/New_York")).toBe(false);
	});

	it("Returns true for 9:30 AM ET (before notification window).", () => {
		const marketOpen = 9 * 60 + 30; // 9:30 AM
		expect(isOutsideMarketHours(marketOpen, "America/New_York")).toBe(true);
	});

	it("Returns true for market close (4:00 PM ET).", () => {
		const marketClose = 16 * 60; // 4:00 PM
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
		// Notification window in Pacific: 7:00 AM – 12:59 PM
		const nineAmPacific = 9 * 60; // 9:00 AM Pacific = 12:00 PM ET (in window)
		expect(isOutsideMarketHours(nineAmPacific, "America/Los_Angeles")).toBe(
			false,
		);

		const twoAmPacific = 2 * 60; // 2:00 AM Pacific = 5:00 AM ET (outside window)
		expect(isOutsideMarketHours(twoAmPacific, "America/Los_Angeles")).toBe(
			true,
		);
	});

	it("Correctly handles a timezone where market hours cross midnight.", () => {
		// Tokyo is UTC+9, ET is UTC-4 (DST) = 13-hour offset
		// 10:00 AM ET = 11:00 PM JST, 3:59 PM ET = 4:59 AM+1 JST
		// A time at 1:00 AM JST should be inside notification window (wraps midnight)
		const oneAmTokyo = 1 * 60;
		expect(isOutsideMarketHours(oneAmTokyo, "Asia/Tokyo")).toBe(false);

		// 12:00 PM JST should be outside notification window
		const noonTokyo = 12 * 60;
		expect(isOutsideMarketHours(noonTokyo, "Asia/Tokyo")).toBe(true);
	});
});
