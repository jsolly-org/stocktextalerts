import { describe, expect, it } from "vitest";
import { isOutsideMarketHours } from "../../../src/lib/time/format";

describe("isOutsideMarketHours", () => {
	// Notification window: 10:00 AM – 3:59 PM ET

	it("A time during market hours in Eastern timezone is treated as inside the window.", () => {
		const noon = 12 * 60; // 12:00 PM
		expect(isOutsideMarketHours(noon, "America/New_York")).toBe(false);
	});

	it("Earliest allowed time (10:00 AM ET) is treated as inside the window.", () => {
		const earliest = 10 * 60; // 10:00 AM
		expect(isOutsideMarketHours(earliest, "America/New_York")).toBe(false);
	});

	it("Latest allowed time (3:59 PM ET) is treated as inside the window.", () => {
		const latest = 15 * 60 + 59; // 3:59 PM
		expect(isOutsideMarketHours(latest, "America/New_York")).toBe(false);
	});

	it("9:30 AM ET (before notification window) is treated as outside the window.", () => {
		const marketOpen = 9 * 60 + 30; // 9:30 AM
		expect(isOutsideMarketHours(marketOpen, "America/New_York")).toBe(true);
	});

	it("Market close (4:00 PM ET) is treated as outside the window.", () => {
		const marketClose = 16 * 60; // 4:00 PM
		expect(isOutsideMarketHours(marketClose, "America/New_York")).toBe(true);
	});

	it("A time before market open in Eastern timezone is treated as outside the window.", () => {
		const earlyMorning = 7 * 60; // 7:00 AM
		expect(isOutsideMarketHours(earlyMorning, "America/New_York")).toBe(true);
	});

	it("A time after market close in Eastern timezone is treated as outside the window.", () => {
		const evening = 20 * 60; // 8:00 PM
		expect(isOutsideMarketHours(evening, "America/New_York")).toBe(true);
	});

	it("A US Pacific timezone user sees correct in-window and outside-window behavior.", () => {
		// Notification window in Pacific: 7:00 AM – 12:59 PM
		const nineAmPacific = 9 * 60; // 9:00 AM Pacific = 12:00 PM ET (in window)
		expect(isOutsideMarketHours(nineAmPacific, "America/Los_Angeles")).toBe(false);

		const twoAmPacific = 2 * 60; // 2:00 AM Pacific = 5:00 AM ET (outside window)
		expect(isOutsideMarketHours(twoAmPacific, "America/Los_Angeles")).toBe(true);
	});

	it("A timezone where market hours cross midnight (e.g. Tokyo) is handled correctly.", () => {
		// Tokyo is UTC+9; ET shifts with DST (-5/-4), so the local window can vary seasonally.
		// 1:00 AM JST should remain inside the mapped notification window.
		const oneAmTokyo = 1 * 60;
		expect(isOutsideMarketHours(oneAmTokyo, "Asia/Tokyo")).toBe(false);

		// 12:00 PM JST should be outside notification window
		const noonTokyo = 12 * 60;
		expect(isOutsideMarketHours(noonTokyo, "Asia/Tokyo")).toBe(true);
	});
});
