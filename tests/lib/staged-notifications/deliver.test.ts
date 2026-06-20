/**
 * Vitest tests for the staged notification delivery pipeline (deliver.ts).
 *
 * Covers: empty-result when no rows are due. Daily-digest staging delivery is
 * exercised via the daily-digest integration tests; market-type staging was
 * removed when scheduled-market delivery moved fully inline.
 */
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/time/market-calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

import type { Logger } from "../../../src/lib/logging";
import {
	buildDelayBannerText,
	prependDelayBannerToSms,
} from "../../../src/lib/messaging/delay-banner";
import { createEmailSender, type EmailSender } from "../../../src/lib/messaging/email/utils";
import { findUrls, urlStraddlesBoundary } from "../../../src/lib/messaging/sms/segment-utils";
import type { SmsSender } from "../../../src/lib/messaging/sms/twilio-utils";
import {
	createSmsSenderProvider,
	type SmsSenderProvider,
} from "../../../src/lib/schedule/sms-sender";
import { deliverStagedNotifications } from "../../../src/lib/staged-notifications/deliver";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("deliverStagedNotifications", () => {
	const logger: Logger = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};
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
		vi.clearAllMocks();

		sendEmail = createEmailSender();
		getSmsSender = createSmsSenderProvider();
	});

	afterEach(() => {
		if (useFakeTimers) {
			vi.useRealTimers();
		}
		vi.unstubAllEnvs();
	});

	async function clearStagedNotifications() {
		const { data: stagedRows } = await adminClient.from("staged_notifications").select("id");
		if (stagedRows && stagedRows.length > 0) {
			await adminClient
				.from("staged_notifications")
				.delete()
				.in(
					"id",
					stagedRows.map((r) => r.id),
				);
		}
	}

	async function createSmsDigestUser(options: {
		scheduledForIso: string;
		scheduledMinutes?: number;
	}) {
		const { id } = await createTestUser({
			timezone: "America/New_York",
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: true,
			phoneVerified: true,
			confirmed: true,
		});
		registerTestUserForCleanup(id);

		const { error } = await adminClient
			.from("users")
			.update({
				daily_digest_time: options.scheduledMinutes ?? 9 * 60,
				daily_digest_next_send_at: options.scheduledForIso,
			})
			.eq("id", id);
		expect(error).toBeNull();
		// daily_digest prices sms is on by default (createTestUser seeds the catalog),
		// and staged delivery gates on the staged row + channel eligibility, not the facet.
		return id;
	}

	async function insertStagedDailySms(options: {
		userId: string;
		scheduledForIso: string;
		scheduledDate?: string;
		scheduledMinutes?: number;
		sms: { messages: string[] } | { message: string };
	}) {
		const { error } = await adminClient.from("staged_notifications").insert({
			user_id: options.userId,
			notification_type: "daily",
			scheduled_for: options.scheduledForIso,
			staged_data: {
				type: "daily",
				scheduledDate: options.scheduledDate ?? "2026-06-01",
				scheduledMinutes: options.scheduledMinutes ?? 9 * 60,
				email: null,
				sms: options.sms,
				grokAllowed: false,
				hasAnyAssetEventsOption: false,
				shouldUpdateAnalyst: false,
				analystMonth: null,
			},
		});
		expect(error).toBeNull();
	}

	function buildMessageWithUrlStraddlingAfterDelay(options: {
		scheduledFor: DateTime;
		currentTime: DateTime;
	}) {
		const header = "StockTextAlerts — Your daily digest 🗓️";
		const url = "http://localhost/dashboard";
		const prefix = `${header}\n\n`;
		const banner = buildDelayBannerText({
			scheduledFor: options.scheduledFor,
			now: options.currentTime,
			userTimezone: "America/New_York",
			use24Hour: false,
		});
		if (!banner) throw new Error("Expected delayed banner text");
		const urlPrefix = "Manage your notifications: ";

		for (let fillerLength = 0; fillerLength < 200; fillerLength++) {
			const message = `${prefix}${"A".repeat(fillerLength)}\n${urlPrefix}${url}`;
			const delayed = prependDelayBannerToSms(message, banner);
			const span = findUrls(delayed)[0];
			if (span && urlStraddlesBoundary(span.start, span.end)) {
				return message;
			}
		}

		throw new Error("Failed to build URL boundary fixture");
	}

	it("returns empty deliveredUserTypes when no staged rows are due", async () => {
		// Explicitly clear staged rows to avoid depending on cleanup order from prior tests.
		await clearStagedNotifications();

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

	it("sends staged daily digest SMS bodies in order as one successful attempt", async () => {
		await clearStagedNotifications();
		const currentTime = DateTime.fromISO("2026-06-01T13:00:00.000Z", { zone: "utc" });
		const scheduledForIso = currentTime.toISO();
		if (!scheduledForIso) throw new Error("Expected valid scheduled_for timestamp");
		const userId = await createSmsDigestUser({ scheduledForIso });
		const messages = [
			"StockTextAlerts — Your daily digest 🗓️\n\nFirst staged body",
			"Second staged body",
			"Final staged body",
		];
		await insertStagedDailySms({ userId, scheduledForIso, sms: { messages } });
		const smsSender = vi.fn<SmsSender>(async () => ({ success: true }));

		const result = await deliverStagedNotifications({
			supabase: adminClient,
			logger,
			currentTime,
			sendEmail,
			getSmsSender: () => ({ sender: smsSender }),
		});

		expect(smsSender).toHaveBeenCalledTimes(messages.length);
		expect(smsSender.mock.calls.map(([request]) => request.body)).toEqual(messages);
		expect(result.stats.smsSent).toBe(1);
		expect(result.stats.smsFailed).toBe(0);

		const { data: logRows } = await adminClient
			.from("notification_log")
			.select("message,message_delivered")
			.eq("user_id", userId)
			.eq("delivery_method", "sms");
		expect(logRows).toHaveLength(1);
		expect(logRows?.[0]?.message_delivered).toBe(true);
		expect(logRows?.[0]?.message).toContain("--- SMS part 1/3 ---");
		expect(logRows?.[0]?.message).toContain("--- SMS part 3/3 ---");

		const { data: scheduledRow } = await adminClient
			.from("scheduled_notifications")
			.select("status")
			.eq("user_id", userId)
			.eq("notification_type", "daily")
			.eq("scheduled_date", "2026-06-01")
			.eq("scheduled_minutes", 9 * 60)
			.eq("channel", "sms")
			.single();
		expect(scheduledRow?.status).toBe("sent");
	});

	it("stops staged daily digest SMS delivery after a later part fails", async () => {
		await clearStagedNotifications();
		const currentTime = DateTime.fromISO("2026-06-01T13:00:00.000Z", { zone: "utc" });
		const scheduledForIso = currentTime.toISO();
		if (!scheduledForIso) throw new Error("Expected valid scheduled_for timestamp");
		const userId = await createSmsDigestUser({ scheduledForIso });
		const messages = [
			"StockTextAlerts — Your daily digest 🗓️\n\nFirst staged body",
			"Second staged body",
			"Final staged body",
		];
		await insertStagedDailySms({ userId, scheduledForIso, sms: { messages } });
		const smsSender = vi
			.fn<SmsSender>()
			.mockResolvedValueOnce({ success: true })
			.mockResolvedValueOnce({
				success: false,
				error: "Twilio timeout",
				errorCode: "ETIMEDOUT",
			});

		const result = await deliverStagedNotifications({
			supabase: adminClient,
			logger,
			currentTime,
			sendEmail,
			getSmsSender: () => ({ sender: smsSender }),
		});

		expect(smsSender).toHaveBeenCalledTimes(2);
		expect(result.stats.smsSent).toBe(0);
		expect(result.stats.smsFailed).toBe(1);

		const { data: logRows } = await adminClient
			.from("notification_log")
			.select("message,message_delivered,error,error_code")
			.eq("user_id", userId)
			.eq("delivery_method", "sms");
		expect(logRows).toHaveLength(1);
		expect(logRows?.[0]).toMatchObject({
			message_delivered: false,
			error_code: "ETIMEDOUT",
		});
		expect(logRows?.[0]?.message).toContain("--- SMS part 1/3 ---");
		expect(logRows?.[0]?.message).toContain("--- SMS part 3/3 ---");
		expect(logRows?.[0]?.error).toContain("SMS part 2/3");
		expect(logRows?.[0]?.error).toContain("Twilio timeout");

		const { data: scheduledRow } = await adminClient
			.from("scheduled_notifications")
			.select("status,error")
			.eq("user_id", userId)
			.eq("notification_type", "daily")
			.eq("scheduled_date", "2026-06-01")
			.eq("scheduled_minutes", 9 * 60)
			.eq("channel", "sms")
			.single();
		expect(scheduledRow?.status).toBe("failed");
		expect(scheduledRow?.error).toContain("SMS part 2/3");
		expect(scheduledRow?.error).toContain("Twilio timeout");
	});

	it("adds a late delay banner only to the first staged SMS body", async () => {
		await clearStagedNotifications();
		const scheduledFor = DateTime.fromISO("2026-06-01T13:00:00.000Z", { zone: "utc" });
		const currentTime = scheduledFor.plus({ minutes: 12 });
		const scheduledForIso = scheduledFor.toISO();
		if (!scheduledForIso) throw new Error("Expected valid scheduled_for timestamp");
		const userId = await createSmsDigestUser({ scheduledForIso });
		const messages = [
			"StockTextAlerts — Your daily digest 🗓️\n\nFirst staged body",
			"Second staged body",
			"Final staged body",
		];
		await insertStagedDailySms({ userId, scheduledForIso, sms: { messages } });
		const smsSender = vi.fn<SmsSender>(async () => ({ success: true }));

		await deliverStagedNotifications({
			supabase: adminClient,
			logger,
			currentTime,
			sendEmail,
			getSmsSender: () => ({ sender: smsSender }),
		});

		expect(smsSender).toHaveBeenCalledTimes(messages.length);
		const sentBodies = smsSender.mock.calls.map(([request]) => request.body);
		expect(sentBodies[0]).toContain("Delayed");
		expect(sentBodies[0]).toContain("First staged body");
		expect(sentBodies[1]).toBe(messages[1]);
		expect(sentBodies[2]).toBe(messages[2]);
	});

	it("repads a delayed one-part staged SMS when the dashboard URL shifts near a segment boundary", async () => {
		await clearStagedNotifications();
		const scheduledFor = DateTime.fromISO("2026-06-01T13:00:00.000Z", { zone: "utc" });
		const currentTime = scheduledFor.plus({ minutes: 12 });
		const scheduledForIso = scheduledFor.toISO();
		if (!scheduledForIso) throw new Error("Expected valid scheduled_for timestamp");
		const userId = await createSmsDigestUser({ scheduledForIso });
		const message = buildMessageWithUrlStraddlingAfterDelay({ scheduledFor, currentTime });
		const smsSender = vi.fn<SmsSender>(async () => ({ success: true }));
		await insertStagedDailySms({ userId, scheduledForIso, sms: { messages: [message] } });

		await deliverStagedNotifications({
			supabase: adminClient,
			logger,
			currentTime,
			sendEmail,
			getSmsSender: () => ({ sender: smsSender }),
		});

		expect(smsSender).toHaveBeenCalledTimes(1);
		const sentBody = smsSender.mock.calls[0]?.[0].body ?? "";
		const span = findUrls(sentBody)[0];
		expect(span).toBeDefined();
		expect(urlStraddlesBoundary(span?.start ?? -1, span?.end ?? -1)).toBe(false);
	});

	it("delivers an old-shape staged SMS row with one message", async () => {
		await clearStagedNotifications();
		const currentTime = DateTime.fromISO("2026-06-01T13:00:00.000Z", { zone: "utc" });
		const scheduledForIso = currentTime.toISO();
		if (!scheduledForIso) throw new Error("Expected valid scheduled_for timestamp");
		const userId = await createSmsDigestUser({ scheduledForIso });
		const message = "StockTextAlerts — Your daily digest 🗓️\n\nLegacy staged body";
		const smsSender = vi.fn<SmsSender>(async () => ({ success: true }));
		await insertStagedDailySms({ userId, scheduledForIso, sms: { message } });

		const result = await deliverStagedNotifications({
			supabase: adminClient,
			logger,
			currentTime,
			sendEmail,
			getSmsSender: () => ({ sender: smsSender }),
		});

		expect(smsSender).toHaveBeenCalledOnce();
		expect(smsSender.mock.calls[0]?.[0].body).toBe(message);
		expect(result.stats.smsSent).toBe(1);
		expect(result.stats.smsFailed).toBe(0);
	});

	it("keeps delayed staged SMS bodies within Twilio's hard character limit", async () => {
		await clearStagedNotifications();
		const scheduledFor = DateTime.fromISO("2026-06-01T13:00:00.000Z", { zone: "utc" });
		const currentTime = scheduledFor.plus({ minutes: 12 });
		const scheduledForIso = scheduledFor.toISO();
		if (!scheduledForIso) throw new Error("Expected valid scheduled_for timestamp");
		const userId = await createSmsDigestUser({ scheduledForIso });
		const nearLimitBody = `StockTextAlerts — Your daily digest 🗓️\n\n${"A".repeat(1538)}`;
		expect(nearLimitBody.length).toBeLessThanOrEqual(1600);
		const smsSender = vi.fn<SmsSender>(async () => ({ success: true }));
		await insertStagedDailySms({
			userId,
			scheduledForIso,
			sms: { messages: [nearLimitBody, "Second staged body"] },
		});

		await deliverStagedNotifications({
			supabase: adminClient,
			logger,
			currentTime,
			sendEmail,
			getSmsSender: () => ({ sender: smsSender }),
		});

		const sentBodies = smsSender.mock.calls.map(([request]) => request.body);
		expect(sentBodies.length).toBeGreaterThan(2);
		expect(sentBodies.every((body) => body.length <= 1600)).toBe(true);
		expect(sentBodies[0]).toContain("Delayed");
		expect(sentBodies[1]).toBe(nearLimitBody);
		expect(sentBodies[2]).toBe("Second staged body");
	});
});
