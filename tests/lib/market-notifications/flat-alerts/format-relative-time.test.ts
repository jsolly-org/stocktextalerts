import { describe, expect, it } from "vitest";
import { formatRelativeMinutesAgo } from "../../../../src/lib/market-notifications/flat-alerts/format";

/**
 * These tests describe what the "Since last alert (N ago)" label in a
 * flat-price-alert re-trigger email says for a few realistic elapsed durations
 * between the previous alert and the current one.
 */
describe("Re-trigger email relative-time label", () => {
	it("Alert that fired less than a minute ago still reads as '1 min ago'", () => {
		const now = new Date("2026-04-10T14:30:00Z").getTime();
		expect(formatRelativeMinutesAgo(now, now)).toBe("1 min ago");
	});

	it("Alert that fired 27 minutes ago reads as '27 min ago'", () => {
		const from = new Date("2026-04-10T14:30:00Z").getTime();
		const to = new Date("2026-04-10T14:57:00Z").getTime();
		expect(formatRelativeMinutesAgo(from, to)).toBe("27 min ago");
	});

	it("Alert that fired 59 minutes ago stays in the minutes bucket", () => {
		const from = new Date("2026-04-10T14:00:00Z").getTime();
		const to = new Date("2026-04-10T14:59:30Z").getTime();
		expect(formatRelativeMinutesAgo(from, to)).toBe("59 min ago");
	});

	it("Alert that fired exactly one hour ago flips to the hours format", () => {
		const from = new Date("2026-04-10T14:00:00Z").getTime();
		const to = new Date("2026-04-10T15:00:00Z").getTime();
		expect(formatRelativeMinutesAgo(from, to)).toBe("1h 0m ago");
	});

	it("Alert that fired 83 minutes ago reads as '1h 23m ago'", () => {
		const from = new Date("2026-04-10T14:00:00Z").getTime();
		const to = new Date("2026-04-10T15:23:00Z").getTime();
		expect(formatRelativeMinutesAgo(from, to)).toBe("1h 23m ago");
	});

	it("Alert that fired 2 hours and 5 minutes ago reads as '2h 5m ago'", () => {
		const from = new Date("2026-04-10T14:00:00Z").getTime();
		const to = new Date("2026-04-10T16:05:00Z").getTime();
		expect(formatRelativeMinutesAgo(from, to)).toBe("2h 5m ago");
	});

	it("Negative duration from clock skew still shows '1 min ago' rather than garbage", () => {
		const from = new Date("2026-04-10T14:30:00Z").getTime();
		const to = new Date("2026-04-10T14:29:00Z").getTime();
		expect(formatRelativeMinutesAgo(from, to)).toBe("1 min ago");
	});
});
