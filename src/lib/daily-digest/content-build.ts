import { DateTime, type DateTime as DateTimeType } from "luxon";
import { readDailyNotificationNextSendAt } from "../daily-notification/schedule";
import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { fetchTopMovers, type TopMover } from "../market-data/movers";
import { formatSignedChangePercent, formatUsdPrice } from "../messaging/parts/asset-price-list";
import type { ScheduledNotificationTotals } from "../scheduled-notifications/types";
import { getLocalMinutesFromDateTime } from "../time/schedule/next-send";
import type { UserRecord } from "../types";
import {
	assertIsoDateString,
	type IsoDateString,
	type MinuteOfDay,
	type ScheduledSlotKey,
} from "../types";
import { withOptionalVendorBudget } from "../vendors/optional-vendors";

const GROK_WINDOW_HOURS = 24;
const GROK_MAX_SENDS_PER_WINDOW = 10;

function formatMoverLine(mover: TopMover): string {
	return `${mover.ticker} — ${formatUsdPrice(mover.price)} (${formatSignedChangePercent(mover.changePercent)})`;
}

/**
 * Fetch market-wide top gainers/losers and format them as a single email
 * section body. Returns `null` when both lists are empty (upstream failure
 * or all tickers filtered out) — callers skip the section in that case.
 */
export async function buildTopMoversSection(): Promise<string | null> {
	const moversResult = await withOptionalVendorBudget("top-movers", 10_000, async () => {
		const [gainers, losers] = await Promise.all([
			fetchTopMovers("gainers", { optional: true }),
			fetchTopMovers("losers", { optional: true }),
		]);
		return { gainers, losers };
	});
	if (moversResult.status !== "ok") {
		return null;
	}
	const { gainers, losers } = moversResult.value;
	const lines: string[] = [];
	if (gainers.length > 0) {
		lines.push("Gainers:");
		for (const m of gainers) lines.push(formatMoverLine(m));
	}
	if (losers.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("Losers:");
		for (const m of losers) lines.push(formatMoverLine(m));
	}
	return lines.length > 0 ? lines.join("\n") : null;
}

/** Return whether Grok is allowed within the user's rolling window limit. */
function canInvokeGrokWithinLimit(options: {
	grokWindowStart: string | null;
	grokSendsInWindow: number;
	currentTimeUtc: DateTimeType;
}): boolean {
	const { grokWindowStart, grokSendsInWindow, currentTimeUtc } = options;
	if (!grokWindowStart) {
		return true;
	}
	const windowStart = DateTime.fromISO(grokWindowStart, { zone: "utc" });
	if (!windowStart.isValid) {
		return true;
	}
	if (currentTimeUtc.diff(windowStart, "hours").hours >= GROK_WINDOW_HOURS) {
		return true;
	}
	return grokSendsInWindow < GROK_MAX_SENDS_PER_WINDOW;
}

interface DailyScheduleContext extends ScheduledSlotKey {}

/** Derive the (scheduledDate, scheduledMinutes) key for daily digest delivery. */
export function parseDailyScheduleContext(
	user: UserRecord,
	currentTime: DateTimeType,
	logger: Logger,
): DailyScheduleContext | null {
	const nextSendAtIso = readDailyNotificationNextSendAt(user);
	const dueAt = nextSendAtIso ? DateTime.fromISO(nextSendAtIso, { zone: "utc" }) : currentTime;
	if (!dueAt.isValid) {
		logger.error(
			"Invalid daily_notification_next_send_at timestamp",
			{
				userId: user.id,
				daily_notification_next_send_at: nextSendAtIso,
			},
			new Error("Invalid daily_notification_next_send_at timestamp"),
		);
		return null;
	}
	const dueAtLocal = dueAt.setZone(user.timezone);
	if (!dueAtLocal.isValid) {
		logger.error(
			"Failed to format local date for timezone (daily)",
			{ userId: user.id, timezone: user.timezone },
			new Error("Failed to format local date for timezone"),
		);
		return null;
	}
	const scheduledDate = dueAtLocal.toISODate();
	if (!scheduledDate) {
		logger.error(
			"Failed to format scheduled date (daily)",
			{
				userId: user.id,
				timezone: user.timezone,
				daily_notification_next_send_at: nextSendAtIso,
			},
			new Error("Failed to format scheduled date"),
		);
		return null;
	}
	const scheduledMinutes = getLocalMinutesFromDateTime(user.timezone, dueAt);
	if (scheduledMinutes === null) {
		logger.error(
			"Failed to calculate scheduled minutes (daily)",
			{
				action: "daily_run",
				userId: user.id,
				timezone: user.timezone,
				daily_notification_next_send_at: nextSendAtIso,
				scheduledDate,
			},
			new Error("Failed to calculate scheduled minutes"),
		);
		return null;
	}
	return {
		scheduledDate: assertIsoDateString(scheduledDate),
		scheduledMinutes,
	};
}

/** Resolve whether Grok can be used for this digest run. */
export function resolveGrokEligibility(
	user: UserRecord,
	needsGrok: boolean,
	currentTimeUtc: DateTimeType,
	logger: Logger,
	scheduledDate: IsoDateString,
	scheduledMinutes: MinuteOfDay,
): { grokAllowed: boolean } {
	const grokAllowed =
		needsGrok &&
		canInvokeGrokWithinLimit({
			grokWindowStart: user.grok_window_start,
			grokSendsInWindow: user.grok_sends_in_window,
			currentTimeUtc,
		});

	if (needsGrok && !grokAllowed) {
		logger.info(
			"Grok send limit reached for this window; digest will proceed without news/rumors",
			{
				action: "daily_run",
				reason: "grok_limit",
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
				grokSendsInWindow: user.grok_sends_in_window,
			},
		);
	}

	return { grokAllowed };
}

/** Persist Grok usage counters after at least one successful delivery. */
export async function updateGrokSendCounter(
	user: UserRecord,
	supabase: SupabaseAdminClient,
	grokAllowed: boolean,
	stats: ScheduledNotificationTotals,
	currentTime: DateTimeType,
	logger: Logger,
): Promise<void> {
	if (!grokAllowed || (stats.emailsSent === 0 && stats.smsSent === 0 && stats.telegramSent === 0)) {
		return;
	}

	const now = currentTime.toISO();
	if (!now) return;

	const windowStart = user.grok_window_start
		? DateTime.fromISO(user.grok_window_start, { zone: "utc" })
		: null;
	const windowExpired =
		!windowStart?.isValid || currentTime.diff(windowStart, "hours").hours >= GROK_WINDOW_HOURS;

	const newCount = windowExpired ? 1 : user.grok_sends_in_window + 1;
	const newWindowStart = windowExpired ? now : user.grok_window_start;

	user.grok_sends_in_window = newCount;
	user.grok_window_start = newWindowStart;
	user.last_grok_rumors_at = now;

	const { error } = await supabase
		.from("users")
		.update({
			last_grok_rumors_at: now,
			grok_window_start: newWindowStart,
			grok_sends_in_window: newCount,
		})
		.eq("id", user.id);
	if (error) {
		logger.error(
			"Failed to update grok send counter (daily)",
			{ userId: user.id, newCount, newWindowStart },
			error,
		);
	}
}
