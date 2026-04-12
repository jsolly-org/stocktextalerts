/**
 * Vitest tests for the staged notification delivery pipeline (deliver.ts).
 *
 * Covers: due staged rows delivery, idempotency when already claimed,
 * deliveredUserTypes bookkeeping, and empty-result when no rows are due.
 */
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/time/market-calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

import { createLogger } from "../../../src/lib/logging";
import {
	createEmailSender,
	type EmailSender,
} from "../../../src/lib/messaging/email/utils";
import {
	createSmsSenderProvider,
	type SmsSenderProvider,
} from "../../../src/lib/schedule/sms-sender";
import { upsertStagedNotification } from "../../../src/lib/staged-notifications/db";
import { deliverStagedNotifications } from "../../../src/lib/staged-notifications/deliver";
import type { StagedMarketData } from "../../../src/lib/staged-notifications/types";
import { toIsoOrThrow } from "../../../src/lib/time/format";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("deliverStagedNotifications", () => {
	const logger = createLogger({ path: "staged-deliver-test" });
	let sendEmail: EmailSender;
	let getSmsSender: SmsSenderProvider;

	// Fake timers are skipped when live email routing is on. nodemailer's
	// SMTP client uses setTimeout internally for connect timeouts and
	// rate limiting, and `vi.useFakeTimers()` freezes setTimeout — the
	// SMTP handshake never fires, and the test deadlocks. Previously this
	// gate was keyed on the (now-removed) live SES path; it's the same
	// fix for a different reason.
	const useFakeTimers = !process.env.EMAIL_SMTP_HOST;

	beforeEach(() => {
		if (useFakeTimers) {
			vi.useFakeTimers();
			vi.setSystemTime(DateTime.fromISO("2026-01-15T15:00:00.000Z").toJSDate());
		}
		vi.stubEnv("SMS_TEST_BEHAVIOR", "success");

		sendEmail = createEmailSender();
		getSmsSender = createSmsSenderProvider();
	});

	afterEach(() => {
		if (useFakeTimers) {
			vi.useRealTimers();
		}
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

		const result = await deliverStagedNotifications({
			supabase: adminClient,
			logger,
			currentTime: DateTime.utc(),
			sendEmail,
			getSmsSender,
		});

		expect(result.stats.emailsSent).toBe(1);
		expect(result.deliveredUserTypes.has(`${id}:market`)).toBe(true);

		const { data: logs } = await adminClient
			.from("notification_log")
			.select("id")
			.eq("user_id", id)
			.eq("type", "market");
		expect(logs?.length).toBe(1);
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

		const result = await deliverStagedNotifications({
			supabase: adminClient,
			logger,
			currentTime: DateTime.utc(),
			sendEmail,
			getSmsSender,
		});

		expect(result.deliveredUserTypes.has(`${id}:market`)).toBe(true);
		expect(result.stats.skipped).toBe(1);
	});

	it("User who opted out via STOP after notification was pre-staged does not receive SMS when deliver runs.", async () => {
		const timezone = "America/New_York";
		const nowLocal = DateTime.now().setZone(timezone);
		const scheduledMinutes = nowLocal.hour * 60 + nowLocal.minute;
		const scheduledDate = nowLocal.toISODate() ?? "2026-01-15";

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: true,
			phoneVerified: true,
			scheduledUpdateTimes: [scheduledMinutes],
			trackedAssets: ["AAPL"],
		});
		registerTestUserForCleanup(id);

		const { error: updateError } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_next_send_at: DateTime.utc().toISO(),
				market_scheduled_asset_price_enabled: true,
				market_scheduled_asset_price_include_sms: true,
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		const stagedData: StagedMarketData = {
			type: "market",
			scheduledDate,
			scheduledMinutes,
			marketOpen: true,
			email: null,
			sms: {
				message: "AAPL: $187.42 pre-staged content",
			},
		};

		const scheduledFor = toIsoOrThrow(DateTime.utc(), "scheduledFor");
		const { error: upsertError } = await upsertStagedNotification(adminClient, {
			userId: id,
			notificationType: "market",
			scheduledFor,
			stagedData,
		});
		expect(upsertError).toBeNull();

		const { error: optOutError } = await adminClient
			.from("users")
			.update({
				sms_opted_out: true,
				sms_notifications_enabled: false,
			})
			.eq("id", id);
		expect(optOutError).toBeNull();

		const result = await deliverStagedNotifications({
			supabase: adminClient,
			logger,
			currentTime: DateTime.utc(),
			sendEmail,
			getSmsSender,
		});

		expect(result.stats.smsSent).toBe(0);
		expect(result.stats.emailsSent).toBe(0);

		const { data: smsLogs } = await adminClient
			.from("notification_log")
			.select("id")
			.eq("user_id", id)
			.eq("type", "market")
			.eq("delivery_method", "sms");
		expect(smsLogs ?? []).toHaveLength(0);
	});

	it("returns empty deliveredUserTypes when no staged rows are due", async () => {
		// Explicitly clear staged rows to avoid depending on cleanup order from prior tests.
		const { data: stagedRows } = await adminClient
			.from("staged_notifications")
			.select("id");
		if (stagedRows && stagedRows.length > 0) {
			await adminClient
				.from("staged_notifications")
				.delete()
				.in(
					"id",
					stagedRows.map((r) => r.id),
				);
		}

		const result = await deliverStagedNotifications({
			supabase: adminClient,
			logger,
			currentTime: DateTime.utc(),
			sendEmail,
			getSmsSender,
		});

		expect(result.deliveredUserTypes.size).toBe(0);
		expect(result.stats.emailsSent).toBe(0);
		expect(result.stats.smsSent).toBe(0);
	});
});
