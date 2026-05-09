import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { US_MARKET_TIMEZONE } from "../../../src/lib/constants";
import { calculateNextSendAt } from "../../../src/lib/time/scheduled-times";

function formatEtParts(date: DateTime): {
	ymd: string;
	hm: string;
} {
	const eastern = date.setZone(US_MARKET_TIMEZONE);
	const ymd = eastern.toFormat("yyyy-LL-dd");
	const hm = eastern.toFormat("HH:mm");

	return { ymd, hm };
}

describe("A scheduler picks the next ET-canonical send time.", () => {
	it("When the target ET time is later today, the next send is scheduled for today.", () => {
		const now = DateTime.fromISO("2026-01-13T13:00:00.000Z"); // 08:00 ET (winter)
		const next = calculateNextSendAt(9 * 60, now); // 09:00 ET

		expect(next).not.toBeNull();
		expect(next?.toISO()).toBe("2026-01-13T14:00:00.000Z"); // 09:00 ET
	});

	it("When the target ET time has already passed, the next send is scheduled for tomorrow.", () => {
		const now = DateTime.fromISO("2026-01-13T14:00:00.000Z"); // 09:00 ET (winter)
		const next = calculateNextSendAt(9 * 60, now); // 09:00 ET

		expect(next).not.toBeNull();
		expect(next?.toISO()).toBe("2026-01-14T14:00:00.000Z"); // next day 09:00 ET
	});

	it("When ET spring-forward skips a local time, the next send is scheduled at the next valid ET time.", () => {
		const now = DateTime.fromISO("2025-03-09T06:00:00.000Z"); // 01:00 ET (before the jump)
		const next = calculateNextSendAt(2 * 60 + 30, now); // 02:30 ET

		expect(next).not.toBeNull();
		// 02:30 ET doesn't exist on the spring-forward day; "compatible" disambiguation moves forward.
		expect(next?.toISO()).toBe("2025-03-09T07:30:00.000Z"); // 03:30 EDT

		const parts = formatEtParts(next as DateTime);
		expect(parts.ymd).toBe("2025-03-09");
		expect(parts.hm).toBe("03:30");
	});

	it("When ET fall-back repeats a local time, the chosen send time uses the later offset.", () => {
		const now = DateTime.fromISO("2025-11-02T04:00:00.000Z"); // 00:00 ET (still EDT)
		const next = calculateNextSendAt(1 * 60 + 30, now); // 01:30 ET

		expect(next).not.toBeNull();
		// 01:30 ET happens twice; later offset (EST) wins.
		expect(next?.toISO()).toBe("2025-11-02T06:30:00.000Z"); // 01:30 EST

		const parts = formatEtParts(next as DateTime);
		expect(parts.ymd).toBe("2025-11-02");
		expect(parts.hm).toBe("01:30");
	});

	it("Noon ET resolves consistently regardless of where the caller sits (only ET-minutes flow into the function).", () => {
		// Caller's local timezone is irrelevant — function takes ET-minutes only.
		const now = DateTime.fromISO("2026-01-14T16:00:00.000Z"); // 11:00 ET (winter)
		const next = calculateNextSendAt(12 * 60, now); // 12:00 ET

		expect(next).not.toBeNull();
		expect(next?.toISO()).toBe("2026-01-14T17:00:00.000Z"); // 12:00 EST
		const parts = formatEtParts(next as DateTime);
		expect(parts.ymd).toBe("2026-01-14");
		expect(parts.hm).toBe("12:00");
	});
});
