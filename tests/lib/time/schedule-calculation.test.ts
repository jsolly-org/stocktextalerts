import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { US_MARKET_TIMEZONE } from "../../../src/lib/constants";
import {
	calculateNextSendAt,
	calculateNextSendAtFromTimes,
} from "../../../src/lib/time/schedule/next-send";

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

describe("A scheduler picks the earliest send across multiple ET-canonical times during DST transitions.", () => {
	it("On the spring-forward morning before the jump, [7am, 10am, 4pm] ET resolves to 7am EDT today (skipping the lost 02:00–02:59 hour).", () => {
		// 2026-03-08 is the US spring-forward day (02:00 EST → 03:00 EDT).
		// "Now" is 01:00 EST, before the jump.
		const now = DateTime.fromISO("2026-03-08T06:00:00.000Z");
		const next = calculateNextSendAtFromTimes([7 * 60, 10 * 60, 16 * 60], now);

		expect(next).not.toBeNull();
		// 7am ET on 2026-03-08 is 7am EDT (the EST 7am doesn't exist post-jump).
		expect(next?.toISO()).toBe("2026-03-08T11:00:00.000Z");
		const parts = formatEtParts(next as DateTime);
		expect(parts.ymd).toBe("2026-03-08");
		expect(parts.hm).toBe("07:00");
	});

	it("On the fall-back morning, [1am, 9am] ET resolves to 1am EST — the later of the two duplicate 1am occurrences.", () => {
		// 2026-11-01 is the US fall-back day (02:00 EDT → 01:00 EST; 01:00–01:59 occurs twice).
		// "Now" is 00:00 EDT, before either 1am occurrence.
		const now = DateTime.fromISO("2026-11-01T04:00:00.000Z");
		const next = calculateNextSendAtFromTimes([60, 9 * 60], now);

		expect(next).not.toBeNull();
		// `pickLaterOffset` selects the EST repeat (06:00 UTC) over the earlier EDT 1am (05:00 UTC).
		// This is the chosen design: prefer the later offset on ambiguous local times.
		expect(next?.toISO()).toBe("2026-11-01T06:00:00.000Z");
		const parts = formatEtParts(next as DateTime);
		expect(parts.ymd).toBe("2026-11-01");
		expect(parts.hm).toBe("01:00");
	});

	it("Sitting inside the first 1am EDT hour on fall-back day, the next 1am ET candidate advances to the second (EST) occurrence.", () => {
		// "Now" is 01:30 EDT — between the two 1am occurrences.
		const now = DateTime.fromISO("2026-11-01T05:30:00.000Z");
		const next = calculateNextSendAt(60, now); // 01:00 ET

		expect(next).not.toBeNull();
		// The function picks 01:00 EST (06:00 UTC), not the already-passed 01:00 EDT.
		expect(next?.toISO()).toBe("2026-11-01T06:00:00.000Z");
	});
});

describe("A non-DST-aligned user's wall-clock-stable schedule (daily-digest path).", () => {
	// The production recompute path (schedule/persist-user.ts) calls
	// `userLocalToEtMinute(localMinutes, user.timezone)` immediately before
	// `calculateNextSendAt(etMinutes, now)` — so the ET-minute it passes in
	// is whatever 9 AM HST resolves to on the *current* day's ET offset.
	//
	// We intentionally hardcode both branches here (840 in winter, 900 in summer)
	// because `userLocalToEtMinute` reads `DateTime.now()` directly and would
	// make this test depend on the wall-clock the test runner sits on.
	it("A Honolulu user with daily_digest_time=09:00 has next_send_at land at 19:00 UTC both before and after US spring-forward — wall-clock is preserved.", () => {
		// HST is always UTC-10, so 9:00 AM HST = 19:00 UTC every day of the year.
		// In winter (ET = UTC-5), userLocalToEtMinute(540, HI) returns 14:00 ET.
		const beforeNow = DateTime.fromISO("2026-03-07T18:00:00.000Z"); // 08:00 HST Sat
		const beforeNext = calculateNextSendAt(14 * 60, beforeNow);
		expect(beforeNext?.toISO()).toBe("2026-03-07T19:00:00.000Z"); // 9 AM HST

		// In summer (ET = UTC-4), userLocalToEtMinute(540, HI) returns 15:00 ET
		// — different ET-canonical minute, same UTC moment.
		const afterNow = DateTime.fromISO("2026-03-09T18:00:00.000Z"); // 08:00 HST Mon
		const afterNext = calculateNextSendAt(15 * 60, afterNow);
		expect(afterNext?.toISO()).toBe("2026-03-09T19:00:00.000Z"); // 9 AM HST
	});
});

describe("A non-DST-aligned user's ET-canonical schedule (post-extended-hours-migration market times).", () => {
	it("A Honolulu user whose market schedule is stored as 09:30 ET sees next_send_at land 1 hour earlier on their local clock after US spring-forward.", () => {
		// market_scheduled_asset_price_times is ET-canonical (570 = 09:30 ET) post-migration.
		// HST = UTC-10 always. Across US spring-forward, 09:30 ET migrates from EST to EDT,
		// so the persisted UTC moment moves earlier by 1 hour — and the HI user's wall clock
		// shows the alert arriving at 04:30 AM HST in winter, 03:30 AM HST in summer.
		// This is the documented "drift" the DST notification feature warns users about.

		const winterNow = DateTime.fromISO("2026-03-07T05:00:00.000Z"); // before any 9:30 ET that week
		const winterNext = calculateNextSendAt(570, winterNow);
		expect(winterNext?.toISO()).toBe("2026-03-07T14:30:00.000Z"); // 09:30 EST = 04:30 HST
		expect(winterNext?.setZone("Pacific/Honolulu").toFormat("HH:mm")).toBe("04:30");

		const summerNow = DateTime.fromISO("2026-03-09T05:00:00.000Z"); // after spring-forward
		const summerNext = calculateNextSendAt(570, summerNow);
		expect(summerNext?.toISO()).toBe("2026-03-09T13:30:00.000Z"); // 09:30 EDT = 03:30 HST
		expect(summerNext?.setZone("Pacific/Honolulu").toFormat("HH:mm")).toBe("03:30");
	});
});
