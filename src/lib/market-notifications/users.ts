import type { AlertMoveSize } from "../db";
import type { SupabaseAdminClient } from "../db/supabase";
import { rootLogger } from "../logging";
import { attachPrefsToUsers } from "../messaging/load-prefs";
import type { PrefRow } from "../messaging/notification-prefs";

export interface PriceAlertUser {
	id: string;
	email: string;
	phone_country_code: string | null;
	phone_number: string | null;
	phone_verified: boolean;
	sms_notifications_enabled: boolean;
	sms_opted_out: boolean;
	email_notifications_enabled: boolean;
	market_asset_price_alert_move_size: AlertMoveSize;
	use_24_hour_time: boolean;
	/** Linked Telegram chat (null when never linked); gates the Telegram delivery branch. */
	telegram_chat_id: number | null;
	/** True after a verified outbound 403 ("bot blocked"); suppresses Telegram delivery. */
	telegram_opted_out: boolean;
	/** Per-option channel preferences (single source of truth for all channels). */
	prefs: PrefRow[];
}

/**
 * Fetch users who have price alerts enabled and at least one usable channel.
 * The per-option `market_asset_price_alerts` facet now lives in
 * `notification_preferences` (checked at delivery time), so the candidate set is
 * gated by channel-level columns only; prefs are loaded in a batch.
 */
export async function fetchPriceAlertUsers(
	supabase: SupabaseAdminClient,
): Promise<PriceAlertUser[]> {
	const { data, error } = await (supabase
		.from("users")
		.select(
			"id, email, phone_country_code, phone_number, phone_verified, sms_notifications_enabled, sms_opted_out, email_notifications_enabled, market_asset_price_alert_move_size, use_24_hour_time, telegram_chat_id, telegram_opted_out",
		)
		.eq("market_asset_price_alerts_enabled", true)
		// Candidate pre-filter on channel-level columns only: usable email channel,
		// usable SMS channel (verified phone + opted in), or a linked Telegram chat.
		// The per-option market_asset_price_alerts facet is checked at delivery time.
		.or(
			"email_notifications_enabled.eq.true,and(sms_notifications_enabled.eq.true,phone_verified.eq.true),telegram_chat_id.not.is.null",
		) as unknown as Promise<{
		data: Omit<PriceAlertUser, "prefs">[] | null;
		error: unknown;
	}>);

	if (error) {
		rootLogger.error(
			"Failed to fetch price alert users",
			{ action: "fetch_price_alert_users" },
			error,
		);
		return [];
	}

	return attachPrefsToUsers(supabase, data ?? []);
}

/**
 * Atomically reserve per-symbol eligibility for the current US trading day.
 * Blocks overlapping cron ticks until delivery finalizes or the reservation is released.
 */
export async function reserveCooldownSlot(
	supabase: SupabaseAdminClient,
	userId: string,
	symbol: string,
	absMovePercent: number,
	absMoveDollar: number,
): Promise<boolean> {
	const { data: reserved, error } = await (
		supabase as unknown as {
			rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>;
		}
	).rpc("reserve_market_asset_price_alert_slot", {
		p_user_id: userId,
		p_symbol: symbol,
		p_abs_move_percent: absMovePercent,
		p_abs_move_dollar: absMoveDollar,
	});

	if (error) {
		rootLogger.error("Failed to reserve price alert trading-day slot", { userId, symbol }, error);
		return false;
	}

	return Boolean(reserved);
}

export async function finalizeCooldownSlot(
	supabase: SupabaseAdminClient,
	userId: string,
	symbol: string,
): Promise<void> {
	const { error } = await (
		supabase as unknown as {
			rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>;
		}
	).rpc("finalize_market_asset_price_alert_slot", {
		p_user_id: userId,
		p_symbol: symbol,
	});

	if (error) {
		rootLogger.error("Failed to finalize price alert trading-day slot", { userId, symbol }, error);
	}
}

export async function releaseCooldownSlot(
	supabase: SupabaseAdminClient,
	userId: string,
	symbol: string,
): Promise<void> {
	const { error } = await (
		supabase as unknown as {
			rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>;
		}
	).rpc("release_market_asset_price_alert_slot", {
		p_user_id: userId,
		p_symbol: symbol,
	});

	if (error) {
		rootLogger.error("Failed to release price alert trading-day slot", { userId, symbol }, error);
	}
}
