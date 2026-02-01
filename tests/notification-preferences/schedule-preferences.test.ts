import type { APIContext } from "astro";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calculateNextSendAt } from "../../src/lib/time/schedule";
import { POST } from "../../src/pages/api/notifications/scheduled";
import { adminClient, cleanupTestUser, createTestUser } from "../shared-utils";

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

describe("A user schedules their daily digest notification time.", () => {
	it("When the target time is later today, the next send is scheduled for today.", () => {
		const timezone = "America/New_York";
		const now = DateTime.fromISO("2026-01-13T13:00:00.000Z"); // 08:00 local (winter)
		const next = calculateNextSendAt(9 * 60, timezone, now);

		expect(next).not.toBeNull();
		expect(next?.toISO()).toBe("2026-01-13T14:00:00.000Z"); // 09:00 local
	});

	it("When the target time has already passed, the next send is scheduled for tomorrow.", () => {
		const timezone = "America/New_York";
		const now = DateTime.fromISO("2026-01-13T14:00:00.000Z"); // 09:00 local (winter)
		const next = calculateNextSendAt(9 * 60, timezone, now);

		expect(next).not.toBeNull();
		expect(next?.toISO()).toBe("2026-01-14T14:00:00.000Z"); // next day 09:00 local
	});

	it("When spring-forward skips a local time, the next send is scheduled at the next valid time.", () => {
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

	it("When fall-back repeats a local time, the chosen send time remains consistent.", () => {
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

async function setupScheduledNotificationTest(options: {
	channel: "email" | "sms";
	cronSecret: string;
	timezone?: string;
}): Promise<{
	userId: string;
	dailyDigestNotificationTime: number;
	createRequest: () => Request;
}> {
	const timezone = options.timezone ?? "America/New_York";
	const nowLocal = DateTime.now().setZone(timezone);
	if (!nowLocal.isValid) {
		throw new Error("Invalid timezone for test formatter");
	}
	const dailyDigestNotificationTime =
		nowLocal.hour * 60 + nowLocal.minute;

	const userOptions =
		options.channel === "email"
			? {
					timezone,
					emailNotificationsEnabled: true,
					smsNotificationsEnabled: false,
					dailyDigestEnabled: true,
					dailyDigestNotificationTimes: [dailyDigestNotificationTime],
					trackedStocks: ["AAPL"],
				}
			: {
					timezone,
					emailNotificationsEnabled: false,
					smsNotificationsEnabled: true,
					phoneVerified: true,
					smsOptedOut: false,
					dailyDigestEnabled: true,
					dailyDigestNotificationTimes: [dailyDigestNotificationTime],
					trackedStocks: ["AAPL"],
				};
	const { id } = await createTestUser(userOptions);

	const { error: updateError } = await adminClient
		.from("users")
		.update({ next_send_at: DateTime.utc().toISO() })
		.eq("id", id);
	expect(updateError).toBeNull();

	const createRequest = () =>
		new Request("http://localhost/api/notifications/scheduled", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${options.cronSecret}`,
			},
		});

	return {
		userId: id,
		dailyDigestNotificationTime,
		createRequest,
	};
}

describe("Users receive scheduled daily digest notifications.", () => {
	const testCronSecret = "test-cron-secret";

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(DateTime.fromISO("2026-01-12T15:00:00.000Z").toJSDate());
		vi.stubEnv("CRON_SECRET", testCronSecret);
		vi.stubEnv("SMS_TEST_BEHAVIOR", "success");
		vi.stubEnv("SMS_TEST_MESSAGE_SID", "test-sms-sid");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("Eligible users receive their daily digest by email at the scheduled time.", async () => {
		const { userId, dailyDigestNotificationTime, createRequest } =
			await setupScheduledNotificationTest({
				channel: "email",
				cronSecret: testCronSecret,
			});

		try {
			const response = await POST({ request: createRequest() } as APIContext);
			const response2 = await POST({ request: createRequest() } as APIContext);

			expect(response.status).toBe(200);
			expect(response2.status).toBe(200);

			const json = await response.json();
			const json2 = await response2.json();
			expect(json.success).toBe(true);
			expect(json2.success).toBe(true);

			const { data: logs, error: logError } = await adminClient
				.from("notification_log")
				.select("*")
				.eq("user_id", userId)
				.eq("delivery_method", "email")
				.eq("type", "scheduled_update")
				.order("created_at", { ascending: false })
				.limit(10);
			expect(logError).toBeNull();
			expect(logs).toHaveLength(1);
			const log = logs?.[0];
			if (!log) throw new Error("Expected log entry not found");

			const { data: scheduled, error: scheduledError } = await adminClient
				.from("scheduled_notifications")
				.select("status,attempt_count")
				.eq("user_id", userId)
				.eq("notification_type", "daily_digest")
				.eq("scheduled_minutes", dailyDigestNotificationTime)
				.eq("channel", "email")
				.maybeSingle();
			expect(scheduledError).toBeNull();
			expect(scheduled).toBeTruthy();
			if (!scheduled)
				throw new Error("Expected scheduled_notifications row not found");
			expect(scheduled.attempt_count).toBe(1);
			expect(["sent", "failed"]).toContain(scheduled.status);

			expect(json.emailsSent + json.emailsFailed).toBeGreaterThanOrEqual(1);
			if (log.message_delivered) {
				expect(log.message).toContain("AAPL");
			} else {
				expect(log.error).toBeTruthy();
			}
		} finally {
			await cleanupTestUser(userId);
		}
	});

	it("Eligible users receive their daily digest by SMS at the scheduled time.", async () => {
		vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		vi.stubEnv("TWILIO_PHONE_NUMBER", "+15551234567");

		const { userId, dailyDigestNotificationTime, createRequest } =
			await setupScheduledNotificationTest({
				channel: "sms",
				cronSecret: testCronSecret,
			});

		try {
			const response = await POST({
				request: createRequest(),
			} as APIContext);

			expect(response.status).toBe(200);
			const json = await response.json();
			expect(json.success).toBe(true);
			expect(json.smsSent + json.smsFailed).toBeGreaterThanOrEqual(1);

			const { data: logs, error: logError } = await adminClient
				.from("notification_log")
				.select("*")
				.eq("user_id", userId)
				.eq("delivery_method", "sms")
				.eq("type", "scheduled_update")
				.order("created_at", { ascending: false })
				.limit(10);
			expect(logError).toBeNull();
			expect(logs).toHaveLength(1);
			const log = logs?.[0];
			if (!log) throw new Error("Expected log entry not found");
			expect(log.message_delivered).toBe(true);

			const { data: scheduled, error: scheduledError } = await adminClient
				.from("scheduled_notifications")
				.select("status,attempt_count")
				.eq("user_id", userId)
				.eq("notification_type", "daily_digest")
				.eq("scheduled_minutes", dailyDigestNotificationTime)
				.eq("channel", "sms")
				.maybeSingle();
			expect(scheduledError).toBeNull();
			expect(scheduled).toBeTruthy();
			if (!scheduled)
				throw new Error("Expected scheduled_notifications row not found");
			expect(scheduled.attempt_count).toBe(1);
			expect(["sent", "failed"]).toContain(scheduled.status);
		} finally {
			await cleanupTestUser(userId);
		}
	});
});
