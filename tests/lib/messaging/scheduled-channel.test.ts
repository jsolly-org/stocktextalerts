/**
 * Tests for resolveScheduledSender — the shared sender-resolution failure path
 * extracted from the six SMS/Telegram scheduled-delivery blocks. The failure
 * branch (factory throw → channel-failure stat, error log, failed row, null)
 * had no coverage while hand-rolled, so this pins the behavior the extraction
 * preserved: no notification_log row is written for a sender that never
 * initialized — only the scheduled_notifications row is marked failed.
 */

import { describe, expect, it } from "vitest";
import { rootLogger } from "../../../src/lib/logging";
import { resolveScheduledSender } from "../../../src/lib/messaging/scheduled-channel";
import type { ScheduledNotificationTotals } from "../../../src/lib/scheduled-notifications/types";
import { assertIsoDateString } from "../../../src/lib/types";
import { minuteOfDay } from "../../helpers/minute-of-day";
import { expectConsoleError } from "../../setup";

function emptyTotals(): ScheduledNotificationTotals {
	return {
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
		telegramSent: 0,
		telegramFailed: 0,
		logFailures: 0,
		skipped: 0,
	};
}

/** Thenable update-chain double capturing scheduled_notifications update payloads. */
function supabaseDouble() {
	const updates: Record<string, unknown>[] = [];
	const chain = {
		eq: () => chain,
		// biome-ignore lint/suspicious/noThenProperty: mirrors the thenable Supabase query builder the helper awaits
		then: (resolve: (value: { error: null }) => void) => resolve({ error: null }),
	};
	const supabase = {
		from: () => ({
			update: (payload: Record<string, unknown>) => {
				updates.push(payload);
				return chain;
			},
		}),
	} as never;
	return { supabase, updates };
}

const slot = {
	userId: "00000000-0000-0000-0000-000000000001",
	notificationType: "daily" as const,
	scheduledDate: assertIsoDateString("2026-06-24"),
	scheduledMinutes: minuteOfDay(540),
	logger: rootLogger,
	attemptCount: 1,
};

describe("resolveScheduledSender", () => {
	it("returns the factory result untouched and records nothing on success", async () => {
		const { supabase, updates } = supabaseDouble();
		const stats = emptyTotals();
		const sender = { sender: () => Promise.resolve({ success: true }) };

		const resolved = await resolveScheduledSender({
			...slot,
			supabase,
			channel: "sms",
			stats,
			getSender: () => sender,
			logMessage: "Failed to resolve SMS sender for daily digest",
		});

		expect(resolved).toBe(sender);
		expect(stats).toEqual(emptyTotals());
		expect(updates).toEqual([]);
	});

	it("bumps the channel failure stat, logs, and marks the row failed when the factory throws", async () => {
		expectConsoleError("Failed to resolve SMS sender for daily digest");
		const { supabase, updates } = supabaseDouble();
		const stats = emptyTotals();

		const resolved = await resolveScheduledSender({
			...slot,
			supabase,
			channel: "sms",
			stats,
			getSender: () => {
				throw new Error("Twilio config missing");
			},
			logMessage: "Failed to resolve SMS sender for daily digest",
		});

		expect(resolved).toBeNull();
		expect(stats).toEqual({ ...emptyTotals(), smsFailed: 1 });
		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({
			status: "failed",
			error: "Twilio config missing",
		});
	});

	it("routes the failure stat by channel (telegram)", async () => {
		expectConsoleError("Failed to resolve Telegram sender for daily digest");
		const { supabase } = supabaseDouble();
		const stats = emptyTotals();

		const resolved = await resolveScheduledSender({
			...slot,
			supabase,
			channel: "telegram",
			stats,
			getSender: () => {
				throw new Error("bot token missing");
			},
			logMessage: "Failed to resolve Telegram sender for daily digest",
		});

		expect(resolved).toBeNull();
		expect(stats).toEqual({ ...emptyTotals(), telegramFailed: 1 });
	});
});
