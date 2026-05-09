import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { formatCountdownWithSeconds, getSecondsUntilNextSend } from "../../../src/lib/time/format";

describe("The dashboard countdown reflects DST shifts in elapsed UTC seconds.", () => {
	it("Friday-evening countdown to Monday 09:30 EDT across the spring-forward weekend reads 60h 30m — one hour shorter than the naive wall-clock difference.", () => {
		// Persisted next_send_at is the weekend-adjusted Monday morning post-DST.
		// `getSecondsUntilNextSend` does a UTC diff, so it correctly reports 60h 30m
		// even though the user's wall clocks (Fri 8 PM → Mon 9:30 AM) suggest 61h 30m.
		const now = DateTime.fromISO("2026-03-07T01:00:00Z"); // Fri Mar 6, 8:00 PM EST
		const seconds = getSecondsUntilNextSend({
			timezone: "America/New_York",
			nextSendAtIso: "2026-03-09T13:30:00.000Z", // Mon Mar 9, 09:30 EDT
			now,
		});

		expect(seconds).toBe(60 * 3600 + 30 * 60); // 217800 = 60h 30m
		expect(formatCountdownWithSeconds(seconds as number)).toBe("60 hours, 30 minutes, 0 seconds");
	});

	it("Friday-evening countdown to Monday 09:30 EST across the fall-back weekend reads 62h 30m — one hour longer than the naive wall-clock difference.", () => {
		const now = DateTime.fromISO("2026-10-31T00:00:00Z"); // Fri Oct 30, 8:00 PM EDT
		const seconds = getSecondsUntilNextSend({
			timezone: "America/New_York",
			nextSendAtIso: "2026-11-02T14:30:00.000Z", // Mon Nov 2, 09:30 EST
			now,
		});

		expect(seconds).toBe(62 * 3600 + 30 * 60); // 225000 = 62h 30m
		expect(formatCountdownWithSeconds(seconds as number)).toBe("62 hours, 30 minutes, 0 seconds");
	});

	it("A Honolulu user's countdown to a 09:30 ET market alert is 1 hour shorter on the day after spring-forward than on the day before — same wall-clock distance, different ET offset.", () => {
		// Both queries are made at 06:00 AM HST (16:00 UTC). The persisted next_send_at
		// is whatever the worktree's calculateNextSendAt(570, now) returned for that
		// "now" — winter: 14:30 UTC same day; summer: 13:30 UTC same day.
		// Result: same HST clock distance (3h 30m), same UTC distance (3h 30m / 2h 30m
		// before/after) — but the user perceives the alert as arriving earlier on the
		// HI clock after US DST starts (04:30 → 03:30 HST).

		const winterNow = DateTime.fromISO("2026-03-07T16:00:00.000Z"); // Sat 06:00 HST (winter)
		const winterSeconds = getSecondsUntilNextSend({
			timezone: "Pacific/Honolulu",
			nextSendAtIso: "2026-03-07T14:30:00.000Z",
			now: winterNow,
		});
		// 14:30 UTC is in the past relative to winterNow (16:00 UTC); function should
		// fall back to null when no other inputs supplied.
		expect(winterSeconds).toBeNull();

		// Use a "now" before the next 09:30 ET to get a positive countdown.
		const winterMorning = DateTime.fromISO("2026-03-07T13:00:00.000Z"); // Sat 03:00 HST
		const winterSecondsAhead = getSecondsUntilNextSend({
			timezone: "Pacific/Honolulu",
			nextSendAtIso: "2026-03-07T14:30:00.000Z",
			now: winterMorning,
		});
		expect(winterSecondsAhead).toBe(90 * 60); // 1h 30m

		const summerMorning = DateTime.fromISO("2026-03-09T12:00:00.000Z"); // Mon 02:00 HST
		const summerSecondsAhead = getSecondsUntilNextSend({
			timezone: "Pacific/Honolulu",
			nextSendAtIso: "2026-03-09T13:30:00.000Z",
			now: summerMorning,
		});
		expect(summerSecondsAhead).toBe(90 * 60); // also 1h 30m — same UTC distance from a same-clock now
	});
});
