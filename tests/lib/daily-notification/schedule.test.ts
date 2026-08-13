import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { calculateDailyNotificationNextSendAtIso } from "../../../src/lib/daily-notification/schedule";

describe("Locked 09:00 ET daily digest next-send", () => {
	it("lands at 09:00 ET on a session weekday regardless of user timezone", () => {
		const now = DateTime.fromISO("2026-08-13T12:00:00.000Z"); // 08:00 EDT Thursday
		const iso = calculateDailyNotificationNextSendAtIso({
			now,
			hasDailyNotification: true,
		});
		expect(iso).toBe("2026-08-13T13:00:00.000Z"); // 09:00 EDT
	});

	it("skips Saturday and Sunday to Monday 09:00 ET", () => {
		const saturdayMorning = DateTime.fromISO("2026-08-15T12:00:00.000Z"); // 08:00 EDT Sat
		const iso = calculateDailyNotificationNextSendAtIso({
			now: saturdayMorning,
			hasDailyNotification: true,
		});
		expect(iso).toBe("2026-08-17T13:00:00.000Z"); // Monday 09:00 EDT
	});

	it("returns null when the human digest is off", () => {
		expect(
			calculateDailyNotificationNextSendAtIso({
				now: DateTime.fromISO("2026-08-13T12:00:00.000Z"),
				hasDailyNotification: false,
			}),
		).toBeNull();
	});
});
