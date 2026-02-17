import type { APIContext } from "astro";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertStagedNotification } from "../../../src/lib/staged-notifications/db";
import type { StagedMarketData } from "../../../src/lib/staged-notifications/types";
import { toIsoOrThrow } from "../../../src/lib/time/format";
import { POST } from "../../../src/pages/api/schedule";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("runScheduledNotifications: staged + fallback pipeline", () => {
	const testCronSecret = "test-cron-secret";

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(DateTime.fromISO("2026-01-12T15:00:00.000Z").toJSDate());
		vi.stubEnv("CRON_SECRET", testCronSecret);
		vi.stubEnv("SMS_TEST_BEHAVIOR", "success");
		vi.stubEnv("SCHEDULE_PASS_DELAY_MS", "0");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("fallback does not process users already delivered by staging (no double-send)", async () => {
		const timezone = "America/New_York";
		const nowLocal = DateTime.now().setZone(timezone);
		const scheduledUpdateTime = nowLocal.hour * 60 + nowLocal.minute;
		const scheduledDate = nowLocal.toISODate() ?? "2026-01-12";

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			scheduledUpdateTimes: [scheduledUpdateTime],
			trackedAssets: ["AAPL"],
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

		const stagedData: StagedMarketData = {
			type: "market",
			scheduledDate,
			scheduledMinutes: scheduledUpdateTime,
			marketOpen: true,
			email: {
				subject: "Staged subject",
				text: "AAPL staged",
				html: "<p>AAPL staged</p>",
			},
			sms: null,
		};

		const scheduledFor = toIsoOrThrow(DateTime.utc(), "scheduledFor");
		const { error: upsertError } = await upsertStagedNotification(adminClient, {
			userId: id,
			notificationType: "market",
			scheduledFor,
			stagedData,
		});
		expect(upsertError).toBeNull();

		const createRequest = () =>
			new Request("http://localhost/api/schedule", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${testCronSecret}`,
				},
			});

		const response = await POST({ request: createRequest() } as APIContext);
		expect(response.status).toBe(200);

		const { data: logs } = await adminClient
			.from("notification_log")
			.select("id")
			.eq("user_id", id)
			.eq("type", "market");

		expect(logs?.length).toBe(1);
	});

	it("fallback still delivers when staging has no rows (staging missing path)", async () => {
		const timezone = "America/New_York";
		const nowLocal = DateTime.now().setZone(timezone);
		const scheduledUpdateTime = nowLocal.hour * 60 + nowLocal.minute;

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			scheduledUpdateTimes: [scheduledUpdateTime],
			trackedAssets: ["AAPL"],
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

		const createRequest = () =>
			new Request("http://localhost/api/schedule", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${testCronSecret}`,
				},
			});

		const response = await POST({ request: createRequest() } as APIContext);
		expect(response.status).toBe(200);

		const { data: logs } = await adminClient
			.from("notification_log")
			.select("id")
			.eq("user_id", id)
			.eq("type", "market");

		expect(logs?.length).toBeGreaterThanOrEqual(1);
	});
});
