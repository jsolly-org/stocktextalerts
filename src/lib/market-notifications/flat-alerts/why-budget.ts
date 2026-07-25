import { DateTime, type DateTime as DateTimeType } from "luxon";
import type { SupabaseAdminClient } from "../../db/supabase";
import type { Logger } from "../../logging";

/** Max successful price-move why Grok sends per rolling window (per user). */
export const PRICE_MOVE_WHY_MAX_SENDS_PER_WINDOW = 20;

/** Rolling window length for the price-move why budget. */
const PRICE_MOVE_WHY_WINDOW_HOURS = 24;

export type PriceMoveWhyBudgetFields = {
	price_move_why_window_start: string | null;
	price_move_why_sends_in_window: number;
};

/** Return whether a price-move why Grok call is allowed within the user's rolling limit. */
export function canInvokePriceMoveWhy(
	user: PriceMoveWhyBudgetFields,
	now: DateTimeType = DateTime.utc(),
): boolean {
	const windowStartIso = user.price_move_why_window_start;
	if (!windowStartIso) {
		return true;
	}
	const windowStart = DateTime.fromISO(windowStartIso, { zone: "utc" });
	if (!windowStart.isValid) {
		return true;
	}
	if (now.diff(windowStart, "hours").hours >= PRICE_MOVE_WHY_WINDOW_HOURS) {
		return true;
	}
	return user.price_move_why_sends_in_window < PRICE_MOVE_WHY_MAX_SENDS_PER_WINDOW;
}

/**
 * Persist price-move why usage after a successful delivery that included a why blurb.
 * Mirrors digest `updateGrokSendCounter` but only touches `price_move_why_*` columns.
 */
export async function updatePriceMoveWhySendCounter(
	supabase: SupabaseAdminClient,
	userId: string,
	user: PriceMoveWhyBudgetFields,
	now: DateTimeType,
	logger: Logger,
): Promise<void> {
	const nowIso = now.toISO();
	if (!nowIso) return;

	const windowStart = user.price_move_why_window_start
		? DateTime.fromISO(user.price_move_why_window_start, { zone: "utc" })
		: null;
	const windowExpired =
		!windowStart?.isValid || now.diff(windowStart, "hours").hours >= PRICE_MOVE_WHY_WINDOW_HOURS;

	const newCount = windowExpired ? 1 : user.price_move_why_sends_in_window + 1;
	const newWindowStart = windowExpired ? nowIso : user.price_move_why_window_start;

	user.price_move_why_sends_in_window = newCount;
	user.price_move_why_window_start = newWindowStart;

	const { error } = await supabase
		.from("users")
		.update({
			price_move_why_window_start: newWindowStart,
			price_move_why_sends_in_window: newCount,
		})
		.eq("id", userId);
	if (error) {
		logger.error(
			"Failed to update price-move why send counter",
			{ userId, newCount, newWindowStart },
			error,
		);
	}
}
