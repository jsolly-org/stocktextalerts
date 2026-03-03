/**
 * Scenario-based tests for daily digest process.
 *
 * Covers real-world cases: user with no assets and no digest options is skipped
 * and next_send_at is advanced; user who disabled email still receives digest via SMS only.
 */
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { processDailyDigestUser } from "../../../src/lib/daily-digest/process";
import { rootLogger } from "../../../src/lib/logging";
import type { UserRecord } from "../../../src/lib/messaging/types";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("Daily digest process scenarios", () => {
	it("User with no tracked assets and no digest or asset-events options is skipped and next_send_at is advanced.", async () => {
		const now = DateTime.utc();
		const nowIso = now.toISO();
		expect(nowIso).toBeTruthy();

		const { id } = await createTestUser({
			timezone: "America/New_York",
			trackedAssets: [],
			confirmed: true,
		});
		registerTestUserForCleanup(id);

		// Set daily_digest_time so that after skip, updateUserDailyDigestNextSendAt computes a future next_send_at (9 AM local).
		const nineAmLocalMinutes = 9 * 60;
		const { error: updateError } = await adminClient
			.from("users")
			.update({
				daily_digest_time: nineAmLocalMinutes,
				daily_digest_include_news_email: false,
				daily_digest_include_rumors_email: false,
				asset_events_include_calendar_email: false,
				asset_events_include_calendar_sms: false,
				asset_events_include_ipo_email: false,
				asset_events_include_ipo_sms: false,
				asset_events_include_analyst_email: false,
				asset_events_include_analyst_sms: false,
				asset_events_include_insider_email: false,
				asset_events_include_insider_sms: false,
				daily_digest_next_send_at: nowIso,
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		const { data: userRow, error: selectError } = await adminClient
			.from("users")
			.select("*")
			.eq("id", id)
			.single();
		expect(selectError).toBeNull();
		expect(userRow).not.toBeNull();

		const { data: before } = await adminClient
			.from("users")
			.select("daily_digest_next_send_at")
			.eq("id", id)
			.single();
		const nextSendAtBefore = before?.daily_digest_next_send_at;

		const stats = await processDailyDigestUser({
			user: userRow as UserRecord,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			sendEmail: async () => ({ success: true }),
			getSmsSender: () => ({ sender: "+15555550000" }),
		});

		expect(stats.skipped).toBe(1);
		expect(stats.emailsSent).toBe(0);
		expect(stats.smsSent).toBe(0);

		const { data: after } = await adminClient
			.from("users")
			.select("daily_digest_next_send_at")
			.eq("id", id)
			.single();
		expect(after?.daily_digest_next_send_at).not.toBeNull();
		expect(after?.daily_digest_next_send_at).not.toBe(nextSendAtBefore);
	});

	it("User who disabled email but has SMS enabled receives daily digest via SMS only.", async () => {
		const now = DateTime.utc();
		const nowIso = now.toISO();
		expect(nowIso).toBeTruthy();

		const { id } = await createTestUser({
			timezone: "America/New_York",
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: true,
			phoneVerified: true,
			trackedAssets: ["AAPL"],
			confirmed: true,
		});
		registerTestUserForCleanup(id);

		const nineAmLocalMinutes = 9 * 60;
		const { error: updateError } = await adminClient
			.from("users")
			.update({
				daily_digest_time: nineAmLocalMinutes,
				daily_digest_include_news_email: false,
				daily_digest_include_rumors_email: true,
				asset_events_include_calendar_email: false,
				asset_events_include_calendar_sms: false,
				asset_events_include_ipo_email: false,
				asset_events_include_ipo_sms: false,
				asset_events_include_analyst_email: false,
				asset_events_include_analyst_sms: false,
				asset_events_include_insider_email: false,
				asset_events_include_insider_sms: false,
				daily_digest_next_send_at: nowIso,
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		const { data: userRow, error: selectError } = await adminClient
			.from("users")
			.select("*")
			.eq("id", id)
			.single();
		expect(selectError).toBeNull();
		expect(userRow).not.toBeNull();

		const stats = await processDailyDigestUser({
			user: userRow as UserRecord,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			sendEmail: async () => ({ success: true }),
			getSmsSender: () => ({
				sender: async () => ({ success: true }),
			}),
		});

		expect(stats.skipped).toBe(0);
		expect(stats.emailsSent).toBe(0);
		expect(stats.smsSent).toBe(1);
	});
});
