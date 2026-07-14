/**
 * Unit-level coverage for scheduled-channel budget terminal-skip behavior.
 * Mocks claim + budget RPCs; asserts a denied budget marks the slot `sent`
 * (no minute-spin) and does not treat the channel as a send failure.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseAdminClient } from "../../../src/lib/db/supabase";
import type { Logger } from "../../../src/lib/logging";
import {
	reserveScheduledChannelBudget,
	scheduledTypeToBudgetKind,
} from "../../../src/lib/messaging/scheduled-channel";
import type { ScheduledNotificationTotals } from "../../../src/lib/scheduled-notifications/types";
import { assertIsoDateString } from "../../../src/lib/types";
import { minuteOfDay } from "../../helpers/minute-of-day";

vi.mock("../../../src/lib/notification-budget", () => ({
	consumeNotificationBudget: vi.fn(),
	releaseNotificationBudget: vi.fn(),
}));

vi.mock("../../../src/lib/scheduled-notifications/store", () => ({
	claimNotification: vi.fn(),
	updateScheduledNotificationRow: vi.fn(async () => undefined),
}));

vi.mock("../../../src/lib/messaging/shared", () => ({
	deliveryResultToLogFields: vi.fn(() => ({})),
	recordNotification: vi.fn(async () => true),
}));

import { recordNotification } from "../../../src/lib/messaging/shared";
import { consumeNotificationBudget } from "../../../src/lib/notification-budget";
import { updateScheduledNotificationRow } from "../../../src/lib/scheduled-notifications/store";

const consumeMock = vi.mocked(consumeNotificationBudget);
const updateRowMock = vi.mocked(updateScheduledNotificationRow);
const recordMock = vi.mocked(recordNotification);

function makeLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	};
}

function makeStats(): ScheduledNotificationTotals {
	return {
		emailsSent: 0,
		emailsFailed: 0,
		telegramSent: 0,
		telegramFailed: 0,
		logFailures: 0,
		skipped: 0,
	};
}

describe("scheduledTypeToBudgetKind", () => {
	it("maps market / daily / asset_events", () => {
		expect(scheduledTypeToBudgetKind("market")).toBe("market_scheduled_asset_price");
		expect(scheduledTypeToBudgetKind("daily")).toBe("daily_notification");
		expect(scheduledTypeToBudgetKind("asset_events")).toBe("daily_notification");
	});
});

describe("reserveScheduledChannelBudget", () => {
	it("returns true when consume succeeds", async () => {
		consumeMock.mockResolvedValueOnce({ status: "reserved" });
		const stats = makeStats();
		const ok = await reserveScheduledChannelBudget({
			supabase: {} as SupabaseAdminClient,
			userId: "user-1",
			notificationType: "daily",
			scheduledDate: assertIsoDateString("2026-07-14"),
			scheduledMinutes: minuteOfDay(480),
			channel: "email",
			logger: makeLogger(),
			stats,
			attemptCount: 1,
		});
		expect(ok).toBe(true);
		expect(stats.skipped).toBe(0);
		expect(updateRowMock).not.toHaveBeenCalled();
	});

	it("terminal-skips the claimed slot when budget is exhausted", async () => {
		consumeMock.mockResolvedValueOnce({ status: "denied" });
		const stats = makeStats();
		const logger = makeLogger();
		const ok = await reserveScheduledChannelBudget({
			supabase: {} as SupabaseAdminClient,
			userId: "user-1",
			notificationType: "market",
			scheduledDate: assertIsoDateString("2026-07-14"),
			scheduledMinutes: minuteOfDay(600),
			channel: "telegram",
			logger,
			stats,
			attemptCount: 1,
		});
		expect(ok).toBe(false);
		expect(stats.skipped).toBe(1);
		expect(stats.emailsFailed + stats.telegramFailed).toBe(0);
		expect(recordMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				message_delivered: false,
				error: "notification_budget_exhausted",
			}),
		);
		expect(updateRowMock).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "sent",
				channel: "telegram",
				notificationType: "market",
			}),
		);
		expect(logger.info).toHaveBeenCalledWith(
			"Scheduled notification skipped: notification budget exhausted",
			expect.objectContaining({ userId: "user-1" }),
		);
	});

	it("marks the slot failed (retryable) when the budget check errors", async () => {
		consumeMock.mockResolvedValueOnce({ status: "error" });
		const stats = makeStats();
		const logger = makeLogger();
		const ok = await reserveScheduledChannelBudget({
			supabase: {} as SupabaseAdminClient,
			userId: "user-1",
			notificationType: "daily",
			scheduledDate: assertIsoDateString("2026-07-14"),
			scheduledMinutes: minuteOfDay(480),
			channel: "email",
			logger,
			stats,
			attemptCount: 1,
		});
		expect(ok).toBe(false);
		expect(stats.skipped).toBe(0);
		expect(stats.emailsFailed).toBe(1);
		expect(updateRowMock).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "failed",
				error: "notification_budget_check_failed",
			}),
		);
		expect(logger.error).toHaveBeenCalledWith(
			"Scheduled notification deferred: notification budget check failed",
			expect.objectContaining({ userId: "user-1" }),
			expect.any(Error),
		);
	});
});
