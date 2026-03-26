/**
 * Scenario-based tests for daily digest process.
 *
 * Covers real-world cases: user with no assets and no digest options is skipped
 * and next_send_at is advanced; user who disabled email still receives price summary via SMS only.
 */
import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import { processDailyDigestUser } from "../../../src/lib/daily-digest/process";
import { rootLogger } from "../../../src/lib/logging";
import type { UserRecord } from "../../../src/lib/messaging/types";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

// Mock market calendar to avoid real Massive API calls with test keys.
vi.mock("../../../src/lib/time/market-calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

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

	it("User who disabled email but has SMS enabled receives price summary via SMS only.", async () => {
		// Grok content (news/rumors) is email-only by design; with email disabled,
		// SMS contains only tracked asset prices.
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

		const sendEmail = vi.fn(async () => ({ success: true }));
		const smsSender = vi.fn(async () => ({ success: true }));
		const stats = await processDailyDigestUser({
			user: userRow as UserRecord,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			sendEmail,
			getSmsSender: () => ({
				sender: smsSender,
			}),
		});

		expect(stats.skipped).toBe(0);
		expect(stats.emailsSent).toBe(0);
		expect(stats.smsSent).toBe(1);
		expect(stats.emailsFailed).toBe(0);
		expect(stats.smsFailed).toBe(0);
		expect(sendEmail).not.toHaveBeenCalled();
		expect(smsSender).toHaveBeenCalledTimes(1);
	});
});
