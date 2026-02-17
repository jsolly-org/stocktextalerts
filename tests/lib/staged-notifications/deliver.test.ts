/**
 * Vitest tests for the staged notification delivery pipeline (deliver.ts).
 *
 * Covers: due staged rows delivery, idempotency when already claimed,
 * deliveredUserTypes bookkeeping, and empty-result when no rows are due.
 */
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../../src/lib/logging";
import { upsertStagedNotification } from "../../../src/lib/staged-notifications/db";
import { deliverStagedNotifications } from "../../../src/lib/staged-notifications/deliver";
import type { StagedMarketData } from "../../../src/lib/staged-notifications/types";
import { toIsoOrThrow } from "../../../src/lib/time/format";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("deliverStagedNotifications", () => {
	const logger = createLogger({ path: "staged-deliver-test" });

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(DateTime.fromISO("2026-01-15T15:00:00.000Z").toJSDate());
		vi.stubEnv("SMS_TEST_BEHAVIOR", "success");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("delivers due staged market rows and returns deliveredUserTypes", async () => {
		const timezone = "America/New_York";
		const nowLocal = DateTime.now().setZone(timezone);
		const scheduledMinutes = nowLocal.hour * 60 + nowLocal.minute;
		const scheduledDate = nowLocal.toISODate() ?? "2026-01-15";

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			scheduledUpdateTimes: [scheduledMinutes],
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
			scheduledMinutes,
			marketOpen: true,
			email: {
				subject: "Test staged subject",
				text: "AAPL staged content",
				html: "<p>AAPL staged content</p>",
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

		const { createEmailSender } = await import(
			"../../../src/lib/messaging/email/utils"
		);
		const { createSmsSenderProvider } = await import(
			"../../../src/lib/schedule/sms-sender"
		);

		const result = await deliverStagedNotifications({
			supabase: adminClient,
			logger,
			currentTime: DateTime.utc(),
			sendEmail: createEmailSender(),
			getSmsSender: createSmsSenderProvider(),
		});

		expect(result.stats.emailsSent).toBeGreaterThanOrEqual(1);
		expect(result.deliveredUserTypes.has(`${id}:market`)).toBe(true);

		const { data: logs } = await adminClient
			.from("notification_log")
			.select("id")
			.eq("user_id", id)
			.eq("type", "market");
		expect(logs?.length).toBeGreaterThanOrEqual(1);
	});

	it("skips second attempt when notification already claimed and adds to deliveredUserTypes", async () => {
		const timezone = "America/New_York";
		const nowLocal = DateTime.now().setZone(timezone);
		const scheduledMinutes = nowLocal.hour * 60 + nowLocal.minute;
		const scheduledDate = nowLocal.toISODate() ?? "2026-01-15";

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			scheduledUpdateTimes: [scheduledMinutes],
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

		const scheduledFor = toIsoOrThrow(DateTime.utc(), "scheduledFor");
		const stagedData: StagedMarketData = {
			type: "market",
			scheduledDate,
			scheduledMinutes,
			marketOpen: true,
			email: {
				subject: "Idempotency test",
				text: "Content",
				html: "<p>Content</p>",
			},
			sms: null,
		};

		const { error: upsertError } = await upsertStagedNotification(adminClient, {
			userId: id,
			notificationType: "market",
			scheduledFor,
			stagedData,
		});
		expect(upsertError).toBeNull();

		const { error: insertSnError } = await adminClient
			.from("scheduled_notifications")
			.upsert(
				{
					user_id: id,
					notification_type: "market",
					scheduled_date: scheduledDate,
					scheduled_minutes: scheduledMinutes,
					channel: "email",
					status: "sent",
					attempt_count: 1,
					last_attempt_at: new Date().toISOString(),
					error: null,
				},
				{
					onConflict:
						"user_id,notification_type,scheduled_date,scheduled_minutes,channel",
				},
			);
		expect(insertSnError).toBeNull();

		const { createEmailSender } = await import(
			"../../../src/lib/messaging/email/utils"
		);
		const { createSmsSenderProvider } = await import(
			"../../../src/lib/schedule/sms-sender"
		);

		const result = await deliverStagedNotifications({
			supabase: adminClient,
			logger,
			currentTime: DateTime.utc(),
			sendEmail: createEmailSender(),
			getSmsSender: createSmsSenderProvider(),
		});

		expect(result.deliveredUserTypes.has(`${id}:market`)).toBe(true);
		expect(result.stats.skipped).toBeGreaterThanOrEqual(1);
	});

	it("returns empty deliveredUserTypes when no staged rows are due", async () => {
		const { createEmailSender } = await import(
			"../../../src/lib/messaging/email/utils"
		);
		const { createSmsSenderProvider } = await import(
			"../../../src/lib/schedule/sms-sender"
		);

		const result = await deliverStagedNotifications({
			supabase: adminClient,
			logger,
			currentTime: DateTime.utc(),
			sendEmail: createEmailSender(),
			getSmsSender: createSmsSenderProvider(),
		});

		expect(result.deliveredUserTypes.size).toBe(0);
		expect(result.stats.emailsSent).toBe(0);
		expect(result.stats.smsSent).toBe(0);
	});
});
