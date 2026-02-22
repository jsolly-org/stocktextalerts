/**
 * Scenario-based tests for the scheduled notification pipeline.
 *
 * Covers real-world user journeys: opt-out propagation, dual-channel delivery,
 * and timezone handling.
 */
import type { APIContext } from "astro";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as InboundPost } from "../../../src/pages/api/messaging/inbound";
import { POST as SchedulePost } from "../../../src/pages/api/schedule";
import { buildSmsInboundRequest } from "../../helpers/request-helpers";
import { createScheduleRequest } from "../../helpers/schedule-request";
import { adminClient } from "../../helpers/test-env";
import { createTestUser, getTestUserPhone } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

const twilioMocks = vi.hoisted(() => ({
	validateRequest: vi.fn(),
}));

vi.mock("twilio", async () => {
	const actual = await vi.importActual<typeof import("twilio")>("twilio");
	const RealTwilio = actual.default;
	const fn = (...args: Parameters<typeof RealTwilio>) => RealTwilio(...args);
	fn.validateRequest = twilioMocks.validateRequest;
	return { default: fn };
});

const marketCalendarMocks = vi.hoisted(() => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../../src/lib/time/market-calendar", async (importOriginal) => {
	const mod =
		await importOriginal<
			typeof import("../../../src/lib/time/market-calendar")
		>();
	return {
		...mod,
		getUsMarketClosureInfoForInstant: (
			dt: Parameters<typeof mod.getUsMarketClosureInfoForInstant>[0],
		) => marketCalendarMocks.getUsMarketClosureInfoForInstant(dt),
	};
});

