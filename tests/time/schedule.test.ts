import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { calculateNextSendAt } from "../../src/lib/time/schedule";

function formatLocalParts(
	date: DateTime,
	timezone: string,
): {
	ymd: string;
	hm: string;
} {
	const local = date.setZone(timezone);
	const ymd = local.toFormat("yyyy-LL-dd");
	const hm = local.toFormat("HH:mm");

	return { ymd, hm };
}

describe("calculateNextSendAt", () => {
	it("schedules same local day when target time is in the future", () => {
		const timezone = "America/New_York";
		const now = DateTime.fromISO("2026-01-13T13:00:00.000Z"); // 08:00 local (winter)
		const next = calculateNextSendAt(9 * 60, timezone, now);

		expect(next).not.toBeNull();
		expect(next?.toISO()).toBe("2026-01-13T14:00:00.000Z"); // 09:00 local
	});

	it("schedules next local day when target time is now or earlier", () => {
		const timezone = "America/New_York";
		const now = DateTime.fromISO("2026-01-13T14:00:00.000Z"); // 09:00 local (winter)
		const next = calculateNextSendAt(9 * 60, timezone, now);

		expect(next).not.toBeNull();
		expect(next?.toISO()).toBe("2026-01-14T14:00:00.000Z"); // next day 09:00 local
	});

	it("handles nonexistent local times on DST spring-forward days", () => {
		const timezone = "America/New_York";
		const now = DateTime.fromISO("2025-03-09T06:00:00.000Z"); // 01:00 local (before the jump)
		const next = calculateNextSendAt(2 * 60 + 30, timezone, now);

		expect(next).not.toBeNull();
		// 02:30 local doesn't exist; "compatible" disambiguation moves forward.
		expect(next?.toISO()).toBe("2025-03-09T07:30:00.000Z"); // 03:30 local (EDT)

		const parts = formatLocalParts(next as DateTime, timezone);
		expect(parts.ymd).toBe("2025-03-09");
		expect(parts.hm).toBe("03:30");
	});

	it("picks a deterministic instant for ambiguous local times on DST fall-back days", () => {
		const timezone = "America/New_York";
		const now = DateTime.fromISO("2025-11-02T04:00:00.000Z"); // 00:00 local (still EDT)
		const next = calculateNextSendAt(1 * 60 + 30, timezone, now);

		expect(next).not.toBeNull();
		// 01:30 local happens twice; Luxon defaults to the later offset.
		expect(next?.toISO()).toBe("2025-11-02T06:30:00.000Z"); // 01:30 local (EST)

		const parts = formatLocalParts(next as DateTime, timezone);
		expect(parts.ymd).toBe("2025-11-02");
		expect(parts.hm).toBe("01:30");
	});
});
