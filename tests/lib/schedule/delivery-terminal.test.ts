import { describe, expect, it, vi } from "vitest";
import { shouldAdvanceScheduledNotificationSchedule } from "../../../src/lib/schedule/delivery-terminal";
import type { UserRecord } from "../../../src/lib/types";
import { assertIsoDateString } from "../../../src/lib/types";
import { minuteOfDay } from "../../helpers/minute-of-day";
import { makeUserRecord } from "../../helpers/user-record-fixture";

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
	return makeUserRecord(overrides);
}

describe("shouldAdvanceScheduledNotificationSchedule", () => {
	it("does not advance when a required email channel failed with retries remaining", async () => {
		const supabase = {
			from: vi.fn(() => ({
				select: vi.fn(() => ({
					eq: vi.fn().mockReturnThis(),
					maybeSingle: vi.fn(async () => ({
						data: { status: "failed", attempt_count: 1 },
						error: null,
					})),
				})),
			})),
		} as never;

		const canAdvance = await shouldAdvanceScheduledNotificationSchedule({
			supabase,
			user: makeUser(),
			notificationType: "market",
			scheduledDate: assertIsoDateString("2026-06-07"),
			scheduledMinutes: minuteOfDay(570),
			emailRequired: true,
		});

		expect(canAdvance).toBe(false);
	});

	it("advances when required channels are sent", async () => {
		const supabase = {
			from: vi.fn(() => ({
				select: vi.fn(() => ({
					eq: vi.fn().mockReturnThis(),
					maybeSingle: vi.fn(async () => ({
						data: { status: "sent", attempt_count: 1 },
						error: null,
					})),
				})),
			})),
		} as never;

		const canAdvance = await shouldAdvanceScheduledNotificationSchedule({
			supabase,
			user: makeUser(),
			notificationType: "asset_events",
			scheduledDate: assertIsoDateString("2026-06-07"),
			scheduledMinutes: minuteOfDay(540),
			emailRequired: true,
		});

		expect(canAdvance).toBe(true);
	});
});