describe("Scheduled notification scenarios", () => {
	const testCronSecret = "test-cron-secret";

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(DateTime.fromISO("2026-01-12T15:00:00.000Z").toJSDate());
		vi.stubEnv("CRON_SECRET", testCronSecret);
		vi.stubEnv("SMS_TEST_BEHAVIOR", "success");
		vi.stubEnv("SMS_TEST_MESSAGE_SID", "test-sms-sid");
		vi.stubEnv("SCHEDULE_PASS_DELAY_MS", "0");
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		twilioMocks.validateRequest.mockReset();
		marketCalendarMocks.getUsMarketClosureInfoForInstant.mockResolvedValue(
			null,
		);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("User who opted out via STOP does not receive SMS when schedule fires.", async () => {
		twilioMocks.validateRequest.mockReturnValue(true);

		const timezone = "America/New_York";
		const nowLocal = DateTime.now().setZone(timezone);
		const scheduledTime = nowLocal.hour * 60 + nowLocal.minute;

		const testUser = await createTestUser({
			timezone,
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: true,
			phoneVerified: true,
			scheduledUpdateTimes: [scheduledTime],
			trackedAssets: ["AAPL"],
		});
		registerTestUserForCleanup(testUser.id);

		const { error: seedError } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_include_sms: true,
				market_scheduled_asset_price_next_send_at: DateTime.utc().toISO(),
				market_scheduled_asset_price_enabled: true,
			})
			.eq("id", testUser.id);
		expect(seedError).toBeNull();

		const from = await getTestUserPhone(testUser.id);
		const stopResponse = await InboundPost({
			request: buildSmsInboundRequest({
				from,
				body: "STOP",
				includeSignature: true,
			}),
		} as APIContext);
		expect(stopResponse.status).toBe(200);

		const { data: afterStop } = await adminClient
			.from("users")
			.select("sms_opted_out,sms_notifications_enabled")
			.eq("id", testUser.id)
			.single();
		expect(afterStop?.sms_opted_out).toBe(true);
		expect(afterStop?.sms_notifications_enabled).toBe(false);

		const response = await SchedulePost({
			request: createScheduleRequest(testCronSecret),
		} as APIContext);
		expect(response.status).toBe(200);

		const { data: smsLogs, error: smsLogError } = await adminClient
			.from("notification_log")
			.select("*")
			.eq("user_id", testUser.id)
			.eq("type", "market")
			.eq("delivery_method", "sms");
		expect(smsLogError).toBeNull();
		expect(smsLogs).toHaveLength(0);
	});

	it("User with both email and SMS enabled receives both at scheduled time.", async () => {
		vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		vi.stubEnv("TWILIO_PHONE_NUMBER", "+15551234567");

		const timezone = "America/New_York";
		const nowLocal = DateTime.now().setZone(timezone);
		const scheduledTime = nowLocal.hour * 60 + nowLocal.minute;

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: true,
			phoneVerified: true,
			scheduledUpdateTimes: [scheduledTime],
			trackedAssets: ["MSFT"],
			marketScheduledAssetPriceIncludeEmail: true,
			marketScheduledAssetPriceIncludeSms: true,
		});
		registerTestUserForCleanup(id);

		const { error: updateError } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_next_send_at: DateTime.utc().toISO(),
				market_scheduled_asset_price_enabled: true,
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		const response = await SchedulePost({
			request: createScheduleRequest(testCronSecret),
		} as APIContext);
		expect(response.status).toBe(200);

		const { data: emailLogs, error: emailLogError } = await adminClient
			.from("notification_log")
			.select("*")
			.eq("user_id", id)
			.eq("type", "market")
			.eq("delivery_method", "email");
		expect(emailLogError).toBeNull();
		expect(emailLogs).toHaveLength(1);

		const { data: smsLogs, error: smsLogError } = await adminClient
			.from("notification_log")
			.select("*")
			.eq("user_id", id)
			.eq("type", "market")
			.eq("delivery_method", "sms");
		expect(smsLogError).toBeNull();
		expect(smsLogs).toHaveLength(1);
		expect(smsLogs?.[0]?.message_delivered).toBe(true);
	});

	it("User with scheduled times but no tracked assets receives no-assets message and next_send_at advances.", async () => {
		const timezone = "America/New_York";
		const nowLocal = DateTime.now().setZone(timezone);
		const scheduledTime = nowLocal.hour * 60 + nowLocal.minute;

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			scheduledUpdateTimes: [scheduledTime],
			trackedAssets: [],
			marketScheduledAssetPriceIncludeEmail: true,
		});
		registerTestUserForCleanup(id);

		const { error: updateError } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_next_send_at: DateTime.utc().toISO(),
				market_scheduled_asset_price_enabled: true,
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		const { data: before } = await adminClient
			.from("users")
			.select("market_scheduled_asset_price_next_send_at")
			.eq("id", id)
			.single();
		const nextSendAtBefore = before?.market_scheduled_asset_price_next_send_at;
		expect(nextSendAtBefore).toBeTruthy();

		const response = await SchedulePost({
			request: createScheduleRequest(testCronSecret),
		} as APIContext);
		expect(response.status).toBe(200);

		const { data: logs } = await adminClient
			.from("notification_log")
			.select("message,message_delivered")
			.eq("user_id", id)
			.eq("type", "market")
			.eq("delivery_method", "email");
		expect(logs).toHaveLength(1);
		expect(logs?.[0]?.message).toContain("don't have any tracked assets");

		const { data: after } = await adminClient
			.from("users")
			.select("market_scheduled_asset_price_next_send_at")
			.eq("id", id)
			.single();
		expect(after?.market_scheduled_asset_price_next_send_at).not.toBe(
			nextSendAtBefore,
		);
	});

	it("Scheduled market notification is skipped when US market is closed (holiday) and next_send_at advances.", async () => {
		vi.setSystemTime(DateTime.fromISO("2026-01-14T15:00:00.000Z").toJSDate());
		const holidayDate = "2026-01-14";
		marketCalendarMocks.getUsMarketClosureInfoForInstant.mockImplementation(
			async (dt: { toISODate: () => string }) => {
				const dateStr = dt.toISODate?.() ?? "";
				return dateStr === holidayDate
					? { reason: "holiday" as const, holidayName: "Test Holiday" }
					: null;
			},
		);

		const timezone = "America/New_York";
		const nowLocal = DateTime.now().setZone(timezone);
		const scheduledTime = nowLocal.hour * 60 + nowLocal.minute;

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			scheduledUpdateTimes: [scheduledTime],
			trackedAssets: ["AAPL"],
			marketScheduledAssetPriceIncludeEmail: true,
		});
		registerTestUserForCleanup(id);

		const beforeSend = DateTime.utc().toISO();
		const { error: seedError } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_next_send_at: beforeSend,
				market_scheduled_asset_price_enabled: true,
			})
			.eq("id", id);
		expect(seedError).toBeNull();

		const response = await SchedulePost({
			request: createScheduleRequest(testCronSecret),
		} as APIContext);
		expect(response.status).toBe(200);

		const { data: logs } = await adminClient
			.from("notification_log")
			.select("id")
			.eq("user_id", id)
			.eq("type", "market");
		expect(logs ?? []).toHaveLength(0);

		const { data: userAfter } = await adminClient
			.from("users")
			.select("market_scheduled_asset_price_next_send_at")
			.eq("id", id)
			.single();
		expect(userAfter).not.toBeNull();
		expect(userAfter?.market_scheduled_asset_price_next_send_at).not.toBeNull();
		expect(userAfter?.market_scheduled_asset_price_next_send_at).not.toBe(
			beforeSend,
		);
	});

	it("User who texted START and re-enabled SMS in dashboard receives next scheduled notification by SMS.", async () => {
		vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		vi.stubEnv("TWILIO_PHONE_NUMBER", "+15551234567");
		twilioMocks.validateRequest.mockReturnValue(true);

		const timezone = "America/New_York";
		const nowLocal = DateTime.now().setZone(timezone);
		const scheduledTime = nowLocal.hour * 60 + nowLocal.minute;

		const testUser = await createTestUser({
			timezone,
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: true,
			phoneVerified: true,
			scheduledUpdateTimes: [scheduledTime],
			trackedAssets: ["AAPL"],
			smsOptedOut: false,
			marketScheduledAssetPriceIncludeSms: true,
		});
		registerTestUserForCleanup(testUser.id);

		const from = await getTestUserPhone(testUser.id);
		const stopResponse = await InboundPost({
			request: buildSmsInboundRequest({
				from,
				body: "STOP",
				includeSignature: true,
			}),
		} as APIContext);
		expect(stopResponse.status).toBe(200);

		const startResponse = await InboundPost({
			request: buildSmsInboundRequest({
				from,
				body: "START",
				includeSignature: true,
			}),
		} as APIContext);
		expect(startResponse.status).toBe(200);

		const { error: prefError } = await adminClient
			.from("users")
			.update({
				sms_notifications_enabled: true,
				market_scheduled_asset_price_next_send_at: DateTime.utc().toISO(),
				market_scheduled_asset_price_enabled: true,
			})
			.eq("id", testUser.id);
		expect(prefError).toBeNull();

		const response = await SchedulePost({
			request: createScheduleRequest(testCronSecret),
		} as APIContext);
		expect(response.status).toBe(200);

		const { data: smsLogs } = await adminClient
			.from("notification_log")
			.select("*")
			.eq("user_id", testUser.id)
			.eq("type", "market")
			.eq("delivery_method", "sms");
		expect(smsLogs).toHaveLength(1);
		expect(smsLogs?.[0]?.message_delivered).toBe(true);
	});

	it("Pacific timezone user receives scheduled market notification when cron fires at 9 AM their local time.", async () => {
		// 9 AM Pacific (PST) = 17:00 UTC in winter
		vi.setSystemTime(DateTime.fromISO("2026-01-14T17:00:00.000Z").toJSDate());

		const timezone = "America/Los_Angeles";
		const scheduledMinutes = 9 * 60; // 9:00 AM local

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			scheduledUpdateTimes: [scheduledMinutes],
			trackedAssets: ["AAPL"],
			marketScheduledAssetPriceIncludeEmail: true,
		});
		registerTestUserForCleanup(id);

		const { error: updateError } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_next_send_at: DateTime.utc().toISO(),
				market_scheduled_asset_price_enabled: true,
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		const response = await SchedulePost({
			request: createScheduleRequest(testCronSecret),
		} as APIContext);
		expect(response.status).toBe(200);

		const { data: logs } = await adminClient
			.from("notification_log")
			.select("*")
			.eq("user_id", id)
			.eq("type", "market")
			.eq("delivery_method", "email");
		expect(logs).toHaveLength(1);
	});

	it("Two users in different timezones: only the user due at cron fire time receives notification.", async () => {
		// 15:00 UTC = 10:00 AM Eastern, 7:00 AM Pacific (winter)
		vi.setSystemTime(DateTime.fromISO("2026-01-14T15:00:00.000Z").toJSDate());

		const userA = await createTestUser({
			timezone: "America/New_York",
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			scheduledUpdateTimes: [10 * 60],
			trackedAssets: ["AAPL"],
			marketScheduledAssetPriceIncludeEmail: true,
		});
		registerTestUserForCleanup(userA.id);

		const userB = await createTestUser({
			timezone: "America/Los_Angeles",
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			scheduledUpdateTimes: [8 * 60],
			trackedAssets: ["MSFT"],
			marketScheduledAssetPriceIncludeEmail: true,
		});
		registerTestUserForCleanup(userB.id);

		const { error: updateA } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_next_send_at: DateTime.utc().toISO(),
				market_scheduled_asset_price_enabled: true,
			})
			.eq("id", userA.id);
		expect(updateA).toBeNull();

		const eightAmPacificUtc = DateTime.fromISO(
			"2026-01-14T16:00:00.000Z",
		).toISO();
		const { error: updateB } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_next_send_at: eightAmPacificUtc,
				market_scheduled_asset_price_enabled: true,
			})
			.eq("id", userB.id);
		expect(updateB).toBeNull();

		const response = await SchedulePost({
			request: createScheduleRequest(testCronSecret),
		} as APIContext);
		expect(response.status).toBe(200);

		const { data: logsA } = await adminClient
			.from("notification_log")
			.select("id")
			.eq("user_id", userA.id)
			.eq("type", "market");
		expect(logsA).toHaveLength(1);

		const { data: logsB } = await adminClient
			.from("notification_log")
			.select("id")
			.eq("user_id", userB.id)
			.eq("type", "market");
		expect(logsB ?? []).toHaveLength(0);
	});

	it("User who disabled email before schedule fire receives no notification.", async () => {
		const timezone = "America/New_York";
		const nowLocal = DateTime.now().setZone(timezone);
		const scheduledTime = nowLocal.hour * 60 + nowLocal.minute;

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			scheduledUpdateTimes: [scheduledTime],
			trackedAssets: ["AAPL"],
			marketScheduledAssetPriceIncludeEmail: true,
		});
		registerTestUserForCleanup(id);

		const { error: seedError } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_next_send_at: DateTime.utc().toISO(),
				market_scheduled_asset_price_enabled: true,
			})
			.eq("id", id);
		expect(seedError).toBeNull();

		const { error: disableError } = await adminClient
			.from("users")
			.update({ email_notifications_enabled: false })
			.eq("id", id);
		expect(disableError).toBeNull();

		const response = await SchedulePost({
			request: createScheduleRequest(testCronSecret),
		} as APIContext);
		expect(response.status).toBe(200);

		const { data: logs } = await adminClient
			.from("notification_log")
			.select("id")
			.eq("user_id", id)
			.eq("type", "market");
		expect(logs ?? []).toHaveLength(0);
	});

	it("User who disabled market_scheduled_asset_price_enabled does not receive scheduled notification.", async () => {
		const timezone = "America/New_York";
		const nowLocal = DateTime.now().setZone(timezone);
		const scheduledTime = nowLocal.hour * 60 + nowLocal.minute;

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			scheduledUpdateTimes: [scheduledTime],
			trackedAssets: ["AAPL"],
			marketScheduledAssetPriceIncludeEmail: true,
		});
		registerTestUserForCleanup(id);

		const { error: seedError } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_next_send_at: DateTime.utc().toISO(),
				market_scheduled_asset_price_enabled: true,
			})
			.eq("id", id);
		expect(seedError).toBeNull();

		const { error: disableError } = await adminClient
			.from("users")
			.update({ market_scheduled_asset_price_enabled: false })
			.eq("id", id);
		expect(disableError).toBeNull();

		const response = await SchedulePost({
			request: createScheduleRequest(testCronSecret),
		} as APIContext);
		expect(response.status).toBe(200);

		const { data: logs } = await adminClient
			.from("notification_log")
			.select("id")
			.eq("user_id", id)
			.eq("type", "market");
		expect(logs ?? []).toHaveLength(0);
	});
});
