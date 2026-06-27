import { describe, expect, it, vi } from "vitest";
import type { UserRecord } from "../../../src/lib/messaging/types";
import { shouldAdvanceScheduledNotificationSchedule } from "../../../src/lib/schedule/delivery-terminal";
import { assertIsoDateString, assertMinuteOfDay } from "../../../src/lib/types";
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
			scheduledMinutes: assertMinuteOfDay(570),
			emailRequired: true,
			smsRequired: false,
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
			user: makeUser({ sms_notifications_enabled: true, phone_verified: true }),
			notificationType: "asset_events",
			scheduledDate: assertIsoDateString("2026-06-07"),
			scheduledMinutes: assertMinuteOfDay(540),
			emailRequired: true,
			smsRequired: true,
		});

		expect(canAdvance).toBe(true);
	});
});
