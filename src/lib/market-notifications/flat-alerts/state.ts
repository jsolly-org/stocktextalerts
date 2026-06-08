import { rootLogger } from "../../logging";
import type { SupabaseAdminClient } from "../../schedule/helpers";

/** Row from price_move_alert_state — the per-(user, symbol) flat-alert state. */
interface FlatPriceAlertStateRow {
	userId: string;
	symbol: string;
	lastNotificationPrice: number;
	lastNotificationAt: Date;
}

/** Key used to index state rows in memory during a run. */
export function stateKey(userId: string, symbol: string): string {
	return `${userId}:${symbol}`;
}

/**
 * Batch-fetch state rows for a set of users. Returns a map keyed by
 * `${userId}:${symbol}`. Rows for (user, symbol) pairs with no entry in the
 * table are simply absent from the map.
 *
 * Throws on DB error. Silent degradation would be dangerous here: an empty
 * map is indistinguishable from "no state rows yet", which would cause
 * re-triggerable users to get classified as first-of-day and receive an
 * alert with the wrong baseline + wrong subject line. Better to abort the
 * run and retry on the next cron tick.
 */
export async function fetchFlatPriceAlertState(
	supabase: SupabaseAdminClient,
	userIds: string[],
): Promise<Map<string, FlatPriceAlertStateRow>> {
	const result = new Map<string, FlatPriceAlertStateRow>();
	if (userIds.length === 0) return result;

	const { data, error } = await supabase
		.from("price_move_alert_state")
		.select("user_id, symbol, last_notification_price, last_notification_at")
		.in("user_id", userIds);

	if (error) {
		rootLogger.error(
			"Failed to fetch flat price alert state",
			{ userCount: userIds.length },
			error,
		);
		throw new Error(`fetchFlatPriceAlertState failed: ${error.message}`);
	}

	for (const row of data ?? []) {
		result.set(stateKey(row.user_id, row.symbol), {
			userId: row.user_id,
			symbol: row.symbol,
			lastNotificationPrice: Number(row.last_notification_price),
			lastNotificationAt: new Date(row.last_notification_at),
		});
	}

	return result;
}

/**
 * Atomically claim an alert slot. Returns `true` when the alert should be
 * delivered, `false` otherwise (sub-threshold, race lost, or validation fail).
 *
 * The RPC takes the caller-computed baseline as an optimistic lock: if the
 * row's current `last_notification_price` no longer matches on re-trigger,
 * another cron tick already updated it and we back off.
 *
 * On unexpected errors, fails closed. If the delivery-state RPC is unavailable,
 * sending would bypass idempotency and can duplicate SMS on every cron tick.
 */
export async function reserveFlatPriceAlert(
	supabase: SupabaseAdminClient,
	options: {
		userId: string;
		symbol: string;
		baselinePrice: number;
		newPrice: number;
		thresholdPercent: number;
	},
): Promise<boolean> {
	const { userId, symbol, baselinePrice, newPrice, thresholdPercent } = options;

	const { data: reserved, error } = await (
		supabase as unknown as {
			rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>;
		}
	).rpc("reserve_flat_price_alert", {
		p_user_id: userId,
		p_symbol: symbol,
		p_baseline_price: baselinePrice,
		p_new_price: newPrice,
		p_threshold_percent: thresholdPercent,
	});

	if (error) {
		rootLogger.error("Failed to reserve flat price alert slot", { userId, symbol }, error);
		return false;
	}

	return Boolean(reserved);
}

export async function finalizeFlatPriceAlert(
	supabase: SupabaseAdminClient,
	userId: string,
	symbol: string,
): Promise<void> {
	const { error } = await (
		supabase as unknown as {
			rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>;
		}
	).rpc("finalize_flat_price_alert", {
		p_user_id: userId,
		p_symbol: symbol,
	});

	if (error) {
		rootLogger.error("Failed to finalize flat price alert slot", { userId, symbol }, error);
	}
}

export async function releaseFlatPriceAlert(
	supabase: SupabaseAdminClient,
	userId: string,
	symbol: string,
): Promise<void> {
	const { error } = await (
		supabase as unknown as {
			rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>;
		}
	).rpc("release_flat_price_alert", {
		p_user_id: userId,
		p_symbol: symbol,
	});

	if (error) {
		rootLogger.error("Failed to release flat price alert slot", { userId, symbol }, error);
	}
}
