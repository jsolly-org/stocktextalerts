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
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
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

async function getTestUserPhone(userId: string): Promise<string> {
	const { data: user } = await adminClient
		.from("users")
		.select("phone_country_code,phone_number")
		.eq("id", userId)
		.single();
	if (!user) throw new Error("expected user row");
	return `${user.phone_country_code}${user.phone_number}`;
}

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

	function createScheduleRequest() {
		return new Request("http://localhost/api/schedule", {
			method: "POST",
			headers: { Authorization: `Bearer ${testCronSecret}` },
		});
	}

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
			request: createScheduleRequest(),
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
			request: createScheduleRequest(),
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
			request: createScheduleRequest(),
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
		expect(
			userAfter?.market_scheduled_asset_price_next_send_at !== beforeSend,
		).toBe(true);
	});
});
