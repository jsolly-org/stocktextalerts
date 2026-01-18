import { describe, expect, it } from "vitest";
import { calculateNextSendAt } from "../../../../src/pages/api/notifications/shared";

function formatLocalParts(
	date: Date,
	timezone: string,
): {
	ymd: string;
	hm: string;
} {
	const ymd = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);

	const hm = new Intl.DateTimeFormat("en-GB", {
		timeZone: timezone,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(date);

	return { ymd, hm };
}

describe("calculateNextSendAt", () => {
	it("schedules same local day when target time is in the future", () => {
		const timezone = "America/New_York";
		const now = new Date("2026-01-13T13:00:00.000Z"); // 08:00 local (winter)
		const next = calculateNextSendAt(9 * 60, timezone, () => now);

		expect(next).not.toBeNull();
		expect(next?.toISOString()).toBe("2026-01-13T14:00:00.000Z"); // 09:00 local
	});

	it("schedules next local day when target time is now or earlier", () => {
		const timezone = "America/New_York";
		const now = new Date("2026-01-13T14:00:00.000Z"); // 09:00 local (winter)
		const next = calculateNextSendAt(9 * 60, timezone, () => now);

		expect(next).not.toBeNull();
		expect(next?.toISOString()).toBe("2026-01-14T14:00:00.000Z"); // next day 09:00 local
	});

	it("handles nonexistent local times on DST spring-forward days", () => {
		const timezone = "America/New_York";
		const now = new Date("2025-03-09T06:00:00.000Z"); // 01:00 local (before the jump)
		const next = calculateNextSendAt(2 * 60 + 30, timezone, () => now);

		expect(next).not.toBeNull();
		// 02:30 local doesn't exist; "compatible" disambiguation moves forward.
		expect(next?.toISOString()).toBe("2025-03-09T07:30:00.000Z"); // 03:30 local (EDT)

		const parts = formatLocalParts(next as Date, timezone);
		expect(parts.ymd).toBe("2025-03-09");
		expect(parts.hm).toBe("03:30");
	});

	it("picks a deterministic instant for ambiguous local times on DST fall-back days", () => {
		const timezone = "America/New_York";
		const now = new Date("2025-11-02T04:00:00.000Z"); // 00:00 local (still EDT)
		const next = calculateNextSendAt(1 * 60 + 30, timezone, () => now);

		expect(next).not.toBeNull();
		// 01:30 local happens twice; "compatible" prefers the earlier offset.
		expect(next?.toISOString()).toBe("2025-11-02T05:30:00.000Z"); // 01:30 local (EDT)

		const parts = formatLocalParts(next as Date, timezone);
		expect(parts.ymd).toBe("2025-11-02");
		expect(parts.hm).toBe("01:30");
	});
});
